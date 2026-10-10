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
| `id` | always a fresh server-generated UUID — a client-supplied `id` is **discarded** | — |
| `type` | `type` (string) | `"unknown"` |
| `ts` | `ts` — an ISO-8601 string, or a numeric Unix epoch (values below 10¹² are read as seconds, otherwise milliseconds); stored as ISO-8601 UTC | ingest time (also used when `ts` is unparseable) |
| `aidA` | `aidA`, `aid_a`, `initiator` | none |
| `aidB` | `aidB`, `aid_b`, `target` | none |
| `sessionId` | `sessionId`, `session_id` | none |
| `runId` | `runId`, `run_id`, `playground.run_id` | none |
| `grants` | `grants`, only if it is an array of strings | none |
| `payload` | `payload` if it is an object; otherwise the **whole raw event object** | — |
| `source` | `source` | `"playground"` |

Non-object entries in the batch are skipped. `source` is `cp` for CP-emitted
events.

## How an ingested event is handled

For each `POST /api/events` batch, in order:

1. **Persisted** to `audit_events`. Because every event gets a fresh server-side
   `id`, re-sending the same batch creates **new rows** — there is no per-event
   de-duplication. Only an `Idempotency-Key` header makes a retried batch a
   no-op (see [`api.md`](api.md#idempotency)).
2. **Last-seen touched:** every distinct AID appearing as `aidA` or `aidB` in the
   batch has `agents.last_seen_at` set to the ingest time (best-effort; AIDs not
   in the registry are ignored).
3. Per event: **published** to the in-memory bus (→ live `GET /api/events/stream`
   subscribers), then **projected** if its `type` is recognized by a monitor
   (below). Unknown types are stored and streamed but project nothing — never a `4xx`.
4. **Dispatched** to webhooks if its `type` is in the deliverable set (below).

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
- **Retries duplicate unless keyed.** Send an `Idempotency-Key` header if you may
  re-send a batch; client-supplied event `id`s are ignored.
- **Match type names exactly** (`handshake.complete`, not a variant) for the
  session/TCT/webhook path.
- **Batch within limits:** see [`api.md`](api.md#post-apievents-body) for the
  request-size, events-per-batch and per-event `payload` caps.
