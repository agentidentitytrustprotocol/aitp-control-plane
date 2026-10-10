# Playground integration contract

This document is the **CP side** of the contract with
[`aitp-playground`](https://github.com/agentidentitytrustprotocol/aitp-playground):
which of *this service's* endpoints and fields the playground depends on, and
what the CP may or may not change without coordinating. Anything marked
**load-bearing** below is a breaking change if altered.

It is deliberately **not** a description of how the playground works. The
playground-side map — which playground feature calls which CP endpoint, the
`CpClient` methods, the scenario step types that drive them, discovery and
failover, timeouts, and the degradation mechanics — is owned by and documented
in the playground repo: [`aitp-playground/docs/control-plane.md`][pg-cp] (see
its "CP endpoints the playground uses", "Event ingest" and "What lives where"
sections). This page links there rather than restating it, exactly as that page
links back here for endpoint shapes.

## The one invariant: everything degrades gracefully

**No CP call is required for a scenario to run.** The playground treats every CP
call as optional and best-effort; when the CP is not configured or a call fails,
the run still completes, losing only the CP-backed discovery, telemetry, and
inspection features. The fallback values and client timeouts are the
playground's concern; see [`control-plane.md`][pg-cp].

The CP obligation this implies — and the only part of the invariant this repo
owns — is: **return 2xx quickly** on the hot-path calls (discovery and
`POST /api/events`) and never require the playground to send anything it can't
cheaply produce.

[pg-cp]: https://github.com/agentidentitytrustprotocol/aitp-playground/blob/main/docs/control-plane.md

## Load-bearing endpoints

These two are the historical core and the ones a run's *behavior* can depend on.
Breaking either is a breaking change.

### 1. Capability discovery — `GET /api/registry/agents?capability=<cap>`

Public (no API key). Used for the playground's `cp_registry` discovery mode: it
takes the first returned agent's handshake endpoint and derives the peer's
manifest URL from it. How the playground picks the capability and falls back
when nothing matches is described in
[`control-plane.md` § Discovery][pg-cp].

```json
{ "agents": [ { "aid": "aid:pubkey:ed25519:...", "handshakeEndpoint": "http://agent-host:8101/aitp", "offeredCaps": ["demo.echo"], "status": "active", "namespace": "default", "...": "..." } ] }
```

The CP **must** include `handshakeEndpoint` on every record and keep the
`agents` envelope. (Full record shape:
[`api.md`](api.md#get-apiregistryagents).) See
[Known contract drift](#known-contract-drift) — the playground currently reads a
different key name.

### 2. Telemetry ingestion — `POST /api/events`

Requires an API key when `API_KEYS` is set. Body is `{ "events": [...] }`. The
playground does **not** wrap fields in `payload` or use the CP's camelCase
envelope: each event is a flat object made of the playground's own fields. A
typical batch mixes runner events and agent-reported events (field set from the
playground's `RunEvent` model in `src/aitp_playground/runner/context.py` and
`emit_event` in `agents/base/telemetry.py`):

```json
{ "events": [
  { "type": "trust.established", "ts": 1779710400.123, "run_id": "run-abc",
    "initiator": "researcher", "target": "writer", "grants": ["demo.echo"] },
  { "type": "handshake.complete", "ts": 1779710400.456, "run_id": "run-abc",
    "agent_id": "writer", "session_id": "uuid", "peer_aid": "aid:pubkey:ed25519:...",
    "grants": ["demo.echo"], "role": "responder",
    "tct": { "token": "<compact JWS>", "claims": { "...": "..." } } }
] }
```

Runner events also carry the other `RunEvent` fields, mostly `null`. The CP
normalizes each event as described in
[`events.md` § Ingest normalization](events.md#ingest-normalization). The parts
of that normalization this contract relies on are **load-bearing**:

- **Missing `payload` ⇒ the whole raw event is the payload.** This is how
  `tct`, `peer_aid` and the other flat fields reach the projections — e.g. the
  TCT projection reads `payload.tct` (see
  [`events.md` § TCT & delegation projection](events.md#tct--delegation-projection)).
- **`initiator` / `target` → `aidA` / `aidB`**, `run_id` → `runId`,
  `session_id` → `sessionId`.
- **Numeric `ts` is a Unix epoch** (the playground sends float seconds).
- Unknown event types are stored and streamed, never rejected.

`aidA` / `aidB` are stored as given and not validated as AIDs; the playground's
runner events put scenario agent ids (e.g. `researcher`) there, so those rows
carry agent ids, not AIDs. The agent-reported `handshake.complete` /
`handshake.started` events carry no `initiator`/`target`.

**Duplicates.** The playground sends no `Idempotency-Key`. When a run uses the
mid-run flush (the `cp_delegation_tree` step) and then the post-run batch
re-sends the run's full event log, the re-sent events are recognised as
duplicates and stored, streamed and delivered to webhooks **once**: every
playground event (RunEvent or agent telemetry dict) carries a `ts`, both the mid-run flush and the end-of-run post send the same stored record, and the CP derives an event's id from
its content and the API key that sent it, so the same event re-sent with the
same key gets the same id (the second response reports them in `duplicates`).
This holds as long as the playground re-serializes an event identically and
uses the same `CP_API_KEY` for both posts. See
[`events.md` § Event ids and de-duplication](events.md#event-ids-and-de-duplication).

Batch limits still apply (see
[`api.md`](api.md#post-apievents-body)): an over-cap batch gets
`413 PAYLOAD_TOO_LARGE`, not a fire-and-forget 2xx, so a producer with more
events than the per-batch cap must split them. An individual event the CP
cannot store — most likely in practice a NUL character or a lone UTF-16
surrogate (e.g. model output truncated mid-emoji) in a flat event's exception
text or model output (the whole flat event is the payload), or an
over-long `session_id` — is **dropped on its own** and reported in the `200`
response's `dropped` / `errors[]`; the rest of the run's events are stored (see
[`events.md` § Per-item limits](events.md#per-item-limits)). The playground does
not read the response, so such a drop is visible only there, in the CP's warn
log, and in the `events_dropped_total` metric.

## Endpoints the playground depends on

The CP endpoints the playground currently calls, with the **CP-side contract**
for each — the request keys it sends and response keys it reads that must not
break. The playground-internal mapping (client method, the scenario step type or
API proxy that drives each call) lives in [`control-plane.md`][pg-cp]; treat that
as the source of truth for the current call list, and this table as the CP's
record of what those calls depend on.

| Endpoint | Load-bearing? | CP-side contract the playground relies on |
|---|---|---|
| `GET /api/registry/agents?capability=` | **yes** | public; `agents[]` with a handshake endpoint (see above) |
| `POST /api/events` | **yes** | flat events, normalization above; 2xx quickly |
| `POST /api/revocation/entries` | no | body `{jti, reason?}`; `jti` must be a UUID. Re-posting an already revoked `jti` returns `201` again (the deny-list entry is unchanged, but a new `tct.revoked` event is emitted) |
| `GET /.well-known/aitp-revocation-list` | no | fetched by the playground's **agents**, not its service; see [Revocation list](#revocation-list) |
| `GET /api/events/history` | no | params `run_id`, `aid`, `type`, `limit`; reads `events` |
| `GET /api/sessions` | no | params `run_id`, `aid`, `status`; reads `sessions`. Honours `limit` (default 200, max 1000) and `offset`; the playground sends `limit` |
| `GET /api/sessions/{id}/replay` | no | params `since`, `until`, `limit`; reads `events` |
| `POST /api/webhooks` | no | body `{url, events, secret?, active}`; `events: []` ⇒ all deliverable types |
| `DELETE /api/webhooks/{id}` | no | the playground treats `404` as success |
| `GET /api/tcts` | no | sends `sessionId` (camelCase), `active=true` as a string; reads `tcts` |
| `GET /api/delegations` | no | `root_jti` walks the tree; reads `delegations` |
| `GET /api/dashboard/overview` | no | ⚠️ param drift — see below |
| `GET /api/dashboard/agents` | no | reads `agents` |
| `GET /api/trust-anchors` | no | reads `trustAnchors`; `namespace` filter |
| `POST /api/trust-anchors` | no | body `{issuerUrl, namespace?, jwksUrl?, label?}` |
| `GET /api/pinned-keys` | no | reads `pinnedKeys`; `namespace` filter |
| `POST /api/pinned-keys` | no | body `{aid, pubkey, namespace?, label?}` |

The playground also **receives** webhook deliveries the CP POSTs to a run-scoped
URL it registers via `POST /api/webhooks`. The CP signs those with
`X-AITP-Signature` — see [`events.md` § Webhook-deliverable events](events.md#webhook-deliverable-events)
and [`api.md` § Webhooks](api.md#webhooks).

Enrollment (`POST /api/registry/enroll` → `POST /api/registry/agents`) is **not**
called by the playground service — agents enroll themselves; the playground only
discovers them.

### Revocation list

`GET /.well-known/aitp-revocation-list` is public; the CP ignores any
`Authorization` header on it (the playground's agents send their configured CP
API key as a Bearer token when one is set). The response is the signed envelope
defined by [RFC-AITP-0008 §1.5][rfc8-15], signed with the CP's own identity.
The playground's agents verify that signature against the AID pinned in their
`CP_AID` setting and discard any snapshot that does not verify — there is no
unsigned or alternative-shape fallback. So the CP **must** keep serving exactly
the RFC-AITP-0008 §1.5 envelope, and its signing identity (`CP_AID_SEED_HEX`,
see [`operations.md` § Identity](operations.md#identity)) must stay stable for
pinned agents to keep accepting it.

[rfc8-15]: https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0008-revocation.md

## Known contract drift

Surfaced while reconciling this doc with the live client — fix on whichever side
owns the field:

- **Discovery key casing.** The CP returns `handshakeEndpoint` (camelCase); the
  playground's `cp_registry` discovery reads `handshake_endpoint` (snake_case)
  from each record. The key is therefore never found, and the playground falls
  back to its local handshake address even when the CP returns a match. Fix on
  either side: read `handshakeEndpoint` in the playground, or have the CP also
  emit the snake_case key. Tracked in aitp-playground.
- **Dashboard window is ignored.** The playground sends `?window=<window>` to
  `GET /api/dashboard/overview`, but the CP route reads **`?range=`**. The CP
  therefore always returns the default `24h` window regardless of what the
  playground requests. Fix on either side: rename the playground param to
  `range`, or have the CP accept `window` as an alias.

## Configuration mapping

| Playground setting | CP side | Notes |
|---|---|---|
| `CP_BASE_URL` | the CP's base URL | Empty ⇒ the playground's CP integration is disabled. |
| `CP_API_KEY` | one of `API_KEYS` | Sent as `Authorization: Bearer` when set. If unset on the playground but `API_KEYS` is set on the CP, the gated calls get `401` (and degrade). With `API_KEYS` empty outside production the CP accepts unauthenticated calls (see [`api.md` § Authentication](api.md#authentication)). |
| `CP_AID` | the CP's own AID | Must equal the CP's AID — `manifest.aid` in the envelope served at `/.well-known/aitp-manifest` (derived from `CP_AID_SEED_HEX`). Empty or wrong ⇒ the playground's agents discard every revocation snapshot. |

Timeouts and other client tuning are playground-owned; see
[`control-plane.md`][pg-cp] and the playground's
[`getting-started.md` § Configure][pg-gs-cfg].

## Versioning

The CP follows semver; this contract is **stable under v0.x** — additions are
allowed, breaking changes need coordination.

- Adding optional fields to the agent record or event envelope: non-breaking.
- Renaming/removing `handshakeEndpoint` or `aid` on the agent record, or dropping
  the ingest aliases the playground relies on (`initiator`, `target`,
  `session_id`, `run_id`, numeric `ts`, raw event as `payload`): **breaking**
  (load-bearing).
- Changing auth on discovery or `/api/events`: **breaking**.
- Changing the revocation-list envelope or rotating the CP identity: breaks
  revocation propagation for agents pinned to the old `CP_AID`.
- Renaming response keys the client reads (`agents`, `events`, `sessions`, `tcts`, `delegations`, `trustAnchors`, `pinnedKeys`) or request keys it sends (`issuerUrl`, `jwksUrl`, `pubkey`, `sessionId`, `jti`): breaking for that feature — coordinate.

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
export CP_AID="$(curl -s http://localhost:4000/.well-known/aitp-manifest | jq -r .manifest.aid)"
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
[pg-gs-cfg]: https://github.com/agentidentitytrustprotocol/aitp-playground/blob/main/docs/getting-started.md#configure
