# Playground integration contract

This document is the **CP side** of the contract with
[`aitp-playground`](https://github.com/agentidentitytrustprotocol/aitp-playground):
which of *this service's* endpoints and fields the playground depends on, and
what the CP may or may not change without coordinating. Anything marked
**load-bearing** below is a breaking change if altered.

It is deliberately **not** a description of how the playground works. The
playground-side map — which playground feature calls which CP endpoint, the
`CpClient` methods, the scenario step types that drive them, and the
degradation mechanics — is owned by and documented in the playground repo:
[`aitp-playground/docs/control-plane.md`][pg-cp] (see its "CP endpoints the
playground uses" and "What lives where" sections). This page links there rather
than restating it, exactly as that page links back here for endpoint shapes.

## The one invariant: everything degrades gracefully

**No CP call is required for a scenario to run.** The playground treats every CP
call as optional and best-effort — when `CP_BASE_URL` is unset, or any call
times out or errors, it falls back to a no-op and the run still completes,
losing only the CP-backed discovery, telemetry, and inspection features. The
exact fallback values and per-call timeout are the playground's concern; see
[`control-plane.md`][pg-cp].

The CP obligation this implies — and the only part of the invariant this repo
owns — is: **return 2xx quickly** on the hot-path calls (discovery and
`POST /api/events`) and never require the playground to send anything it can't
cheaply produce.

[pg-cp]: https://github.com/agentidentitytrustprotocol/aitp-playground/blob/main/docs/control-plane.md

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

Batch limits still apply: ≤ 256 KiB per request, **≤ 500 events per batch**,
≤ 64 KiB per event `payload` — an over-cap batch gets `413 PAYLOAD_TOO_LARGE`,
not a fire-and-forget 2xx. Runners producing more than 500 events per run must
split the batch.

> ⚠️ The playground emits `handshake.completed` (past tense), but the CP's
> session/TCT projection and webhook fan-out key on `handshake.complete`. Events
> are stored and streamed either way, but `completed` projects **no** session.
> This is a known naming mismatch between the two repos — see
> [`events.md` § naming nuance](events.md#sessions-projection). Resolve it on one
> side before relying on session projections from playground telemetry.

## Endpoints the playground depends on

The CP endpoints the playground currently calls, with the **CP-side contract**
for each — the request keys it sends and response keys it reads that must not
break. The playground-internal mapping (client method, the scenario step type or
API proxy that drives each call) lives in [`control-plane.md`][pg-cp]; treat that
as the source of truth for the current call list, and this table as the CP's
record of what those calls depend on.

| Endpoint | Load-bearing? | CP-side contract the playground relies on |
|---|---|---|
| `GET /api/registry/agents?capability=` | **yes** | reads `agents[0].handshakeEndpoint` (see above) |
| `POST /api/events` | **yes** | snake_case envelope keys; 2xx quickly (see above) |
| `POST /api/revocation/entries` | no | body `{jti, reason?}`; idempotent |
| `GET /.well-known/aitp-revocation-list` | no | **public, no auth**; reads `entries[].jti` (tolerates a `revocation_list` wrapper) |
| `GET /api/events/history` | no | params `run_id`, `aid`, `type`, `limit` |
| `GET /api/sessions` | no | params `run_id`, `aid`, `status`, `limit` |
| `GET /api/sessions/{id}/replay` | no | params `since`, `until`, `limit`; reads `events` |
| `POST /api/webhooks` | no | run-scoped delivery URL; `events: []` ⇒ all deliverable types |
| `DELETE /api/webhooks/{id}` | no | 404 treated as success |
| `GET /api/tcts` | no | sends `sessionId` (camelCase), `active=true` as string |
| `GET /api/delegations` | no | `root_jti` walks the tree |
| `GET /api/dashboard/overview` | no | ⚠️ param drift — see below |
| `GET /api/dashboard/agents` | no | reads `agents` |
| `GET /api/trust-anchors` | no | reads `trustAnchors`; `namespace` filter |
| `POST /api/trust-anchors` | no | body `{issuerUrl, namespace?, jwksUrl?, label?}` |
| `GET /api/pinned-keys` | no | reads `pinnedKeys`; `namespace` filter |
| `POST /api/pinned-keys` | no | body `{aid, pubkey, namespace?, label?}` |

The playground also **receives** webhook deliveries the CP POSTs to a run-scoped
URL it registers via `POST /api/webhooks`. The CP signs those with
`X-AITP-Signature` — see [`api.md` § Webhooks](api.md#webhooks).

Enrollment (`POST /api/registry/enroll` → `POST /api/registry/agents`) is **not**
called by the playground — agents enroll themselves; the playground only
discovers them.

## Known contract drift

Surfaced while reconciling this doc with the live client — fix on whichever side
owns the field:

- **Dashboard window is ignored.** The playground sends `?window=<window>` to
  `GET /api/dashboard/overview`, but the CP route reads **`?range=`**. The CP
  therefore always returns the default `24h` window regardless of what the
  playground requests. Fix on either side: rename the playground param to
  `range`, or have the CP accept `window` as an alias.

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
# Start the CP
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Then start the playground pointed at it — the run command, ports, and scenario
payloads are playground-owned; follow
[`aitp-playground/docs/getting-started.md`][pg-gs] and point it at the CP with:

```bash
export CP_BASE_URL=http://localhost:4000
export CP_API_KEY=""   # leave empty for local dev (no API_KEYS set on the CP)
```

After a run, confirm the load-bearing telemetry path from the CP side:

```bash
curl 'http://localhost:4000/api/events/history?limit=10' | jq
```

If the events show up, the load-bearing integration is healthy. The broader
surface is exercised by scenarios using the `cp_subscribe_webhook`, `revoke_tct`
(`via_cp: true`), `cp_provision_trust_anchor`, and `cp_delegation_tree` step
types — all defined and documented in the playground repo.

[pg-gs]: https://github.com/agentidentitytrustprotocol/aitp-playground/blob/main/docs/getting-started.md
