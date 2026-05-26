# API Reference

All routes are JSON over HTTP. Base URL is `CP_BASE_URL` (default `http://localhost:4000`).

For the machine-readable spec see [`../openapi.yaml`](../openapi.yaml).

## Conventions

- **Content type:** `application/json` on POST/PATCH.
- **Request ID:** Every response carries `x-request-id`. Clients may pre-set the header; the CP echoes it.
- **CORS:** `Access-Control-Allow-Origin` is set to `CORS_ORIGIN` (defaults to `*` with a warning in non-prod).
- **Error shape:**
  ```json
  { "error": "human message", "code": "MACHINE_CODE" }
  ```
  HTTP status codes are conventional (400 / 401 / 403 / 404 / 409 / 503).

## Authentication

| Surface | Auth |
|---|---|
| Public discovery (health, well-known, registry GET, metrics) | none |
| `POST /api/registry/agents` | enrollment token (one-time, from `/api/registry/enroll`) |
| All other gated routes | `Authorization: Bearer <API_KEY>` from `API_KEYS` allowlist |

In production, an empty `API_KEYS` causes gated routes to return `503 SERVER_MISCONFIGURED` — fail-safe against accidental exposure.

## Routes

### Health & readiness

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | public | Liveness + DB ping |
| GET | `/api/readyz` | public | Readiness (DB, identity initialized) |
| GET | `/api/metrics` | public | Prometheus text format |

### Discovery

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/.well-known/aitp-manifest` | public | CP's own AITP manifest (Ed25519) |
| GET | `/.well-known/aitp-revocation-list` | public | Signed revocation snapshot, RFC-AITP-0008 |

### Registry

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/registry/enroll` | public + enrollment secret | Issue one-time enrollment token |
| GET | `/api/registry/agents` | public | Discover agents. Filters: `?capability=`, `?aid=`, `?displayName=`, `?namespace=` |
| POST | `/api/registry/agents` | enrollment token | Self-register an agent |
| GET | `/api/registry/agents/:aid` | public | Fetch one agent |
| GET | `/api/registry/agents/:aid/manifest` | public | Fetch the cached manifest |
| DELETE | `/api/registry/agents/:aid` | API key | Deregister |

#### `POST /api/registry/agents` body

```json
{
  "enrollmentToken": "...",
  "aid": "did:pubkey:z:...",
  "displayName": "researcher-1",
  "handshakeEndpoint": "http://agent-host:8101/aitp",
  "offeredCaps": ["demo.echo"],
  "manifestJson": "{...signed manifest JSON string...}",
  "manifestExpiresAt": "2026-06-01T00:00:00Z",
  "org": "acme",
  "cloud": "aws-us-east-1",
  "namespace": "default",
  "metadata": {}
}
```

### Sessions

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/sessions` | API key | List handshake sessions. Filters: `?status=`, `?runId=`, `?aid=` |
| GET | `/api/sessions/:sessionId` | API key | Fetch one |

### Events

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/events` | API key (or open in dev) | Ingest a batch of audit events |
| GET | `/api/events/history` | API key | Query persisted events. Filters: `?type=`, `?aid=`, `?sessionId=`, `?runId=`, `?since=`, `?until=`, `?limit=`, `?offset=` |
| GET | `/api/events/stream` | API key | Server-Sent Events stream (live + backlog) |

#### `POST /api/events` body

Accepts either a bare array or `{ events: [...] }`. Each event:

```json
{
  "type": "handshake.completed",
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

`aid_a` / `aid_b` / `session_id` / `run_id` snake_case keys are also accepted (the playground emits snake_case).

Response: `{ "ingested": <n> }`.

### Audit

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/audit` | API key | Admin audit log (who did what when) |

### Revocation

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/revocation/entries` | API key | Add a JTI to the revocation list |

#### `POST /api/revocation/entries` body

```json
{ "jti": "uuid", "reason": "operator action" }
```

The signed revocation list at `/.well-known/aitp-revocation-list` refreshes every `REVOCATION_LIST_TTL_SECS` seconds.

### Webhooks

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/webhooks` | API key | List subscriptions |
| POST | `/api/webhooks` | API key | Create |
| GET | `/api/webhooks/:id` | API key | Fetch one |
| PATCH | `/api/webhooks/:id` | API key | Update |
| DELETE | `/api/webhooks/:id` | API key | Remove |

Deliveries are POSTed with header `X-AITP-Signature: sha256=<hex>` over the canonical body bytes using the webhook's secret. Retries: `WEBHOOK_RETRY_ATTEMPTS` (default 3).

### Dashboard JSON

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/dashboard/overview` | API key | Aggregate counts + recent activity. `?window=1h\|24h\|7d\|30d` |
| GET | `/api/dashboard/agents` | API key | Per-agent metrics |

### TCTs (observed)

The CP **observes** TCTs from agent-reported `tct.issued` and `handshake.complete` events. It never issues a TCT.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/tcts` | API key | Query observed TCTs. Filters: `?issuer=`, `?subject=`, `?audience=`, `?capability=`, `?sessionId=`, `?active=true`, `?limit=`, `?offset=` |

### Delegation chains

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/delegations` | API key | Query delegations. `?root_jti=<uuid>` walks the descendant tree via a recursive CTE. Other filters: `?parent_jti=`, `?delegator=`, `?delegatee=`, `?active=true` |

### Trust anchors (OIDC)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/trust-anchors` | API key | List. `?namespace=` filter |
| POST | `/api/trust-anchors` | API key | Create. Body: `{ issuerUrl, namespace?, jwksUrl?, label? }`. Returns 409 if `(namespace, issuerUrl)` already exists. |
| GET | `/api/trust-anchors/:id` | API key | Fetch one |
| PATCH | `/api/trust-anchors/:id` | API key | Update |
| DELETE | `/api/trust-anchors/:id` | API key | Remove |

### Pinned keys

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/pinned-keys` | API key | List. `?namespace=` filter, or `?aid=&namespace=` for single-row lookup |
| POST | `/api/pinned-keys` | API key | Upsert. Body: `{ aid, pubkey, namespace?, label?, expiresAt? }`. `pubkey` must be 43-char base64url Ed25519. |
| DELETE | `/api/pinned-keys?namespace=&aid=` | API key | Remove |

### Session export / replay

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/sessions/:sessionId/export` | API key | Bundle session + events + projected TCTs. `?format=json\|jsonl` |
| GET | `/api/sessions/:sessionId/replay` | API key | Ordered event stream for one session. Filters: `?since=`, `?until=`, `?limit=` |

### Agent export

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/registry/agents/:aid/export` | API key | Bundle agent row + sessions + TCTs + recent audit events. `?format=json\|jsonl`, `?eventLimit=` |

### Webhook circuit breaker

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/webhooks/:id/circuit-breaker` | API key | Current state snapshot |
| POST | `/api/webhooks/:id/circuit-breaker/reset` | API key | Manually re-arm a breaker that's stuck open |

## Headers

| Header | Direction | Purpose |
|---|---|---|
| `Authorization` | request | `Bearer <api-key>` |
| `x-request-id` | both | Propagated for log correlation |
| `X-Aitp-Namespace` | request | Tenant scope override on enrollment |
| `X-AITP-Signature` | response (webhook delivery) | `sha256=<hex>` HMAC of body bytes |

## Status

This document tracks the **shipped** endpoints. Roadmap items (TCT lifecycle, delegation chains, trust anchors, pinned-key allowlist, batch export, replay) are in [`../plans/README.md`](../plans/README.md) and not yet exposed.
