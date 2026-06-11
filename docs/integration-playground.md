# Playground integration contract

This document describes the API surface that
[`aitp-playground`](https://github.com/agentidentitytrustprotocol/aitp-playground)
depends on. It is the integration contract — changes to anything marked
**load-bearing** below must be coordinated with the playground.

The playground talks to the CP through a single client,
`aitp_playground/cp_client/client.py` (`CpClient`). That client has grown well
beyond its original two calls: it now exercises **~18 CP endpoints** across
discovery, telemetry, revocation, webhooks, sessions, observation projections
(TCTs/delegations), the dashboard, and the trust store.

## The one invariant: everything degrades gracefully

**No CP call is required for a scenario to run.** Every method on `CpClient`:

- returns a no-op value (`[]` / `None` / `False` / `{}`) when `cp_base_url` is empty, and
- wraps the request in `try/except`, logs a warning, and returns the same no-op value on any failure (timeout, 4xx, 5xx, malformed body).

So the CP is an **optional, best-effort coordination surface** for the
playground. It can be down, slow, or unconfigured and runs still complete — they
just lose the CP-backed discovery, telemetry, and inspection features. The
playground times out each call at `cp_timeout_ms` (default 5000 ms).

This invariant is itself part of the contract: the CP should **return 2xx
quickly** on the hot-path calls and never require the playground to send
anything it can't cheaply produce.

## Load-bearing endpoints

These two are the historical core and the ones a run's *behavior* can depend on.
Breaking either is a breaking change.

### 1. Capability discovery — `GET /api/registry/agents?capability=<cap>`

Used when a scenario sets `trust.discovery: cp_registry` for an `org: external`
agent (`discover_by_capability`, driven from the trust orchestrator). The
playground reads `agents[0].handshakeEndpoint` to point its peer-discovery
TrustOrchestrator at the first match.

```json
{ "agents": [ { "aid": "did:pubkey:z:...", "handshakeEndpoint": "http://agent-host:8101/aitp", "offeredCaps": ["demo.echo"], "status": "active", "namespace": "default", "...": "..." } ] }
```

The CP **must** include `handshakeEndpoint` on every record. If this call returns
`[]` or a non-2xx, the scenario fails over to `static` discovery. (Full record
shape: [`api.md`](api.md#get-apiregistryagents).)

### 2. Telemetry ingestion — `POST /api/events`

Fire-and-forget after a run completes (`ingest_events`). Body is
`{ "events": [...] }` with **snake_case** keys — this is canonical from the
playground:

```json
{ "events": [ { "type": "handshake.completed", "ts": "2026-05-25T12:00:00.000Z", "aid_a": "did:pubkey:z:...", "aid_b": "did:pubkey:z:...", "session_id": "uuid", "run_id": "run-abc", "grants": ["demo.echo"], "payload": { "...": "..." }, "playground": { "run_id": "run-abc", "scenario": "research-and-write" } } ] }
```

The CP must: return 2xx quickly; normalize `aid_a`/`aid_b`/`session_id`/`run_id`
to camelCase internally; de-dupe on event `id` (`ON CONFLICT DO NOTHING`); and
tolerate unknown event types (record as-is, never 4xx). See
[`events.md`](events.md) for which types drive projections and webhooks.

> ⚠️ The playground emits `handshake.completed` (past tense), but the CP's
> session/TCT projection and webhook fan-out key on `handshake.complete`. Events
> are stored and streamed either way, but `completed` projects **no** session.
> This is a known naming mismatch between the two repos — see
> [`events.md` § naming nuance](events.md#sessions-projection). Resolve it on one
> side before relying on session projections from playground telemetry.

## Full endpoint surface

Everything `CpClient` calls, grouped by feature. "Driver" is the scenario step
type or playground API proxy that triggers it; all are best-effort.

| # | Endpoint | Client method | Driver | Notes |
|---|---|---|---|---|
| 1 | `GET /api/registry/agents?capability=` | `discover_by_capability` | `trust.discovery: cp_registry` | **load-bearing** (see above) |
| 2 | `POST /api/events` | `ingest_events` | post-run, fire-and-forget | **load-bearing** (snake_case) |
| 3 | `POST /api/revocation/entries` | `publish_revocation` | `revoke_tct` step with `via_cp: true` | body `{jti, reason?}`; idempotent |
| 4 | `GET /.well-known/aitp-revocation-list` | `fetch_revocation_list` | agent deny-set refresh | **public, no auth**; client reads `entries[].jti` (tolerates a `revocation_list` wrapper) |
| 5 | `GET /api/events/history` | `fetch_events_history` | `GET /runs/{id}/cp-audit` proxy | params `run_id`, `aid`, `type`, `limit` |
| 6 | `GET /api/sessions` | `fetch_sessions` | `GET /runs/{id}/cp-sessions` proxy | params `run_id`, `aid`, `status`, `limit` |
| 7 | `GET /api/sessions/{id}/replay` | `replay_session` | `/cp` inspection proxy | params `since`, `until`, `limit`; reads `events` |
| 8 | `POST /api/webhooks` | `create_webhook` | `cp_subscribe_webhook` step | run-scoped delivery URL; `events: []` ⇒ all deliverable types |
| 9 | `DELETE /api/webhooks/{id}` | `delete_webhook` | webhook teardown | 404 treated as success |
| 10 | `GET /api/tcts` | `fetch_tcts` | `/cp/tcts` proxy | sends `sessionId` (camelCase), `active=true` as string |
| 11 | `GET /api/delegations` | `fetch_delegations` | `cp_delegation_tree` step | `root_jti` walks the tree |
| 12 | `GET /api/dashboard/overview` | `fetch_dashboard_overview` | `/cp/dashboard` proxy | ⚠️ param drift — see below |
| 13 | `GET /api/dashboard/agents` | `fetch_dashboard_agents` | `/cp/agents` proxy | reads `agents` |
| 14 | `GET /api/trust-anchors` | `list_trust_anchors` | provisioning confirm | reads `trustAnchors`; `namespace` filter |
| 15 | `POST /api/trust-anchors` | `upsert_trust_anchor` | `cp_provision_trust_anchor` step | body `{issuerUrl, namespace?, jwksUrl?, label?}` |
| 16 | `GET /api/pinned-keys` | `list_pinned_keys` | provisioning confirm | reads `pinnedKeys`; `namespace` filter |
| 17 | `POST /api/pinned-keys` | `upsert_pinned_key` | `cp_provision_trust_anchor` step | body `{aid, pubkey, namespace?, label?}` |

The playground also **receives** webhook deliveries the CP POSTs to its
run-scoped `POST /webhooks/cp/{run_id}` URL (created via #8); it records them as
`cp.webhook.delivered` events. The CP signs those with `X-AITP-Signature` — see
[`api.md` § Webhooks](api.md#webhooks).

Enrollment (`POST /api/registry/enroll` → `POST /api/registry/agents`) is **not**
called by the playground client — agents enroll themselves; the playground only
discovers them.

## Known contract drift

Surfaced while reconciling this doc with the live client — fix on whichever side
owns the field:

- **Dashboard window is ignored.** `fetch_dashboard_overview` sends
  `?window=<window>`, but the CP route reads **`?range=`**
  (`/api/dashboard/overview`). The CP therefore always returns the default `24h`
  window regardless of what the playground requests. Either rename the client
  param to `range` or have the CP accept `window` as an alias.

## Configuration mapping

| Playground config | CP env var | Notes |
|---|---|---|
| `cp_base_url` | `CP_BASE_URL` | Empty ⇒ the whole client is a no-op |
| `cp_api_key` | one of `API_KEYS` | Sent as `Authorization: Bearer` on every call except the public revocation-list fetch. If unset on the playground but `API_KEYS` is set on the CP, gated calls 401 (and degrade). In dev with `API_KEYS=` the CP accepts unauthenticated calls. |
| `cp_timeout_ms` | n/a | Client-side timeout, default 5000 ms |

## Versioning

The CP follows semver; this contract is **stable under v0.x** — additions are
allowed, breaking changes need coordination.

- Adding optional fields to the agent record or event envelope: non-breaking.
- Renaming/removing `handshakeEndpoint`, `aid`, `aid_a`, `aid_b`, `session_id`, `run_id`: **breaking** (load-bearing).
- Changing auth on discovery or `/api/events`: **breaking**.
- Renaming response keys the client reads (`agents`, `events`, `sessions`, `tcts`, `delegations`, `trustAnchors`, `pinnedKeys`, `entries`) or request keys it sends (`issuerUrl`, `jwksUrl`, `pubkey`, `sessionId`, `jti`): breaking for that feature — coordinate.

## Verifying locally

```bash
# Start CP
docker compose up -d postgres
npm run db:migrate
npm run dev

# Start playground (in another dir)
cd ../aitp-playground
export CP_BASE_URL=http://localhost:4000
export CP_API_KEY=""   # leave empty for local dev (no API_KEYS set on CP)
uvicorn aitp_playground.main:app --port 8000

# Trigger a run
curl -X POST http://localhost:8000/runs \
  -H 'content-type: application/json' \
  -d '{"pack":"intra-org","scenario":"research-and-write","version":"v1"}'

# Confirm telemetry arrived
curl 'http://localhost:4000/api/events/history?limit=10' | jq
```

If the events show up, the load-bearing integration is healthy. To exercise the
broader surface, run scenarios that use the `cp_subscribe_webhook`,
`revoke_tct` (`via_cp: true`), `cp_provision_trust_anchor`, and
`cp_delegation_tree` step types.
