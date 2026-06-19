# API Reference

All routes are JSON over HTTP. Base URL is `CP_BASE_URL` (default `http://localhost:4000`).

For the machine-readable spec see [`../openapi.yaml`](../openapi.yaml). For the
event payloads these endpoints emit and ingest, see [`events.md`](events.md);
for the tables they read and write, see [`data-model.md`](data-model.md).

This reference covers the **control-plane API**. Protocol artifacts these
endpoints carry (manifests, TCTs, the handshake) are defined by the
[AITP RFCs](https://agentidentitytrustprotocol.io/spec) — these docs link to the
spec rather than restate it.

## Conventions

- **Content type:** `application/json` on POST/PATCH.
- **Request ID:** Every response carries `x-request-id`. Clients may pre-set the header; the CP echoes it.
- **CORS:** `Access-Control-Allow-Origin` is set to `CORS_ORIGIN` (defaults to `http://localhost:3000`). Applied per-request by the middleware, so it reads from the runtime environment — set it to the UI console's origin. A single origin is supported.
- **Filter key casing:** List filters are accepted in **both** camelCase and snake_case where noted (e.g. `runId` or `run_id`). The playground emits snake_case; UI clients tend to use camelCase. Both resolve to the same column.
- **Error shape:**
  ```json
  { "error": "human message", "code": "MACHINE_CODE" }
  ```
  HTTP status codes are conventional: `400` (bad body/filter), `401` (auth), `404` (not found), `409` (conflict), `413` (payload too large), `429` (rate limited), `503` (misconfigured / draining). DELETEs on trust-anchors and pinned-keys return `204 No Content`.

## Authentication

| Surface | Auth |
|---|---|
| Public discovery (health, readyz, metrics, well-known, registry GET) | none |
| `POST /api/registry/enroll` | none — caller submits its own **signed manifest**; the CP verifies the signature and issues a one-time token |
| `POST /api/registry/agents` | `Authorization: Bearer <enrollment-token>` (the token returned by `/enroll`, single-use) |
| All other gated routes | `Authorization: Bearer <API_KEY>` from the `API_KEYS` allowlist |

`ENROLLMENT_SECRET` is the **server-side** HMAC key the CP uses to mint and verify enrollment tokens. Callers never present it directly.

In production, an empty `API_KEYS` causes gated routes to return `503 SERVER_MISCONFIGURED` — fail-safe against accidental exposure. In non-production, an empty `API_KEYS` disables auth on gated routes (a boot-time warning is logged).

## Rate limiting

Every `/api/*` route except `/api/health`, `/api/readyz`, and `/api/metrics` is rate-limited per process (in-memory buckets). Over-limit requests return:

```
HTTP 429
{ "error": "rate limit exceeded", "code": "RATE_LIMITED", "bucket": "<bucket>" }
```

with headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining: 0`, and `X-RateLimit-Reset` (epoch seconds). Buckets: `enroll-ip` (strict, per-IP, default 5/min), `public-ip` (per-IP, default 60/min), `api-key` (per-key, default 600/min). See [`operations.md`](operations.md#rate-limiting) for tuning and the `CLIENT_IP_HEADER` / `TRUSTED_PROXY_HOPS` trust model.

## Idempotency

These mutating endpoints honor an optional `Idempotency-Key` request header — replaying the same `(endpoint, key)` returns the original status and body instead of re-running the side effect:

`POST /api/registry/agents`, `POST /api/events`, `POST /api/webhooks`, `POST /api/trust-anchors`, `POST /api/pinned-keys`, `POST /api/revocation/entries`.

Cached responses are retained for `IDEMPOTENCY_KEY_TTL_DAYS` (default 7). An empty, over-long, or control-character key is rejected `400`.

## Routes

### Health & readiness

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | public | Liveness + DB ping. Stays `200` during a SIGTERM drain. |
| GET | `/api/readyz` | public | Readiness (DB reachable, identity initialized). `503` once draining. |
| GET | `/api/metrics` | public | Prometheus text format |

### Discovery

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/.well-known/aitp-manifest` | public | CP's own AITP manifest (Ed25519). Rewritten to `/api/well-known/aitp-manifest`. |
| GET | `/.well-known/aitp-revocation-list` | public | Signed revocation snapshot ([RFC-AITP-0008](https://agentidentitytrustprotocol.io/spec/revocation)). Rewritten to `/api/well-known/aitp-revocation-list`. |

### Registry

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/registry/enroll` | public | Verify a signed manifest, issue a one-time enrollment token |
| GET | `/api/registry/agents` | public | Discover agents |
| POST | `/api/registry/agents` | enrollment token | Self-register an agent |
| GET | `/api/registry/agents/:aid` | public | Fetch one agent |
| GET | `/api/registry/agents/:aid/manifest` | public | Fetch the cached signed manifest (raw JSON) |
| GET | `/api/registry/agents/:aid/export` | API key | Bundle agent + sessions + TCTs + recent events |
| DELETE | `/api/registry/agents/:aid` | API key | Deregister |

#### `POST /api/registry/enroll`

Body is a **ManifestEnvelope** — the agent's own signed manifest:

```json
{
  "manifest": {
    "aid": "did:pubkey:z:...",
    "display_name": "researcher-1",
    "handshake_endpoint": "http://agent-host:8101/aitp",
    "offered_capabilities": ["demo.echo"],
    "expires_at": 1790000000,
    "extensions": { "namespace": "default" }
  }
}
```

The CP verifies the manifest signature against the AID's key and returns a single-use enrollment token. Errors: `400 MANIFEST_INVALID` (missing/unverifiable manifest), `400 BODY_INVALID` (not JSON).

> The `ManifestEnvelope` shape and its signature/verification are defined by the protocol — [RFC-AITP-0003 (Agent Manifest)](https://agentidentitytrustprotocol.io/spec/manifest) and [RFC-AITP-0007 (Key Resolution)](https://agentidentitytrustprotocol.io/spec/key-resolution). The CP caches and serves the manifest; it does not define the format. Use the [`aitp`](https://www.npmjs.com/package/@agentidentitytrustprotocol/aitp) SDK to build and sign one.

#### `POST /api/registry/agents`

Pass the enrollment token in `Authorization: Bearer <token>`. The body is the **same ManifestEnvelope** posted to `/enroll` (the CP stores the raw bytes as the cached manifest):

```json
{
  "manifest": {
    "aid": "did:pubkey:z:...",
    "display_name": "researcher-1",
    "handshake_endpoint": "http://agent-host:8101/aitp",
    "offered_capabilities": ["demo.echo"],
    "expires_at": 1790000000,
    "extensions": { "namespace": "default" }
  }
}
```

- `expires_at` is **Unix seconds**. It must be ≥ 5 minutes in the future or you get `400 MANIFEST_EXPIRED`.
- **Namespace** is taken from the `X-Aitp-Namespace` header (wins) or `manifest.extensions.namespace`, defaulting to `default`.
- The token is consumed atomically; a second presentation returns `401 TOKEN_REPLAYED`. An invalid/expired token or AID mismatch returns `401 TOKEN_INVALID`.

Response `201`: `{ "aid": "...", "displayName": "...", "registeredAt": "..." }`. Emits an `agent.registered` audit event.

#### `GET /api/registry/agents`

Filters: `?capability=`, `?aid=`, `?displayName=` (or `display_name`), `?namespace=`, `?include_manifest=true`, `?limit=` (default 200, max 1000), `?offset=`.

> Without `?namespace=`, results span **all** namespaces by design. Namespaces are a control-plane scoping convention, not a protocol boundary — initial peer discovery is [operational and non-normative](https://agentidentitytrustprotocol.io/docs/discovery) in AITP. The CP enforces no implicit tenant isolation, so scope your queries with `?namespace=` if you need it.

Each record:

```json
{
  "aid": "did:pubkey:z:...",
  "displayName": "researcher-1",
  "handshakeEndpoint": "http://agent-host:8101/aitp",
  "offeredCaps": ["demo.echo"],
  "status": "active",
  "namespace": "default",
  "registeredAt": "...",
  "lastEnrolledAt": "...",
  "lastSeenAt": "...",
  "manifestUrl": "/api/registry/agents/<aid>/manifest",
  "agentManifestHint": "http://agent-host:8101/.well-known/aitp-manifest",
  "manifestJson": "{...}"
}
```

`manifestUrl` is the CP's always-available cached copy. `agentManifestHint` is a best-effort guess at the agent's own `.well-known` URL (may 404 behind a gateway). `manifestJson` is present only when `include_manifest=true`.

### Sessions

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/sessions` | API key | List handshake sessions. Filters: `?status=`, `?runId=` (or `run_id`), `?aid=` |
| GET | `/api/sessions/:sessionId` | API key | Fetch one session + its events |
| GET | `/api/sessions/:sessionId/export` | API key | Bundle session + projected TCTs + events. `?format=json\|jsonl` |
| GET | `/api/sessions/:sessionId/replay` | API key | Ordered event stream for one session. Filters: `?since=`, `?until=`, `?limit=`. Malformed `since`/`until` → `400 BAD_REQUEST`. |

Sessions are **projected from events** — the CP does not see handshake traffic. See [`events.md`](events.md#sessions-projection).

### Events

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/events` | API key (open in dev) | Ingest a batch of audit events |
| GET | `/api/events/history` | API key | Query persisted events. Filters: `?type=`, `?aid=`, `?sessionId=` (or `session_id`), `?runId=` (or `run_id`), `?since=`, `?until=`, `?limit=`, `?offset=` |
| GET | `/api/events/stream` | API key | Server-Sent Events (live + backlog). Filters: `?type=`, `?runId=` (or `run_id`), `?aid=` |

#### `POST /api/events` body

Accepts either a bare array or `{ "events": [...] }`. Each event:

```json
{
  "type": "handshake.complete",
  "ts": "2026-05-25T12:00:00Z",
  "aidA": "did:pubkey:z:...",
  "aidB": "did:pubkey:z:...",
  "sessionId": "uuid-or-base64url",
  "runId": "run-123",
  "grants": ["demo.echo"],
  "payload": { "...": "..." },
  "source": "playground"
}
```

`aid_a` / `aid_b` / `session_id` / `run_id` snake_case keys are also accepted (the playground emits snake_case). Unknown event types are stored as-is (never `4xx`); only a known set drives projections and webhooks — see [`events.md`](events.md).

Response `200`: `{ "ingested": <n> }`.

Limits: a single batch must be ≤ 256 KiB on the wire and each event's `payload` ≤ 64 KiB. Over-cap requests return `413 PAYLOAD_TOO_LARGE` (the offending `eventType` is included when a single event is too big). Split large batches into multiple requests.

#### `GET /api/events/stream`

`text/event-stream`; each event is delivered as a `data: <json>\n\n` frame, replaying the in-memory backlog (`MAX_AUDIT_EVENTS_MEMORY`) then streaming live. Returns `503 SSE_CAPACITY` once `MAX_SSE_CONNECTIONS` (default 500) streams are already open — back off and retry.

### Audit

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/audit` | API key | Admin audit log (who did what when). Filters: `?limit=`, `?offset=` |

This is the **admin action** log (registrations, revocations, webhook changes), distinct from the telemetry event store served by `/api/events/history`.

### Revocation

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/revocation/entries` | API key | Add a JTI to the revocation list |

```json
{ "jti": "uuid", "reason": "operator action", "revokedAt": "2026-06-01T00:00:00Z" }
```

`jti` must be a UUID; `reason` ≤ 500 chars; `revokedAt` is optional ISO-8601 (defaults to now). Invalid input → `400 JTI_INVALID` / `400 BODY_INVALID`. Recording a revocation also flips the matching `issuedTcts.revoked` flag and cascades to descendant delegations. The signed list at `/.well-known/aitp-revocation-list` refreshes every `REVOCATION_LIST_TTL_SECS` seconds.

### Webhooks

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/webhooks` | API key | List subscriptions |
| POST | `/api/webhooks` | API key | Create |
| PATCH | `/api/webhooks/:id` | API key | Update |
| DELETE | `/api/webhooks/:id` | API key | Remove |
| GET | `/api/webhooks/:id/circuit-breaker` | API key | Current breaker state snapshot |
| POST | `/api/webhooks/:id/circuit-breaker/reset` | API key | Manually re-arm a breaker stuck open |

#### `POST /api/webhooks` body

```json
{ "url": "https://hooks.example.com/aitp", "events": ["tct.revoked"], "secret": "shared-secret", "active": true }
```

`url` must be `http(s)` and pass the SSRF guard (private/loopback/link-local ranges and hosts outside `WEBHOOK_URL_ALLOWLIST` are rejected `400 URL_NOT_ALLOWED`). An empty/omitted `events` array means **all deliverable event types**. Only a fixed set of event types is deliverable — see [`events.md`](events.md#webhook-deliverable-events).

Deliveries are POSTed with header `X-AITP-Signature: sha256=<hex>` — an HMAC-SHA256 over the canonical body bytes using the webhook's `secret`. Retries follow `WEBHOOK_RETRY_ATTEMPTS` (default 3) with exponential backoff; a circuit breaker trips a repeatedly-failing endpoint open.

### Dashboard JSON

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/dashboard/overview` | API key | Aggregate counts + recent activity. `?range=1h\|24h\|7d\|30d` (default `24h`) |
| GET | `/api/dashboard/agents` | API key | Per-agent metrics |

### TCTs (observed)

The CP **observes** TCTs from agent-reported `tct.issued` and `handshake.complete` events. It never issues a TCT.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/tcts` | API key | Query observed TCTs. Filters: `?issuer=`, `?subject=`, `?audience=`, `?capability=`, `?sessionId=`, `?active=true`, `?limit=`, `?offset=` |

### Delegation chains

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/delegations` | API key | Query delegations |

`?root_jti=<uuid>` (or `rootJti`) walks the descendant tree via a recursive CTE. Other filters: `?parent_jti=` (or `parentJti`), `?delegator=`, `?delegatee=`, `?active=true`, `?limit=`, `?offset=`. A malformed `root_jti`/`parent_jti` (not a UUID) returns `400 BAD_REQUEST`.

### Trust anchors (OIDC)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/trust-anchors` | API key | List. `?namespace=` filter |
| POST | `/api/trust-anchors` | API key | Create. Body: `{ issuerUrl, namespace?, jwksUrl?, label? }`. `409 ALREADY_EXISTS` if `(namespace, issuerUrl)` exists. |
| GET | `/api/trust-anchors/:id` | API key | Fetch one |
| PATCH | `/api/trust-anchors/:id` | API key | Update `issuerUrl` / `jwksUrl` / `label` |
| DELETE | `/api/trust-anchors/:id` | API key | Remove (`204`) |

### Pinned keys

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/pinned-keys` | API key | List. `?namespace=` filter, or `?aid=&namespace=` for a single-row lookup |
| POST | `/api/pinned-keys` | API key | Upsert. Body: `{ aid, pubkey, namespace?, label?, expiresAt? }` |
| DELETE | `/api/pinned-keys?namespace=&aid=` | API key | Remove (`204`). Missing `aid` → `400 BAD_REQUEST`. |

## Headers

| Header | Direction | Purpose |
|---|---|---|
| `Authorization` | request | `Bearer <api-key>` (gated routes) or `Bearer <enrollment-token>` (`POST /api/registry/agents`) |
| `Idempotency-Key` | request | Dedupe a retried mutation (see [Idempotency](#idempotency)) |
| `X-Aitp-Namespace` | request | Tenant scope override on enrollment |
| `x-request-id` | both | Propagated for log correlation |
| `Retry-After`, `X-RateLimit-*` | response | Present on `429` responses |
| `X-AITP-Signature` | response (webhook delivery) | `sha256=<hex>` HMAC of body bytes |

## Lifecycle

- `GET /api/readyz` returns `503` with `{ "ready": false, "reason": "shutting_down" }` once the process has received SIGTERM, so a load balancer can drain the pod before it exits. `GET /api/health` continues to return `200` during the drain window. See [`operations.md`](operations.md#graceful-shutdown).
