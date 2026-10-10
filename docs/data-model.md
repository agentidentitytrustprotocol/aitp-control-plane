# Data model

Postgres schema, defined in [`src/lib/db/schema.ts`](../src/lib/db/schema.ts)
with Drizzle and migrated by the SQL files in [`drizzle/`](../drizzle). All
timestamps are native Postgres `timestamptz`; the application reads and writes
them as ISO-8601 strings (Drizzle `mode: 'string'`). JSON columns are `jsonb`.

This is a reference for operators querying the database directly and for anyone
extending the schema. For the events that populate the derived tables, see
[`events.md`](events.md).

## Tables

### `agents` — registry
One row per enrolled agent.

| Column | Type | Notes |
|---|---|---|
| `aid` | varchar(512) PK | Agent identity |
| `display_name` | varchar(256) | |
| `handshake_endpoint` | text | Agent's p2p handshake URL |
| `offered_caps` | jsonb `string[]` | GIN-indexed for `@>` capability discovery |
| `manifest_json` | text | Raw signed ManifestEnvelope bytes (the CP's cached copy) |
| `manifest_expires_at` | timestamptz | Manifest TTL; the expiry sweep flips `status` when it lapses |
| `status` | varchar(32) | `active` \| `expired` \| `deregistered` (`inactive` is a legacy synonym) |
| `registered_at` | timestamptz | Set once at first enrollment |
| `last_enrolled_at` | timestamptz | Updated on every (re-)register |
| `last_seen_at` | timestamptz | Set to the ingest time whenever the AID appears as `aidA`/`aidB` of an event ingested via `POST /api/events` |
| `org`, `cloud` | varchar(128) | Optional labels (not set by the current enroll path) |
| `namespace` | varchar(128) | Tenant scope, default `default` |
| `metadata` | jsonb | Operator-provided blob |

Indexes: `status`, `registered_at`, `namespace`, GIN on `offered_caps`.

### `handshake_sessions` — sessions projection
Projected from `handshake.*` events. The CP never sees handshake traffic; this is a reconstruction.

| Column | Type | Notes |
|---|---|---|
| `session_id` | varchar(255) PK | |
| `aid_a`, `aid_b` | varchar(512) | Participants |
| `status` | varchar(32) | `started` \| `complete` \| `failed` |
| `grants` | jsonb `string[]` | From the completion event |
| `run_id` | varchar(255) | Trace correlation |
| `boundary` | varchar(32) | Derived from payload |
| `error` | text | Set when `failed` |
| `started_at`, `completed_at`, `created_at`, `updated_at` | timestamptz | |

Indexes: `status`, `aid_a`, `aid_b`, `run_id`.

### `audit_events` — append-only event store
Every ingested or CP-emitted event. Backs `/api/events/history`. The SSE stream (`/api/events/stream`) is served from an in-memory bus and backlog, not from this table.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Always server-generated (a client-supplied event `id` is discarded), so it does not de-duplicate re-sent events; use `Idempotency-Key` on ingest |
| `type` | varchar(128) | e.g. `handshake.complete` |
| `ts` | timestamptz | Event time |
| `aid_a`, `aid_b` | varchar(512) | |
| `session_id`, `run_id` | varchar(255) | |
| `grants` | jsonb `string[]` | |
| `payload` | jsonb | Event-specific body |
| `source` | varchar(128) | `cp`, `playground`, an agent AID, etc. |
| `created_at` | timestamptz | |

Indexes: `type`, `ts`, `session_id`, `run_id`, `aid_a`. Aged out after `AUDIT_EVENTS_TTL_DAYS`.

### `issued_tcts` — observed TCTs
Projected from `tct.issued` / `handshake.complete` payloads. The CP observes; it never issues.

| Column | Type | Notes |
|---|---|---|
| `jti` | uuid PK | |
| `issuer_aid`, `subject_aid`, `audience_aid` | varchar(512) | All indexed |
| `grants` | jsonb `string[]` | GIN-indexed |
| `binding_cnf` | varchar(128) | Opaque key-binding value: the `cnf.jkt` JWK thumbprint ([RFC-AITP-0005 §3](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0005-tct.md)); older v0.1 reports stored `binding.cnf` here |
| `issued_at` | timestamptz | |
| `expires_at` | timestamptz | |
| `session_id` | varchar(255) | Indexed |
| `revoked`, `revoked_at` | boolean / timestamptz | Set by any `tct.revoked` event — CP-emitted on `POST /api/revocation/entries`, or ingested |
| `created_at` | timestamptz | Row insert time |

Indexes: `issuer_aid`, `subject_aid`, `audience_aid`, `session_id`, GIN on `grants`.

### `delegations` — delegation chains
Parent→child TCT relationships — single-hop [RFC-AITP-0006](https://agentidentitytrustprotocol.io/spec/delegation); multi-hop draft [RFC-AITP-0011](https://agentidentitytrustprotocol.io/spec/multihop-delegation). `?root_jti=` queries walk this tree via a recursive CTE.

| Column | Type | Notes |
|---|---|---|
| `jti` | uuid PK | Child delegation |
| `parent_jti` | uuid | Indexed; root of a chain walk |
| `delegator_aid`, `delegatee_aid` | varchar(512) | Indexed |
| `scope` | jsonb `string[]` | Delegated capability subset |
| `issued_at`, `expires_at` | timestamptz | |
| `revoked`, `revoked_at` | boolean / timestamptz | |
| `revoked_reason` | varchar(64) | `explicit` \| `parent_revoked` (cascade) |
| `created_at` | timestamptz | Row insert time |

Indexes: `parent_jti`, `delegator_aid`, `delegatee_aid`. For how `jti` and `parent_jti` are derived from reported tokens, see [`events.md`](events.md#tct--delegation-projection).

### `revocation_entries` — revoked JTIs
Backs the signed `/.well-known/aitp-revocation-list` (format: [RFC-AITP-0008](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0008-revocation.md)). Adding a row via `POST /api/revocation/entries` emits `tct.revoked`, which flips `issued_tcts.revoked`. An ingested `tct.revoked` event flips `issued_tcts.revoked` but does **not** add a row here.

| Column | Type | Notes |
|---|---|---|
| `jti` | uuid PK | |
| `revoked_at` | timestamptz | Defaults to now |
| `reason` | text | Optional |
| `created_at` | timestamptz | |

### `webhooks` — subscriptions
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `url` | text | SSRF-guarded at write time |
| `events` | jsonb `string[]` | Empty = all deliverable types |
| `secret` | varchar(255) | HMAC-SHA256 signing key |
| `active` | boolean | Indexed |
| `created_at`, `updated_at` | timestamptz | |

### `webhook_deliveries` — outbox
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `webhook_id` | uuid FK | `ON DELETE CASCADE` from `webhooks` |
| `event_type` | varchar(128) | |
| `payload` | jsonb | Full event envelope |
| `body` | text | Canonical bytes captured at enqueue for byte-stable retries |
| `signature` | varchar(64) | HMAC computed once at enqueue (survives secret rotation) |
| `status` | varchar(32) | `pending` \| `delivered` \| `failed` |
| `attempts` | integer | Optimistic-lock counter |
| `status_code`, `error` | integer / text | Last attempt result |
| `delivered_at`, `next_retry_at` | timestamptz | Exponential backoff |
| `created_at` | timestamptz | |

Indexes: `webhook_id`, `status`. Terminal rows aged out after `WEBHOOK_DELIVERY_TTL_DAYS`.

### `admin_audit_log` — admin actions
Distinct from `audit_events`; records who hit the admin mutating endpoints.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `action` | varchar(128) | One of `agent.register`, `agent.deregister`, `revocation.add`, `webhook.create`, `webhook.update`, `webhook.delete`, `webhook.circuit-breaker.reset`, `trust-anchor.create`, `trust-anchor.update`, `trust-anchor.delete`, `pinned-key.upsert`, `pinned-key.delete` |
| `actor_id` | varchar(255) | Indexed |
| `target_id` | varchar(512) | Affected AID/JTI |
| `details` | jsonb | |
| `request_id` | varchar(255) | Correlation |
| `created_at` | timestamptz | Indexed; aged out after `ADMIN_AUDIT_TTL_DAYS` |

### `trust_anchors` — OIDC issuer allowlist
OIDC identity mode ([RFC-AITP-0002](https://agentidentitytrustprotocol.io/spec/identity)). Unique on `(namespace, issuer_url)`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `namespace` | varchar(128) | Indexed |
| `issuer_url` | text | |
| `jwks_url` | text | Optional override of issuer's `jwks_uri` |
| `jwks_cache`, `jwks_cached_at` | jsonb / timestamptz | Issuer keyset cached by the CP's background JWKS refresher; served by `GET /api/trust-anchors/:id/jwks`. List/detail responses expose only `jwksCachedAt`. See [`operations.md`](operations.md#trust-anchor-jwks-refresh) |
| `label`, `added_by` | varchar | |
| `created_at`, `updated_at` | timestamptz | |

### `pinned_keys` — pinned-key allowlist
Pinned-key identity mode ([RFC-AITP-0002](https://agentidentitytrustprotocol.io/spec/identity)). Composite PK `(namespace, aid)`.

| Column | Type | Notes |
|---|---|---|
| `namespace` | varchar(128) | PK part |
| `aid` | varchar(512) | PK part; also indexed |
| `pubkey` | varchar(128) | Ed25519 public key, 43-char base64url (the only form the API accepts) |
| `label`, `added_by` | varchar | |
| `expires_at` | timestamptz | Optional |
| `created_at`, `updated_at` | timestamptz | |

### `idempotency_keys` — request de-dupe
Caches the response of a mutating request keyed by `(scope, key)`.

| Column | Type | Notes |
|---|---|---|
| `scope` | varchar(64) | PK part — endpoint id: `agents.register`, `events.ingest`, `pinned-keys.upsert`, `revocation.entries`, `trust-anchors.create`, `webhooks.create` |
| `key` | varchar(255) | PK part — the client `Idempotency-Key` value |
| `response_status` | integer | Cached HTTP status |
| `response_body` | jsonb | Cached body |
| `created_at` | timestamptz | Indexed; aged out after `IDEMPOTENCY_KEY_TTL_DAYS` |

### `enrollment_jtis` — one-time-token enforcement
A consumed enrollment-token `jti` lands here; a replay conflicts on the PK.

| Column | Type | Notes |
|---|---|---|
| `jti` | varchar(64) PK | |
| `expires_at` | timestamptz | Token TTL; indexed; row aged out after it |
| `created_at` | timestamptz | |

## Migrations

Applied in order by `npm run db:migrate` (drizzle-kit). Each push to `main`
that changes the schema adds a new file; run migrations against the target
database from a checkout (the runtime image does not bundle `drizzle-kit`).
See [`drizzle/README.md`](../drizzle/README.md) for the migration workflow.

| File | Adds |
|---|---|
| `0000_init.sql` | Initial schema: agents, handshake_sessions, audit_events, revocation_entries, webhooks, webhook_deliveries, admin_audit_log |
| `0001_plan_v0_2.sql` | Backfill legacy `inactive` → `deregistered`; add `agents.last_enrolled_at`, `agents.namespace` (NOT NULL default `default`) + `agents_namespace_idx` |
| `0002_offered_caps_gin.sql` | GIN index on `agents.offered_caps` |
| `0003_webhook_delivery_body.sql` | `body` + `signature` on `webhook_deliveries` |
| `0004_idempotency_keys.sql` | `idempotency_keys` table |
| `0005_aitp_depth.sql` | `issued_tcts`, `delegations`, `trust_anchors`, `pinned_keys` tables + their indexes |
| `0006_trust_anchors_uniq.sql` | Unique `(namespace, issuer_url)` |
| `0007_enrollment_jtis.sql` | `enrollment_jtis` table + index on `expires_at` |

`drizzle/manual/0002_offered_caps_gin.concurrent.sql` is a parallel, operator-applied
variant of `0002` that builds the same GIN index with `CREATE INDEX CONCURRENTLY`
(no write lock on a large live `agents` table). It is **not** run by
`npm run db:migrate`; its header documents the procedure.

> **Retention note:** `revocation_entries`, `issued_tcts`, `delegations`,
> `trust_anchors`, and `pinned_keys` are **not** swept — they're authoritative
> records, not telemetry. Only `audit_events`, `webhook_deliveries`,
> `admin_audit_log`, `idempotency_keys`, `enrollment_jtis`, and long-deregistered
> `agents` are aged out. See [`operations.md`](operations.md#data-retention).
