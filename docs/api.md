# API Reference

All routes are JSON over HTTP. Base URL is `CP_BASE_URL` (default `http://localhost:4000`).

For the machine-readable spec see [`../openapi.yaml`](../openapi.yaml) — it is
normative for request/response shapes and status codes; this page explains
behaviour and the reasons behind it. For the event payloads these endpoints
emit and ingest, see [`events.md`](events.md); for the tables they read and
write, see [`data-model.md`](data-model.md).

This reference covers the **control-plane API**. Protocol artifacts these
endpoints carry (manifests, TCTs, the handshake) are defined by the
[AITP RFCs](https://agentidentitytrustprotocol.io/spec) — these docs link to the
spec rather than restate it.

## Conventions

- **Content type:** `application/json` on POST/PATCH.
- **Request gate scope:** request IDs, CORS, authentication and rate limiting are applied by the request gate (`src/proxy.ts`), which runs on `/api/*` paths only. The public `/.well-known/aitp-manifest` and `/.well-known/aitp-revocation-list` URLs are rewrites that reach their handlers **without** passing the gate, so responses on those two paths carry no `x-request-id` or CORS headers and are never rate-limited. Request the `/api/well-known/*` path directly if you need those headers.
- **Request ID:** Every `/api/*` response carries `x-request-id`. Clients may pre-set the header; the CP echoes it.
- **CORS:** On `/api/*`, `Access-Control-Allow-Origin` is set to `CORS_ORIGIN` (defaults to `http://localhost:3000`). Applied per-request by the proxy, so it reads from the runtime environment — set it to the UI console's origin. A single origin is supported. `OPTIONS` preflights are answered `204` by the proxy.
- **Filter key casing:** List filters are accepted in **both** camelCase and snake_case where noted (e.g. `runId` or `run_id`). The playground emits snake_case; UI clients tend to use camelCase. Both resolve to the same column.
- **UUIDs:** two different rules. A **token id** that "must be a UUID" (`jti`, `root_jti`, `parent_jti`) must be RFC 4122 **versions 1–5**; a v6/v7/v8 UUID is rejected as malformed. A **path `:id`** on `/api/trust-anchors/:id` (and its `/jwks`) and `/api/webhooks/:id` (and its `/circuit-breaker` routes) is checked for **syntax only** — the canonical hyphenated `8-4-4-4-12` hex form, any version, either case — and anything else is `400 ID_INVALID` before the database is touched. Ids the CP hands out are always in that form.
- **Error shape:**
  ```json
  { "error": "human message", "code": "MACHINE_CODE" }
  ```
  `code` is the stable signal; `error` is human-facing prose and may be reworded
  at any time. A few responses add one **machine-readable detail field**
  alongside these two: `bucket` on a `429` (which limiter tripped),
  `verifyCode` on `POST /api/registry/enroll` (which manifest check failed),
  `eventType` on `POST /api/events`' `413` (which event was too big),
  `issuerUrl` on `GET /api/trust-anchors/:id/jwks`' `503 JWKS_NOT_CACHED`, and
  `existing: { id }` on `POST` and `PATCH /api/trust-anchors`' `409 ALREADY_EXISTS` (the
  anchor that already holds that `(namespace, issuerUrl)`). Such a field is
  always optional and additive — absent means "not applicable here", never
  "unknown".

  The `code` values are this service's own. Some share a name with the AITP
  [error-code registry](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/registries/error-codes.md),
  but the CP is not bound by its definitions — in particular the CP's
  `MANIFEST_INVALID` covers any enrollment-time manifest rejection (bad
  envelope, failed signature or proof-of-possession, bad AID), which is broader
  than the registry's schema-validation-only meaning.

  HTTP status codes are conventional: `400` (bad body/filter), `401` (auth), `404` (not found), `405` (wrong method), `409` (conflict), `413` (payload too large), `429` (rate limited), `500` (internal fault), `503` (misconfigured / unavailable / at capacity). DELETEs do not share one success shape: some answer `204 No Content`, others `200` with a small confirmation body — so check the status per route rather than assuming one shape for "a DELETE on this API". Each DELETE's status and body are stated on that operation in [`openapi.yaml`](../openapi.yaml) (and in the route tables below).

  A `500` **never** carries the shape above. Its body is whatever the framework renders, so do not parse it and do not branch on it: the status is the whole signal — retry, and if it persists, the server's operator has the detail in their logs. Routes that cannot classify a failure rethrow it on purpose, which keeps internal detail (database messages especially) out of client-facing bodies; [`openapi.yaml`](../openapi.yaml) says on each declared `500` why that route can reach it. Where a route is known to still answer `500` for an input mistake rather than a `400`, it is listed per route below. `POST /api/events` no longer does: an item the database cannot store (including one with a NUL or a lone UTF-16 surrogate in its `jsonb` fields) is dropped and reported instead (see [`POST /api/events` body](#post-apievents-body)); its `500` now means a database fault — in the batch INSERT or, with an `Idempotency-Key`, the key lookup or response re-read.

  This rule is about `500` specifically, **not** about 5xx. A `503` is a deliberate, classified answer and carries `{error, code}`: `SERVER_MISCONFIGURED` (gate or enrollment), `SSE_CAPACITY`, `REVOCATION_UNAVAILABLE`, `JWKS_NOT_CACHED`. The **probes are the exception**: `/api/health` and `/api/readyz` answer with their own diagnostic shapes (`{ok, service, aid, db}`, `{ready, reason}`), not with `{error, code}` — treat their bodies as probe output, not as the error contract.

## Authentication

