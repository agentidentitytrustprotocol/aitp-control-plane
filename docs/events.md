# Event reference

The control plane is event-sourced over a single append-only store. Agents and
runners `POST /api/events`; the CP persists every event, fans a subset out to
webhooks, and **projects** a subset into derived tables (sessions, TCTs,
delegations). The CP itself also emits events for registry actions.

This document is the canonical list of event types and how the CP treats each.
For the wire envelope and ingest limits see [`api.md`](api.md#events); for the
tables these events populate see [`data-model.md`](data-model.md).

## Envelope

Every persisted event (`audit_events` row, and the shape streamed over SSE) is:

```json
{
  "id": "uuid",
  "type": "handshake.complete",
  "ts": "2026-05-25T12:00:00.000Z",
  "aidA": "aid:pubkey:ed25519:...",
  "aidB": "aid:pubkey:ed25519:...",
  "sessionId": "uuid-or-base64url",
  "runId": "run-123",
  "grants": ["demo.echo"],
  "payload": { "...": "..." },
  "source": "playground"
}
```

### Ingest normalization

Each ingested event is normalized before it is stored:

| Field | Taken from (first non-empty wins) | Default |
|---|---|---|
| `id` | always server-assigned: derived from the event's content when it has a valid `ts`, random otherwise (see [Event ids and de-duplication](#event-ids-and-de-duplication)); a client-supplied `id` is not used as the id (it is part of the hashed content) | — |
| `type` | `type` (string) | `"unknown"` |
| `ts` | `ts` — an ISO-8601 string, or a numeric Unix epoch (values below 10¹² are read as seconds, otherwise milliseconds); stored as ISO-8601 UTC | ingest time (also used when `ts` is unparseable or out of range: beyond ±8.64×10¹⁵ ms, or outside years 0001–9999) |
| `aidA` | `aidA`, `aid_a`, `initiator` | none |
| `aidB` | `aidB`, `aid_b`, `target` | none |
| `sessionId` | `sessionId`, `session_id` | none |
| `runId` | `runId`, `run_id`, `playground.run_id` | none |
| `grants` | `grants`, only if it is an array of strings | none |
| `payload` | `payload` if it is an object; otherwise the **whole raw event object** | — |
| `source` | `source` | `"playground"` |

Non-object entries in the batch are skipped. `source` is `cp` for CP-emitted
events.

### Per-item limits

After normalization, each item is checked against what `audit_events` can
store. An item that fails is **dropped** — not stored, streamed, projected or
dispatched — and reported in the response's `dropped` count and `errors[]`
(`{index, field, reason}`, at most 20; `index` is the item's position in the
array sent). The rest of the batch is ingested normally.

| Field | Limit (Unicode code points) |
|---|---|
| `type`, `source` | 128 |
| `aidA`, `aidB` | 512 |
| `sessionId`, `runId` | 255 |
| any of the above, every `grants` entry, every key and string value in `payload` | no NUL (U+0000) |
| every `grants` entry, every key and string value in `payload` | no lone (unpaired) UTF-16 surrogate — `jsonb` rejects it; surrogate pairs (emoji) are fine |
| `payload` | at most 64 levels of nesting |

The limits apply to the normalized field, whichever alias carried it
(`session_id` over 255 is reported as `sessionId`). The batch-level caps — 256
KiB body, 500 items, 65,536 characters per serialized payload — still reject the
**whole** batch with `413` (see [`api.md`](api.md#post-apievents-body)).

## How an ingested event is handled

For each `POST /api/events` batch, in order:

1. **Validated** per item ([Per-item limits](#per-item-limits)); dropped items
   take no further part in the steps below.
2. **Assigned an id and persisted** to `audit_events`. An event with a valid
   `ts` gets a content-derived id, so an event the same producer already sent
   is recognised as a **duplicate** and not stored again; duplicates inside one
   batch are collapsed first (see
   [Event ids and de-duplication](#event-ids-and-de-duplication)). The response
   reports `inserted` (new rows) and `duplicates`.
3. **Last-seen touched:** every distinct AID appearing as `aidA` or `aidB` in the
   batch has `agents.last_seen_at` set to the ingest time (best-effort; AIDs not
   in the registry are ignored).
4. Per event: **published** to the in-memory bus (→ live `GET /api/events/stream`
   subscribers) **if it was newly inserted**, then **projected** if its `type`
   is recognized by a monitor (below) — duplicates are projected too (the
   projections are idempotent, and re-running them repairs one that failed the
   first time). Unknown types are stored and streamed but project nothing —
   never a `4xx`.
5. **Dispatched** to webhooks if its `type` is in the deliverable set (below)
   **and it was newly inserted** — a re-sent event is never delivered twice.

## Event ids and de-duplication

Producers re-send events: the playground flushes a run's log mid-run and posts
the whole log again when the run ends (a prefix, then a superset), and any
client may retry a timed-out request. The CP recognises a re-sent event by its
id, which it derives from what was sent (**recipe v1**):

- **When the event has a valid `ts`** (parseable and in range — the cases where
  the stored `ts` is the client's, not the ingest time), its id is a
  deterministic UUID (RFC 9562 version 8) computed from SHA-256 over a
  version tag (`aitp-event:v1`), a fingerprint of the caller's API key (the
  bearer token), and the event object **exactly as received** in canonical form
  (object keys sorted, so key order on the wire does not matter; every other
  difference — another field, a different sub-millisecond `ts` digit, a
  different array order — makes a different event).
- **When it has no valid `ts`**, its id is random, as before: two identical
  ts-less events are most likely two real occurrences, and both are kept.

Consequences for producers and consumers:

- **Re-sending is safe.** The same producer sending the same event again —
  same API key, same content, a valid `ts` — gets the same id; the CP stores it
  once, streams it once and delivers it to webhooks once. The response's
  `duplicates` counts what was already there (`inserted` + `duplicates` =
  `ingested`), and `aitp_control_plane_events_duplicate_total` counts it in
  [`/api/metrics`](operations.md#metrics).
- **Producers are kept apart.** The key fingerprint is part of the id, so two
  API-key holders sending identical bytes get different ids: one producer can
  never suppress another's events. Callers that send **no** API key (a
  development deployment with empty `API_KEYS`) all share one empty
  fingerprint, so identical events with the same `ts` from different
  anonymous callers are merged. Rotating a key changes the ids of events sent
  after the rotation, so a re-send across a rotation is stored again.
- **Identical content means the same event.** Two genuinely distinct events
  from one key with identical content *and* identical `ts` are merged into one
  row, with no SSE frame or webhook for the second. A producer with
  second-resolution `ts` that can emit repeated identical events should add a
  distinguishing field (a sequence number or its own `id`; it is hashed as
  content).
- **Ids are deterministic.** An event's id — also the `id` in its SSE frame and
  in a webhook body's `payload` — is reproducible from its content and the
  producer's key. Do not treat it as a secret or as unguessable. A client
  `id` field is hashed as content, never used as the id.
- **At-most-once fan-out in one window.** The SSE publish and webhook enqueue
  happen after the INSERT commits. If the CP process dies between the two, the
  event is stored but never streamed or delivered — and a re-send is then a
  duplicate, so it is not fanned out either. The projections, by contrast, do
  re-run on a re-send.
- **Retention.** De-duplication works against rows that still exist. An event
  re-sent after the retention sweep deleted its row (`AUDIT_EVENTS_TTL_DAYS`,
  [operations.md](operations.md#data-retention)) is stored, streamed and
  delivered again.
- **Several replicas.** The `audit_events` primary key decides: exactly one
  concurrent INSERT of an id wins, and only that replica fans the event out.
- **`Idempotency-Key` still works as before** and complements this: a keyed
  retry replays the first response (with its original `inserted` /
  `duplicates`) without running the handler at all. Content-derived ids cover
  what a key cannot — a re-send whose batch differs (a superset), or a producer
  that sends no key.
- Rows written before recipe v1 keep their random ids; a future recipe would
  carry a new tag and yield ids disjoint from v1's.

## Recognized event types

### Sessions projection

Handled by the session monitor; drives the `handshake_sessions` table and the `/api/sessions` endpoints. A "session" here is the CP's reconstruction of a peer-to-peer [four-message handshake (RFC-AITP-0004)](https://agentidentitytrustprotocol.io/spec/mutual-handshake) from the events agents report — the CP is never a party to the handshake itself. Events without a `sessionId` are ignored by this monitor.

| Type | Effect | Key payload/fields read |
|---|---|---|
| `handshake.started` | Insert a session row, `status=started` (no-op if the session already exists) | `sessionId`, `aidA`, `aidB`, `runId`, `ts` (→ `started_at`), `payload.boundary` |
| `handshake.complete` | **Update** an existing session to `complete`, set `completed_at` + `grants` | `sessionId`, `ts`, `grants` |
| `handshake.failed` | **Update** an existing session to `failed`, set `error` (`completed_at` is not set) | `sessionId`, `payload.error` |

`handshake.complete` and `handshake.failed` only update a row created by an
earlier `handshake.started`; for an unknown `sessionId` they change nothing.

> **Naming:** the projection matches event types exactly. A producer that emits
> a near-miss name (e.g. `handshake.completed`) has the event stored and
> streamed, but no session is completed and no webhook fires.

### TCT & delegation projection

Handled by the TCT monitor; drives the `issued_tcts` and `delegations` tables and the `/api/tcts` and `/api/delegations` endpoints. The CP **observes** these — it never issues a TCT.

The claim names are defined by [RFC-AITP-0005 (TCT) §2](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0005-tct.md) and [RFC-AITP-0006 (Delegation) §2](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0006-delegation.md) / [RFC-AITP-0011 (multi-hop)](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0011-multihop-delegation.md); the CP does not redefine them. Each reported artifact is either a v0.2 wrapper `{ "token": "<compact JWS>", "claims": { ... } }` (the CP reads `claims`) or a flat v0.1-style object. v0.2 claim names are read first, with v0.1 names as fallbacks. Entries missing a required field are silently skipped.

| Type | Effect | Key payload/fields read |
|---|---|---|
| `tct.issued` | Project row(s) into `issued_tcts` (insert-if-absent by `jti`) | `payload.tcts[]` or `payload.tct`. Per TCT: `jti` (required, must be a UUID), `iss` (→ issuer; required), `sub` (→ subject; required), `aud` (→ audience; defaults to `sub`), `grants`, `iat`/`exp` (Unix seconds; `issued_at` defaults to the event `ts`), `cnf.jkt` → `binding_cnf` ([RFC-AITP-0005 §3](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0005-tct.md)). v0.1 fallbacks: `issuer`/`issuer_aid`, `subject`/`subject_aid`, `audience`/`audience_aid`, `issued_at`, `expires_at`, `binding.cnf`. |
| `handshake.complete` | Same projection, for TCTs carried on the completion event | as above, from `payload` |
| `tct.revoked` | Mark the TCT revoked; cascade-revoke descendant delegations (`revoked_reason=parent_revoked`) | `payload.jti` only (must be a UUID) |
| `delegation.issued` | Project a row into `delegations` (insert-if-absent by `jti`) | Claims from `payload.tct` or `payload.delegation` (wrapper or flat), else `payload` itself. See resolution order below. |
| `delegation.revoked` | Mark the delegation revoked (`revoked_reason=explicit`); cascade to descendants | `payload.jti` (must be a UUID) |

`delegation.issued` field resolution (first hit wins):

- **delegator / delegatee:** `payload.delegator_aid`/`delegator` (resp. `delegatee_aid`/`delegatee`), then the claims' `delegator`/`delegator_aid`/`iss` (resp. `delegatee`/`delegatee_aid`/`sub`).
- **parent_jti:** `payload.parent_jti`/`parentJti`/`src_jti`; then the claims' `src_jti`/`parent_jti`/`parentJti`; then the `src_jti` (or `parent_jti`) claim of the embedded grant voucher — `claims.voucher`, or for a multi-hop token the `voucher` of the first `claims.chain` entry. The CP only decodes the voucher to read this claim; it does not verify it. What the voucher is: [RFC-AITP-0005 §8](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0005-tct.md), [RFC-AITP-0006](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0006-delegation.md); chain encoding: [aitp-rs multi-hop delegation](https://github.com/agentidentitytrustprotocol/aitp-rs/blob/main/docs/multihop-delegation.md).
- **jti:** `payload.jti`/`child_jti`; then the claims' `jti`/`child_jti`; then a deterministic UUIDv5 over the wrapper's opaque `token` (single-hop tokens carry no `jti`, so re-reporting the same token maps to the same row).
- **scope:** the claims' `scope` (or `grants`). **issued_at / expires_at:** `iat`/`exp` (or `issued_at`/`expires_at`), `issued_at` defaulting to the event `ts`.
- Both `jti` and `parent_jti` must be UUIDs, and delegator/delegatee must be present, or the event projects nothing.

**Optional verification.** By default the CP projects reported claims as-is.
With `OBSERVED_ARTIFACT_VERIFICATION=warn|strict` it also verifies the signed
`token` of a v0.2 wrapper with the SDK before projecting `tct.issued` /
`handshake.complete` TCTs and `delegation.issued` (`warn` logs failures and
projects anyway; `strict` drops anything not verified, including reports with no
token). See [`operations.md`](operations.md#observed-artifact-verification).

### CP-emitted events

The CP emits these itself (`source: "cp"`) as a side effect of registry/revocation API calls — they are not ingested from outside.

| Type | Emitted by | `aidA` / payload |
|---|---|---|
| `agent.registered` | `POST /api/registry/agents` | `aidA` = agent AID; `payload.displayName`, `payload.namespace` |
| `agent.expired` | periodic expiry sweep, when a manifest TTL lapses | `aidA` = agent AID; `payload.reason="manifest_expired"`, `payload.displayName`, `payload.namespace` |
| `agent.deregistered` | `DELETE /api/registry/agents/:aid` | `aidA` = agent AID; `payload.reason="admin_deregister"` |
| `tct.revoked` | `POST /api/revocation/entries` | no `aidA`; `payload.jti`, `payload.reason` (may be `null`). Also drives the projection above. |

## Webhook-deliverable events

Only these types are fanned out to webhook subscribers. A subscription with an
empty `events` array receives **all** of them; otherwise it receives the
intersection.

- `agent.registered`
- `agent.expired`
- `agent.deregistered`
- `handshake.complete`
- `handshake.failed`
- `tct.revoked`

Any other type (including `tct.issued`, `delegation.*`, `handshake.started`, and
unknown types) is stored and streamable over SSE but **not** delivered to
webhooks.

Each delivery is a `POST` with `Content-Type: application/json` and the headers
`X-Aitp-Event: <type>`, `X-Aitp-Delivery: <delivery id>` and
`X-Aitp-Signature: sha256=<hex HMAC-SHA256 of the body under the webhook secret>`.
The body is:

```json
{ "deliveryId": "uuid", "eventType": "tct.revoked", "payload": { "...full event envelope..." }, "enqueuedAt": "ISO-8601" }
```

The body bytes and signature are fixed at enqueue time, so every retry of a
delivery is byte-identical. See [`api.md`](api.md#webhooks).

## Notes for event producers

- **Fire-and-forget is fine.** Unknown types are tolerated and never rejected.
- **Send a `ts` and re-send freely** (give genuinely repeated, otherwise identical events a distinguishing field). An event with a valid `ts` is
  de-duplicated per API key ([Event ids and de-duplication](#event-ids-and-de-duplication));
  one without `ts` is stored again on every send. An `Idempotency-Key` header
  additionally replays the exact first response for a retried request.
- **Match type names exactly** (`handshake.complete`, not a variant) for the
  session/TCT/webhook path.
- **Batch within limits:** see [`api.md`](api.md#post-apievents-body) for the
  request-size, events-per-batch and per-event `payload` caps.
