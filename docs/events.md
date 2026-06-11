# Event reference

The control plane is event-sourced over a single append-only store. Agents and
runners `POST /api/events`; the CP persists every event verbatim, fans a subset
out to webhooks, and **projects** a subset into derived tables (sessions, TCTs,
delegations). The CP itself also emits events for registry actions.

This document is the canonical list of event types and how the CP treats each.
For the wire envelope and ingest limits see [`api.md`](api.md#events); for the
tables these events populate see [`data-model.md`](data-model.md).

## Envelope

Every persisted event (`auditEvents` row, and the shape streamed over SSE) is:

```json
{
  "id": "uuid",
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

On ingest, snake_case keys (`aid_a`, `aid_b`, `session_id`, `run_id`) are
normalized to the camelCase columns above. `source` is `cp` for CP-emitted
events and whatever the runner sets otherwise (e.g. `playground`).

## How an ingested event is handled

1. **Persisted** to `auditEvents` with `ON CONFLICT (id) DO NOTHING` (safe to retry).
2. **Published** to the in-memory bus → live `GET /api/events/stream` subscribers.
3. **Projected** if its `type` is recognized by a monitor (below). Unknown types are stored and streamed but project nothing — never a `4xx`.
4. **Dispatched** to webhooks if its `type` is in the deliverable set (below).

## Recognized event types

### Sessions projection

Handled by the session monitor; drives the `handshakeSessions` table and the `/api/sessions` endpoints. A "session" here is the CP's reconstruction of a peer-to-peer [four-message handshake (RFC-AITP-0004)](https://agentidentitytrustprotocol.io/spec/mutual-handshake) from the events agents report — the CP is never a party to the handshake itself.

| Type | Effect | Key payload/fields read |
|---|---|---|
| `handshake.started` | Upsert a session row, `status=started` | `sessionId`, `aidA`, `aidB`, `runId`, `payload.boundary` |
| `handshake.complete` | Mark the session `complete`, record `completedAt` + `grants` | `sessionId`, `ts`, `grants` |
| `handshake.failed` | Mark the session `failed`, record the error | `sessionId`, `ts`, `payload.error` |

> **Naming nuance:** the projection keys on `handshake.complete` (no `d`). A
> runner that emits `handshake.completed` will have the event stored and
> streamed, but **no session is completed**. Emit `handshake.complete` if you
> want the session projection and webhook fan-out to fire.

### TCT & delegation projection

Handled by the TCT monitor; drives the `issuedTcts` and `delegations` tables and the `/api/tcts` and `/api/delegations` endpoints. The CP **observes** these — it never issues a TCT.

> The `tct.*` fields below (`issuer_aid`, `subject_aid`, `audience_aid`, `binding.cnf`, …) are the CP's projection of a peer-issued Trust Context Token; their meaning is defined by [RFC-AITP-0005 (TCT)](https://agentidentitytrustprotocol.io/spec/tct), and the `delegation.*` fields by [RFC-AITP-0006 (Delegation)](https://agentidentitytrustprotocol.io/spec/delegation) / [RFC-AITP-0011 (multi-hop)](https://agentidentitytrustprotocol.io/spec/multihop-delegation). The CP does not redefine them.

| Type | Effect | Key payload/fields read |
|---|---|---|
| `tct.issued` | Project a row into `issuedTcts` | `payload.tcts[]` or `payload.tct` — each with `jti`, `issuer_aid`, `subject_aid`, `audience_aid`, `grants`, `issued_at`, `expires_at`, `binding.cnf` |
| `handshake.complete` | Same projection, for TCTs carried on the completion event | as above, from `payload` |
| `tct.revoked` | Mark the TCT revoked; cascade-revoke descendant delegations | `payload.jti`, `payload.reason?` |
| `delegation.issued` | Project a row into `delegations` | `payload.jti` (or `child_jti`), `parent_jti`, `delegator_aid`, `delegatee_aid`, `scope`, `issued_at`, `expires_at` |
| `delegation.revoked` | Mark the delegation revoked (`reason=explicit`); cascade to descendants | `payload.jti` |

### CP-emitted events

The CP emits these itself (`source: "cp"`) as a side effect of registry/revocation API calls — they are not ingested from outside.

| Type | Emitted by | `aidA` / payload |
|---|---|---|
| `agent.registered` | `POST /api/registry/agents` | agent AID; `payload.displayName`, `payload.namespace` |
| `agent.expired` | periodic expiry sweep, when a manifest TTL lapses | agent AID; `payload.reason="manifest_expired"` |
| `agent.deregistered` | `DELETE /api/registry/agents/:aid` | agent AID; `payload.reason="admin_deregister"` |
| `tct.revoked` | `POST /api/revocation/entries` | the revoked `jti` (also drives the projection above) |

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
webhooks. Deliveries carry `X-AITP-Signature: sha256=<hmac>` over the canonical
body bytes; see [`api.md`](api.md#webhooks).

## Notes for event producers

- **Fire-and-forget is fine.** Ingest is best-effort and returns `2xx` quickly. Duplicate `id`s are de-duped; unknown types are tolerated.
- **Use `handshake.complete`** (not `completed`) for the session/TCT/webhook path.
- **Batch within limits:** ≤ 256 KiB per request, ≤ 64 KiB per event `payload` (see [`api.md`](api.md#post-apievents-body)).
- **Idempotency:** pass an `Idempotency-Key` header to make a retried batch a no-op at the request level, in addition to the per-event `id` de-dupe.