| Surface | Auth |
|---|---|
| Public discovery (health, readyz, metrics, well-known, registry GET) | none |
| `POST /api/registry/enroll` | none — caller submits its own **signed manifest**; the CP verifies the signature and issues a one-time token |
| `POST /api/registry/agents` | `Authorization: Bearer <enrollment-token>` (the token returned by `/enroll`, single-use) |
| All other gated routes | `Authorization: Bearer <API_KEY>` from the `API_KEYS` allowlist |

A gated request with a missing or unknown key is rejected by the gate with `401 { "error": "Unauthorized", "code": "INVALID_API_KEY" }` before it reaches a handler. In production, an empty `API_KEYS` makes every gated route return `503 SERVER_MISCONFIGURED` — fail-safe against accidental exposure. In non-production, an empty `API_KEYS` disables auth on gated routes (a boot-time warning is logged).

`ENROLLMENT_SECRET` is the **server-side** HMAC key the CP uses to mint and verify enrollment tokens. Callers never present it directly. A production server whose value is unset or shorter than 32 characters refuses to start, so the enrollment `503 SERVER_MISCONFIGURED` below is something you should only see from a non-production deployment — see [operations.md](operations.md#authentication--exposure).

## Rate limiting

Every `/api/*` route except `/api/health`, `/api/readyz`, and `/api/metrics` is rate-limited per process (in-memory buckets). The `/.well-known/*` rewrites bypass the gate and are not rate-limited (see [Conventions](#conventions)). Over-limit requests return:

```
HTTP 429
{ "error": "rate limit exceeded", "code": "RATE_LIMITED", "bucket": "<bucket>" }
```

with headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining: 0`, and `X-RateLimit-Reset` (epoch seconds). Buckets: `enroll-ip` (strict, per-IP, default 5/min), `public-ip` (per-IP, default 60/min), `api-key` (per-key, default 600/min). See [`operations.md`](operations.md#rate-limiting) for tuning and the `CLIENT_IP_HEADER` / `TRUSTED_PROXY_HOPS` trust model.

## Idempotency

These mutating endpoints honor an optional `Idempotency-Key` request header:

`POST /api/registry/agents`, `POST /api/events`, `POST /api/webhooks`, `POST /api/trust-anchors`, `POST /api/pinned-keys`, `POST /api/revocation/entries`.

- A key is scoped to its endpoint. Replaying the same `(endpoint, key)` returns the stored status and body without re-running the handler, and adds the response header `Idempotency-Replayed: true`.
- The key is **not** bound to the request body: a replay with the same key and a *different* body still returns the first response.
- Only stable outcomes are stored: `200`, `201`, `202`, `204`, `400`, `409`, `422`. A `401`, `429` or `5xx` is not stored, so a retry with the same key runs the handler again.
- Some `400 BODY_INVALID`s (a body that is not JSON — and, on the JSON-object-body POSTs `/api/trust-anchors`, `/api/webhooks`, `/api/pinned-keys` and `/api/revocation/entries`, a JSON body that is not an object) are decided before the idempotency layer and are never stored; field-level `400`s decided inside it are.
- Two concurrent requests with the same key may both run; the first one stored wins and the other caller receives the winner's response.
- A key that is empty, longer than 255 characters, or contains control characters is rejected `400 IDEMPOTENCY_KEY_INVALID`.

Stored responses are retained for `IDEMPOTENCY_KEY_TTL_DAYS` (default 7).

## Routes

### Health & readiness

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | public | Liveness + DB ping. `503` with `db: "error"` if the ping fails. Stays `200` during a SIGTERM drain. |
| GET | `/api/readyz` | public | Readiness: not draining, and the DB answers `SELECT 1` — `503` if either fails. It checks nothing else, by decision (see [`operations.md`](operations.md#health-readiness--graceful-shutdown)); in particular it does **not** check identity, which is `/api/health`'s business. |
| GET | `/api/metrics` | public | Prometheus text format |

### Discovery

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/.well-known/aitp-manifest` | public | CP's own AITP manifest. Rewritten to `/api/well-known/aitp-manifest`. `Cache-Control: max-age=3600`. |
| GET | `/.well-known/aitp-revocation-list` | public | Signed revocation snapshot ([RFC-AITP-0008](https://agentidentitytrustprotocol.io/spec/revocation)). Rewritten to `/api/well-known/aitp-revocation-list`. `Cache-Control: max-age=60`. `503 REVOCATION_UNAVAILABLE` when the database cannot be read — see [Revocation](#revocation). |

The CP's own manifest has an 86400s TTL and is kept fresh automatically — it rebuilds itself once it nears expiry, no restart required.

### Registry

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/registry/enroll` | public | Verify a signed manifest, issue a one-time enrollment token |
| GET | `/api/registry/agents` | public | Discover agents |
| POST | `/api/registry/agents` | enrollment token | Self-register an agent |
| GET | `/api/registry/agents/:aid` | public | Fetch one agent (summary fields; `Cache-Control: public, max-age=30`) |
| GET | `/api/registry/agents/:aid/manifest` | public | Fetch the cached signed manifest (raw JSON) |
| GET | `/api/registry/agents/:aid/export` | API key | Bundle agent + sessions + TCTs + recent events |
| DELETE | `/api/registry/agents/:aid` | API key | Deregister. `200` with `{aid, status: "deregistered"}` — a status flip, not a row deletion. |

#### `POST /api/registry/enroll`

Body is a **ManifestEnvelope** — the agent's own signed manifest. Abridged
example (the signed fields `version`, `proof_of_possession`, `signature` and
others are omitted; see
[RFC-AITP-0003 §2](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0003-manifest.md#2-agent-manifest-schema)
and the [manifest JSON Schema](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/schemas/json/aitp-manifest.schema.json)
for the full shape, and
[RFC-AITP-0001 §5.3](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0001-core.md#53-agent-id-aid)
for AID forms; for a complete, really-signed envelope see the spec's
[known-answer signed manifest](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/schemas/conformance/known-answer/signed-examples/manifest/kat-keypair-001-manifest.json),
— the envelope is `{"manifest": …}` with that file's `manifest` member; its
other top-level keys are fixture metadata):

```json
{
  "manifest": {
    "aid": "aid:pubkey:ed25519:<43-char base64url public key>",
    "display_name": "researcher-1",
    "handshake_endpoint": "http://agent-host:8101/aitp",
    "offered_capabilities": ["demo.echo"],
    "expires_at": 1790000000,
    "extensions": { "namespace": "default" }
  }
}
```

The CP verifies the manifest with the `aitp` SDK and returns `200 { token, expiresIn, aid }` — a single-use enrollment token valid for 5 minutes. Errors:

- `400 MANIFEST_INVALID` — the body has no `manifest` object, the SDK rejected the manifest, `manifest.aid` is missing or does not start with `aid:`, or the manifest verified but holds a value the registry cannot store: `display_name` over 256 characters (Unicode code points) or not a string, `aid` over 512 characters — or, with no `display_name`, over 256, since the AID is then stored as the display name — a NUL (U+0000) in `aid`, `display_name` or `handshake_endpoint`, a `handshake_endpoint` that is not a string, `offered_capabilities` that is not an array of NUL-free, well-formed strings, or an `expires_at` that is not a number of Unix seconds between years 0001 and 9999 (`0`, `null` or absent means no expiry). Rejected here so no token is minted for a manifest `POST /api/registry/agents` could never store. Checked after the expiry guard, so a manifest that fails both reports `MANIFEST_EXPIRED`.
- `400 MANIFEST_EXPIRED` — the manifest is already past `expires_at`, or expires inside the 5-minute registration window. `POST /api/registry/agents` returns the same code for the same condition; both mean "re-issue with a longer TTL".
- `400 BODY_INVALID` — the body is not JSON.
- `503 SERVER_MISCONFIGURED` — the server has no usable `ENROLLMENT_SECRET` and cannot issue tokens to anyone. The body carries no configuration detail.
- `500` — anything the route cannot classify as the caller's bad manifest or a known misconfiguration is rethrown (see [Conventions](#conventions)).

A `400` means *your* manifest is the problem and retrying it unchanged will not help; a `503` means the **server** is broken and the same request is worth retrying once the deployment is fixed.

A `400` may also carry **`verifyCode`**, the `aitp` SDK's own machine-readable reason for rejecting the manifest:

```json
{ "error": "signature verification failed", "code": "MANIFEST_INVALID", "verifyCode": "signature_invalid" }
```

Branch on `verifyCode` (or `code`), never on `error`. The value set is owned by the SDK's `verifyManifestJson` — see [aitp-rs Node SDK: Manifest verification](https://github.com/agentidentitytrustprotocol/aitp-rs/blob/main/docs/sdk-node.md#manifest-verification) (verified against `aitp` `^0.13.1`). It is a different set from `verifyRevocationList`'s, even where spellings overlap. How the CP maps it:

- `verifyCode` is present **if and only if** the SDK rejected the manifest. It is absent when one of the CP's own guards rejected it (the `aid:` prefix check, the 5-minute window, the storable-values check) or when the body never reached the SDK.
- SDK code `expired` maps to `code: MANIFEST_EXPIRED`; every other SDK code maps to `MANIFEST_INVALID`. So `MANIFEST_EXPIRED` arrives with `verifyCode: "expired"` (already past `expires_at`) or with no `verifyCode` (expires inside the registration window).
- An SDK code the CP does not recognise is passed through verbatim — treat anything unknown as a generic "manifest verification failed". (The CP's `/api/metrics` counter folds unknown codes into an `other` label; see `src/lib/registry/enroll-metrics.ts`.)

> The `ManifestEnvelope` shape and its signature/verification are defined by the protocol — [RFC-AITP-0003 (Agent Manifest)](https://agentidentitytrustprotocol.io/spec/manifest) and [RFC-AITP-0007 (Key Resolution)](https://agentidentitytrustprotocol.io/spec/key-resolution). The CP caches and serves the manifest; it does not define the format. Use the [`aitp`](https://www.npmjs.com/package/@agentidentitytrustprotocol/aitp) SDK to build and sign one.

#### `POST /api/registry/agents`

Pass the enrollment token in `Authorization: Bearer <token>`. The body is the **same ManifestEnvelope** posted to `/enroll`, byte-for-byte (the CP stores the raw bytes as the cached manifest).

Checks run in this order:

1. Body not JSON, JSON but not an object (`null`, an array, a string, a number), or no `manifest.aid` → `400 BODY_INVALID`. These are answered even on a misconfigured server.
2. No usable `ENROLLMENT_SECRET` → `503 SERVER_MISCONFIGURED`. Your token is not the problem and is not consumed.
3. Token invalid → `401 TOKEN_INVALID`: wrong scope, expired, `sub` not equal to `manifest.aid`, missing `jti`, malformed or badly signed, or not bound to this body. The token carries an `msh` claim, the SHA-256 (hex) of the exact `/enroll` request-body bytes, and this route recomputes it over *its* body — re-serialising the JSON (key order, whitespace) or sending a different manifest for the same AID changes the digest. This check runs before the `jti` is consumed, so a mismatch does not burn the token.
4. `X-Aitp-Namespace` header longer than 128 characters (Unicode code points) or containing a NUL (U+0000) → `400 BAD_REQUEST`. Runs before the `jti` is consumed, so fixing the header and retrying with the same token works — but send the retry with a **new** `Idempotency-Key` (or none): a `400` is stored against the key, so a retry with the same key replays the stored `400` without re-running the handler (see [Idempotency](#idempotency)).
5. A manifest value the `agents` row cannot store → `400 BODY_INVALID`: the same rules `/enroll` applies before minting a token (`display_name` — or, when absent, `aid` — over 256 characters, `aid` over 512, a NUL in `aid`/`display_name`/`handshake_endpoint`, a non-string `handshake_endpoint`, `offered_capabilities` that is not an array of NUL-free, well-formed strings, or an `expires_at` outside Unix seconds for years 0001–9999). Since the token is bound to the exact `/enroll` body, only a token minted before `/enroll` applied these rules can reach this; it runs before the `jti` is consumed, so it does not burn the token — but the manifest is signed and token-bound, so the fix is a corrected manifest and a fresh enrollment.
6. The token's `jti` is consumed atomically. A second presentation returns `401 TOKEN_REPLAYED`.
7. `manifest.expires_at` (Unix seconds) less than 5 minutes in the future → `400 MANIFEST_EXPIRED`.
8. `manifest.extensions.namespace` present but not a string, or (when no `X-Aitp-Namespace` header is sent) longer than 128 characters or containing a NUL → `400 BODY_INVALID`.

Steps 7 and 8 run **after** the token has been consumed, so a client that hits either must fix the manifest and **re-enroll** — retrying with the same token returns `401 TOKEN_REPLAYED`. `/enroll` applies the same 5-minute guard first to spare you this, but the two routes read their own clocks, so a manifest near the boundary can pass enroll and fail here; and they disagree on `expires_at: 0` (enroll rejects it, this route treats it as absent).

**Namespace** is taken from the `X-Aitp-Namespace` header (wins) or `manifest.extensions.namespace`, defaulting to `default`.

On a `503`, reusing the same token later only works within its 5-minute lifetime and only if the operator *restored* the secret rather than rotating it; a new `ENROLLMENT_SECRET` invalidates every token minted under the old one (`401 TOKEN_INVALID`), so re-enroll. In production a replica with an unusable secret exits at boot, so this `503` is a non-production condition.

Response `201`: `{ "aid": "...", "displayName": "...", "registeredAt": "..." }`. Emits an `agent.registered` audit event.

#### `GET /api/registry/agents`

Filters: `?capability=`, `?aid=`, `?displayName=` (or `display_name`), `?namespace=`, `?include_manifest=true`, `?limit=` (default 200, max 1000; an empty `?limit=` is clamped to `1`), `?offset=`. A NUL (U+0000) in any of the text filters returns `400 BAD_REQUEST`.

> Without `?namespace=`, results span **all** namespaces by design. Namespaces are a control-plane scoping convention, not a protocol boundary — initial peer discovery is [operational and non-normative](https://agentidentitytrustprotocol.io/docs/discovery) in AITP. The CP enforces no implicit tenant isolation, so scope your queries with `?namespace=` if you need it.

Response `{ "agents": [...] }`. Each record:

```json
{
  "aid": "aid:pubkey:ed25519:<43-char base64url public key>",
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

`GET /api/registry/agents/:aid` returns a **subset** of these fields — `aid`, `displayName`, `handshakeEndpoint`, `offeredCaps`, `status`, `registeredAt`, `lastSeenAt`, `manifestUrl` — with `Cache-Control: public, max-age=30`. Use the list route with `?aid=` if you need `namespace`, `lastEnrolledAt`, `agentManifestHint` or `manifestJson`.

### Sessions

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/sessions` | API key | List handshake sessions: the newest **200** by creation time, no pagination (`limit`/`offset` are ignored). Filters: `?status=` (exact match, not validated — an unknown value returns an empty list), `?runId=` (or `run_id`), `?aid=` (either side) |
| GET | `/api/sessions/:sessionId` | API key | Fetch one session + its events: `{ session, events }` |
| GET | `/api/sessions/:sessionId/export` | API key | Bundle session + projected TCTs + events. `?format=json\|jsonl` |
| GET | `/api/sessions/:sessionId/replay` | API key | Ordered event stream for one session: `{ sessionId, count, events }`. Filters: `?since=`, `?until=`, `?limit=` (default 1000, max 10000). Malformed `since`/`until` → `400 BAD_REQUEST`. An unknown `sessionId` is a `200` with no events, not a `404`. |

Sessions are **projected from events** — the CP does not see handshake traffic. See [`events.md`](events.md#sessions-projection).

### Events

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/events` | API key (open in dev) | Ingest a batch of audit events |
| GET | `/api/events/history` | API key | Query persisted events. Filters: `?type=`, `?aid=`, `?sessionId=` (or `session_id`), `?runId=` (or `run_id`), `?since=`, `?until=`, `?limit=` (default 100, max 1000), `?offset=`. A NUL in a text filter → `400 FILTER_INVALID` |
| GET | `/api/events/stream` | API key | Server-Sent Events (live + backlog). Filters: `?type=`, `?runId=` (or `run_id`), `?aid=` |

#### `POST /api/events` body

Accepts either a bare array or `{ "events": [...] }`. Each event:

```json
{
  "type": "handshake.complete",
  "ts": "2026-05-25T12:00:00Z",
  "aidA": "aid:pubkey:ed25519:<...>",
  "aidB": "aid:pubkey:ed25519:<...>",
  "sessionId": "uuid-or-base64url",
  "runId": "run-123",
  "grants": ["demo.echo"],
  "payload": { "...": "..." },
  "source": "playground"
}
```

No field is required. Snake_case and playground aliases are accepted, defaults are applied (e.g. `type` → `"unknown"`, `source` → `"playground"`, a missing `payload` → the whole event object), and items that are not JSON objects are silently dropped — see [`events.md`](events.md#ingest-normalization) for the full normalization. Unknown event types are stored as-is (never `4xx`); only a known set drives projections and webhooks.

The CP assigns every stored event's `id` (a client-supplied `id` is never used as the id). An event with a valid `ts` gets an id derived from its content and the caller's API key, so the same producer re-sending the same event — a retry, or a superset batch that repeats earlier events — is recognised as a **duplicate** (so give genuinely repeated, otherwise identical events a distinguishing field): stored once, streamed once, delivered to webhooks once. An event without a valid `ts` gets a random id and is stored again on every send. Recipe, caveats (at-most-once fan-out if the CP dies between the insert and the fan-out; a re-send after retention deleted the row is stored again) in [`events.md`](events.md#event-ids-and-de-duplication).

Response `200`: `{ "ingested": <n>, "dropped": <m>, "errors": [...], "inserted": <i>, "duplicates": <d> }`. All five fields are always present.

- `ingested` — the items that passed per-item validation and were handed to the event store (non-object items and dropped items are not counted). Always `inserted + duplicates`.
- `inserted` — of those, the events newly stored by this request. Only these are streamed over SSE and sent to webhooks.
- `duplicates` — of those, the events that were already stored (same content-derived id) or repeated earlier in the same batch. They are still run through the session/TCT projections (idempotently), but not stored, streamed or delivered again.
- `dropped` — object items refused by per-item validation (below). The rest of the batch is still ingested; a dropped item is not stored, streamed, projected or sent to webhooks. Non-object items are skipped silently and are **not** counted here.
- `errors` — one `{ "index", "field", "reason" }` per dropped item, **at most 20** (`dropped` is the full count). `index` is the item's position in the array you sent (counting non-object items); `field` names the normalized field (`type`, `aidA`, `aidB`, `sessionId`, `runId`, `source`, `grants`, `payload` — e.g. an over-long `session_id` reports `sessionId`); `reason` is human prose and never echoes your data.

Per-item validation (after [normalization](events.md#ingest-normalization)) drops an item when:

- `type` or `source` is over **128** characters, `aidA`/`aidB` over **512**, or `sessionId`/`runId` over **255** (counted in Unicode code points, the unit the columns use);
- any of those text fields, any `grants` entry, or any key or string value anywhere in `payload` contains a NUL character (U+0000) — Postgres cannot store it;
- any `grants` entry, or any key or string value anywhere in `payload`, contains a lone (unpaired) UTF-16 surrogate, e.g. the JSON escape `"\ud800"` with no low surrogate after it — `payload` and `grants` are `jsonb`, which rejects it (`reason`: `"<field> contains a lone UTF-16 surrogate"`). Well-formed surrogate pairs (emoji and other astral characters) are fine. When `payload` is absent the whole event is the payload, so this then covers every field of the event. (In the text columns of an item that has its own `payload`, a lone surrogate is not a drop: it is stored as U+FFFD.)
- `payload` is nested more than **64** levels deep (`reason` says "too deep").

A `ts` that is out of range (a number beyond ±8.64×10¹⁵ ms, or one that renders outside years 0001–9999) is not a drop: like an unparseable `ts`, it is replaced with the ingest time. Dropped items are logged server-side as counts only and counted in the `events_dropped_total` metric ([`operations.md`](operations.md#metrics)). With an `Idempotency-Key`, a replay returns the same `dropped`/`errors` report and does not count the drops in `events_dropped_total` again (the handler does not re-run).

Limits: a single batch must be ≤ 256 KiB on the wire and contain ≤ 500 events, and each event's `payload` must be ≤ 65,536 **characters** when serialized with `JSON.stringify` (UTF-16 code units, not bytes; when `payload` is absent the whole event is measured). Over-cap requests return `413 PAYLOAD_TOO_LARGE` (the offending `eventType` is included when a single event is too big). Split large batches into multiple requests.

A body that is not JSON is `400 BODY_INVALID`. A body whose `events` member is present and not `null` but is not an array (a string, number, boolean or object — including one with a numeric `length`) is `400 BODY_INVALID` (`"events must be an array"`), checked before the 500-event cap; like any `400` it is stored against an `Idempotency-Key`, so resend the corrected body with a new key. A JSON body that is neither an array nor an object with an `events` member (or has `"events": null`) ingests nothing and answers `200 { "ingested": 0, "dropped": 0, "errors": [], "inserted": 0, "duplicates": 0 }`. The `413` caps above stay whole-batch: a batch with one over-cap payload is refused entirely, even if that item would also have been dropped.

#### `GET /api/events/history` response

`{ "events": [...], "count": <n> }`. An unparseable `since` or `until`, or a NUL (U+0000) in `type`, `aid`, `sessionId` or `runId`, returns `400 FILTER_INVALID`. A non-numeric `limit` or `offset` falls back to the default rather than erroring, and `limit` is clamped to 1–1000. An empty `?limit=` is not "malformed": it reads as `0` and is clamped to `1`.

#### `GET /api/events/stream`

`text/event-stream`, with `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`. Each event is delivered as a `data: <json>\n\n` frame.

- **Backlog:** on connect the stream replays the process's last **100** events, *then* applies your filters to them, so a filtered stream may replay fewer than 100. (`MAX_AUDIT_EVENTS_MEMORY`, default 500, sizes the bus's total in-memory retention — not the per-subscriber replay.) It then streams live events.
- **No resume:** frames carry no `id:` line, so `Last-Event-ID` resume is not possible; a reconnect replays the backlog again. Use `GET /api/events/history` to fill gaps.
- **Per replica:** the bus and backlog are in-memory and per process. Behind several replicas, a stream only sees events ingested by the replica it is connected to.
- **Auth from browsers:** the route is gated, and a browser `EventSource` cannot send an `Authorization` header — proxy the stream server-side, or use a client that can set headers.
- **Capacity:** returns `503 SSE_CAPACITY` with `Retry-After: 30` once `MAX_SSE_CONNECTIONS` (default 500) streams are already open on this process — back off and retry.

**The first bytes are a prelude, not an event.** Every accepted connection begins with a single chunk containing a `retry:` reconnect hint and a `: connected` comment frame:

```
retry: 15000
: connected

```

**Clients must tolerate comment frames** (any line beginning `:`) and must not assume the first frame carries data — `EventSource` and every conformant SSE parser already discard comments. The prelude is sent before the backlog replay and is what puts the HTTP status line and response headers on the wire; without it a quiet control plane would send no headers until the first heartbeat. The `retry:` value tracks `SSE_HEARTBEAT_MS` (default 15000); the same interval governs the periodic `: heartbeat` keepalive frames.

### Audit

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/audit` | API key | Admin audit log (who did what when), newest first. Filters: `?limit=` (default 100, max 1000; an empty `?limit=` is clamped to `1`), `?offset=`. Response `{ entries, count }`. Entry `details` never carry a webhook secret: a `webhook.update` that sets it records `secretRotated: true`. |

This is the **admin action** log (registrations, revocations, webhook changes), distinct from the telemetry event store served by `/api/events/history`.

### Revocation

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/revocation/entries` | API key | Add a JTI to the revocation list |

```json
{ "jti": "uuid", "reason": "operator action", "revokedAt": "2026-06-01T00:00:00Z" }
```

`jti` must be a UUID (v1–5) or `400 JTI_INVALID`. `reason` is optional, a string of ≤ 500 characters. `revokedAt` is an optional date string (ISO-8601 recommended) defaulting to now; a non-string `revokedAt` is ignored and treated as absent. Other invalid input — including a body that is not JSON or is JSON but not an object (`null`, an array, a string, a number) — → `400 BODY_INVALID`. Response `201 { jti, revokedAt, reason }`.

Recording a revocation also flips the matching `issued_tcts.revoked` flag, cascades to descendant delegations, and emits a `tct.revoked` event (and webhook).

**Re-revoking a `jti` that is already on the list** is not an error: the stored entry keeps its original `revoked_at` and `reason`, but the route still answers `201` echoing the values from *this* request, and emits another `tct.revoked` event and webhook delivery.

Two further `400 BODY_INVALID` rules exist because the values are storable by neither the revocation table nor the audit event the route emits: **`revokedAt` must fall inside a bounded date range** (as a UTC instant — the epoch is the lower bound, because the signed list carries `revoked_at` as seconds since it), and **`reason` must not contain a NUL (U+0000)** (other control characters are fine). The exact bounds and their reasons are in [`openapi.yaml`](../openapi.yaml), `RevocationEntryRequest`.

A genuine database fault is a framework `500` with no `{error, code}` body, per [Conventions](#conventions). If you use `Idempotency-Key` here, note that the `BODY_INVALID` for a non-JSON or non-object body is never stored, while the field-level `400`s are.

**List freshness.** `GET /.well-known/aitp-revocation-list` is served from a per-process cache that re-reads the database and re-signs at most every **60 seconds**. A `POST` here invalidates that cache only on the replica that handled it, so other replicas can serve a list without the new entry for up to 60 seconds. `REVOCATION_LIST_TTL_SECS` is something else: the validity window of each signed list (its `expires_at`). The HTTP response carries `Cache-Control: max-age=60`.

**The list fails closed.** If the CP cannot read `revocation_entries`, `GET /.well-known/aitp-revocation-list` answers `503` with `{ "error": "revocation list temporarily unavailable", "code": "REVOCATION_UNAVAILABLE" }`, `Cache-Control: no-store` and `Retry-After: 30`. It never signs an empty list in that case: a signed empty list asserts that nothing is revoked, which the CP cannot honestly say while its store is unreachable. Operators who prefer availability can set `REVOCATION_FAIL_MODE=serve_stale`: the CP then re-serves the last list that was backed by a successful read, unchanged and still validly signed, for at most `REVOCATION_MAX_STALENESS_SECS` (default 300, clamped to `REVOCATION_LIST_TTL_SECS`), then `503`s. Recording a revocation discards that fallback, so a list known to omit an entry is never re-served.

**Relying parties:** treat a `503` as "revocation status unknown", not as an empty list. How long to keep using a previously verified list and what to do when it goes stale is the consumer's revocation policy — see [RFC-AITP-0008 §3.1 (Modes)](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0008-revocation.md#31-modes) and [§3.2 (Staleness)](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0008-revocation.md#32-staleness). Verify the signed list with the `aitp` SDK's `verifyRevocationList`, pinning the CP's AID as the expected issuer, and branch on the thrown error's `.code`, never its message — see [aitp-rs Node SDK: Revocation lists](https://github.com/agentidentitytrustprotocol/aitp-rs/blob/main/docs/sdk-node.md#revocation-lists-rfc-aitp-0008) for the code set.

### Webhooks

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/webhooks` | API key | List subscriptions (the `secret` is never included) |
| POST | `/api/webhooks` | API key | Create |
| PATCH | `/api/webhooks/:id` | API key | Update any of `url`, `events`, `secret`, `active` |
| DELETE | `/api/webhooks/:id` | API key | Remove (`200` with `{id, deleted: true}`, not `204`) |
| GET | `/api/webhooks/:id/circuit-breaker` | API key | Current breaker state snapshot |
| POST | `/api/webhooks/:id/circuit-breaker/reset` | API key | Manually re-arm a breaker stuck open |

#### `POST /api/webhooks` body

```json
{ "url": "https://hooks.example.com/aitp", "events": ["tct.revoked"], "secret": "shared-secret", "active": true }
```

`url` must be `http(s)` — `https` only in production — and pass the SSRF guard (private/loopback/link-local ranges and hosts outside `WEBHOOK_URL_ALLOWLIST` are rejected `400 URL_NOT_ALLOWED`); a non-string `url` is `400 BODY_INVALID`. An empty/omitted `events` array means **all deliverable event types**. Only a fixed set of event types is deliverable — see [`events.md`](events.md#webhook-deliverable-events). If `secret` is omitted the server generates one. The `201` response is the **only** place the secret is returned (`{ id, url, events, secret, active, createdAt }`); store it then.

`400 BODY_INVALID` on POST and PATCH when: the body is not JSON or is JSON but not an object (`null`, an array, a string, a number); `secret` is longer than 255 characters (Unicode code points); or `url`, `secret` or any `events` entry contains a NUL (U+0000). These are checked before the SSRF guard.

`PATCH /api/webhooks/:id` applies only the fields present (a new `url` passes the same guard) and answers `200 { id, url, events, active, updatedAt }`. On PATCH and DELETE a `:id` that is not a UUID is `400 ID_INVALID` (see [Conventions](#conventions)); an unknown UUID is `404 NOT_FOUND`. A PATCH that sets `secret` is recorded in the admin audit log as `secretRotated: true` — the secret itself is never written there. (Releases before this one did write it; the `0008` migration scrubs those rows, but **rotate any webhook secret that was ever set via PATCH**, since it may already have been read through `GET /api/audit`.)

Deliveries are POSTed with body `{ deliveryId, eventType, payload, enqueuedAt }` (`payload` is the full event record) and headers `X-Aitp-Signature: sha256=<hex>` — an HMAC-SHA256 over the exact body bytes using the webhook's `secret` — plus `X-Aitp-Event` (the event type) and `X-Aitp-Delivery` (the delivery id). The body is fixed at enqueue time, so every retry of a delivery carries the same bytes and signature. Retries follow `WEBHOOK_RETRY_ATTEMPTS` (default 3) with exponential backoff; a circuit breaker trips a repeatedly-failing endpoint open (thresholds configurable via `WEBHOOK_BREAKER_FAILURE_THRESHOLD` / `WEBHOOK_BREAKER_RESET_MS` — see [`operations.md`](operations.md#webhook-delivery)).

Circuit-breaker state is held **per process**: each replica has its own breaker per webhook, and the snapshot and reset routes see only the replica that served them. Both routes answer `400 ID_INVALID` for a `:id` that is not a UUID. Any UUID is accepted otherwise — an unknown id returns a fresh `closed` snapshot rather than `404`, and a reset of an unknown id still writes an admin audit entry.

### Dashboard JSON

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/dashboard/overview` | API key | Aggregate counts + recent activity. `?range=1h\|24h\|7d\|30d` (default `24h`; an unknown value falls back to `24h`) |
| GET | `/api/dashboard/agents` | API key | Per-agent metrics: `{ agents }` |

### TCTs (observed)

The CP **observes** TCTs from agent-reported `tct.issued` and `handshake.complete` events. It never issues a TCT.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/tcts` | API key | Query observed TCTs. Filters: `?issuer=`, `?subject=`, `?audience=`, `?capability=`, `?sessionId=`, `?active=true`, `?limit=` (default 100, max 1000), `?offset=`. A NUL in a text filter → `400 BAD_REQUEST` |

By default the projection records reported claims without checking any signature. With `OBSERVED_ARTIFACT_VERIFICATION=strict`, reports whose signed token does not verify (including claims-only reports) are not projected, so they never appear in `/api/tcts` or `/api/delegations`; `warn` projects every report and logs a warning only for one that carries a signed token which fails to verify — a claims-only report is projected without a log line. See [`operations.md`](operations.md#observed-artifact-verification).

### Delegation chains

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/delegations` | API key | Query delegations |

`?root_jti=<uuid>` (or `rootJti`) returns the whole descendant tree rooted at that JTI via a recursive CTE, oldest first; when it is present **every other filter, `limit` and `offset` are ignored**. Otherwise: `?parent_jti=` (or `parentJti`), `?delegator=`, `?delegatee=`, `?active=true`, `?limit=` (default 100, max 1000), `?offset=`, newest first. A malformed `root_jti`/`parent_jti` (not a UUID), or a NUL (U+0000) in `delegator`/`delegatee`, returns `400 BAD_REQUEST`.

### Trust anchors (OIDC)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/trust-anchors` | API key | List. `?namespace=` filter (a NUL in it is `400 BAD_REQUEST`) |
| POST | `/api/trust-anchors` | API key | Create. Body: `{ issuerUrl, namespace?, jwksUrl?, label? }`. `400 BODY_INVALID` if the body is not a JSON object, `issuerUrl` or a non-empty `jwksUrl` is not an `http(s)://` string, or a field is not storable (limits below). `409 ALREADY_EXISTS` (with `existing: { id }`) if `(namespace, issuerUrl)` exists. |
| GET | `/api/trust-anchors/:id` | API key | Fetch one (without `addedBy`) |
| PATCH | `/api/trust-anchors/:id` | API key | Update `issuerUrl` / `jwksUrl` / `label` (without `addedBy` in the response; `namespace` is not patchable; a field of the wrong type is ignored). `400 BODY_INVALID` if the body is not a JSON object, a string `issuerUrl` or a non-empty `jwksUrl` is not an `http(s)://` URL, or a field is not storable (limits below). `409 ALREADY_EXISTS` (with `existing: { id }`) if the new `issuerUrl` is already used by another anchor in this anchor's namespace; nothing is changed. Clears the cached JWKS when `issuerUrl` or `jwksUrl` actually changes (see JWKS route below). |
| DELETE | `/api/trust-anchors/:id` | API key | Remove (`204`) |
| GET | `/api/trust-anchors/:id/jwks` | API key | The CP-cached JWKS for the anchor, for agents that cannot reach the issuer |

On every `/api/trust-anchors/:id` route (including `/jwks`), an `:id` that is not a UUID is `400 ID_INVALID` (see [Conventions](#conventions)); an unknown UUID is `404 NOT_FOUND`.

**Field limits** (POST and PATCH, `400 BODY_INVALID` when exceeded): `namespace` and `label` at most 128 characters (Unicode code points); `issuerUrl` at most 2048 characters **and** 2048 UTF-8 bytes (it sits in a unique index whose row limit is in bytes); `jwksUrl` at most 2048 characters; none may contain a NUL (U+0000). An empty-string `jwksUrl` means "no explicit JWKS URL" and is stored as `null` (on PATCH it clears the field, like `null`).

**JWKS route.** The cache is filled by a background refresher (see [`operations.md`](operations.md#trust-anchor-jwks-refresh)), never by this request.

- `200` returns the cached JWKS with `Cache-Control: max-age=300` and `X-JWKS-Cached-At` (the cache time).
- `503 JWKS_NOT_CACHED` (body includes `issuerUrl`; headers `Retry-After: 60`, `Cache-Control: no-store`) until the refresher has fetched the keyset once. If it never succeeds — the issuer is unreachable, `JWKS_REFRESH_ENABLED=false`, or the URL is `http://` in production — this persists.
- After one successful fetch, later failures do **not** clear the cache: the route keeps serving the last good keyset with `200`. Check `X-JWKS-Cached-At` to judge its age.
- A `PATCH` that **actually changes** `issuerUrl` or `jwksUrl` clears the cache (`jwks_cache` and `jwks_cached_at`) in the same statement, so the old issuer's keys are never served for the new URLs. The route then answers `503 JWKS_NOT_CACHED` until the refresher's next pass fetches the new keyset — up to `JWKS_REFRESH_INTERVAL_MS` (default 15 min), longer if that fetch fails. The PATCH does not trigger a fetch itself. A `PATCH` that only changes `label`, or resends the current URLs unchanged (as the ui-console does on every edit; `""` and `null` are the same `jwksUrl`), keeps the cache. A refresh that was already in flight when the URLs changed discards the keyset it fetched for the old URLs.
- `400 ID_INVALID` (not a UUID — syntax only, any version), `404 NOT_FOUND`.

### Pinned keys

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/pinned-keys` | API key | List. `?namespace=` filter, or `?aid=&namespace=` for a single-row lookup (`namespace` defaults to `default`). A NUL in either → `400 BAD_REQUEST`. |
| POST | `/api/pinned-keys` | API key | Upsert. Body: `{ aid, pubkey, namespace?, label?, expiresAt? }`. `201` whether the row was created or replaced. |
| DELETE | `/api/pinned-keys?namespace=&aid=` | API key | Remove (`204`). Missing `aid`, or a NUL in `aid`/`namespace` → `400 BAD_REQUEST`. |

`POST` returns `400 BODY_INVALID` when the body is not JSON or is JSON but not an object (`null`, an array, a string, a number); `aid` is missing, empty, longer than 512 characters or contains a NUL; `namespace` is longer than 128 characters or contains a NUL; `pubkey` is not a 43-character base64url Ed25519 key; `label` is neither a string nor `null`, or is over 128 characters or contains a NUL; or `expiresAt` is neither a string nor `null`, or is unparseable or outside the writable `timestamptz` window (exact bounds in [`openapi.yaml`](../openapi.yaml); a past instant is allowed and retires the pin). Lengths count Unicode code points; other control characters (newline, tab) are allowed. Behaviour to be aware of:

- The upsert **replaces** `pubkey`, `label` and `expiresAt` on an existing `(namespace, aid)`: sending `null` for `label` or `expiresAt` clears it, and so does omitting it (full-replace semantics, intended).
- A `namespace` that is not a string, or is empty, means `default`.

## Headers

| Header | Direction | Purpose |
|---|---|---|
| `Authorization` | request | `Bearer <api-key>` (gated routes) or `Bearer <enrollment-token>` (`POST /api/registry/agents`) |
| `Idempotency-Key` | request | Dedupe a retried mutation (see [Idempotency](#idempotency)) |
| `X-Aitp-Namespace` | request | Namespace override on registration (`POST /api/registry/agents`) |
| `x-request-id` | both | Propagated for log correlation (`/api/*` only) |
| `Idempotency-Replayed` | response | `true` when the response is a stored idempotent replay |
| `Retry-After`, `X-RateLimit-*` | response | Present on `429` responses (`Retry-After` also on some `503`s) |
| `X-JWKS-Cached-At` | response | Cache time of the JWKS served by `GET /api/trust-anchors/:id/jwks` |
| `X-Aitp-Signature` | webhook delivery | `sha256=<hex>` HMAC-SHA256 of the body bytes |
| `X-Aitp-Event` | webhook delivery | Event type of the delivery |
| `X-Aitp-Delivery` | webhook delivery | Delivery id (stable across retries) |

## Lifecycle

- `GET /api/readyz` returns `503` with `{ "ready": false, "reason": "shutting_down" }` once the process has received SIGTERM, so a load balancer can drain the pod before it exits. `GET /api/health` continues to return `200` during the drain window. See [`operations.md`](operations.md#health-readiness--graceful-shutdown).
