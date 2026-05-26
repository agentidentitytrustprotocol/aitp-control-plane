# Playground integration contract

This document describes the exact API surface that [`aitp-playground`](https://github.com/agentidentitytrustprotocol/aitp-playground) depends on. It is the integration contract — changes to anything described here must be coordinated with the playground.

## Dependency surface

The playground talks to the CP through `aitp_playground/cp_client/client.py`. It uses **two** endpoints. Both calls degrade gracefully — if `cp_base_url` is empty or any call fails, the playground falls back to static discovery and discards telemetry without erroring.

### 1. Capability discovery

```http
GET /api/registry/agents?capability=<string>
Authorization: Bearer <cp_api_key>   # optional
```

Response (200):
```json
{
  "agents": [
    {
      "aid": "did:pubkey:z:...",
      "displayName": "researcher-1",
      "handshakeEndpoint": "http://agent-host:8101/aitp",
      "offeredCaps": ["demo.echo"],
      "manifestExpiresAt": "2026-06-01T00:00:00Z",
      "status": "active",
      "org": "acme",
      "cloud": "aws-us-east-1",
      "namespace": "default"
    }
  ]
}
```

The playground reads `agents[0].handshakeEndpoint` to point its peer-discovery TrustOrchestrator at the first matching agent. The CP **must** include `handshakeEndpoint` on every record.

If the playground sets `trust.discovery: cp_registry` in the scenario YAML and this call returns `[]` or 5xx, the scenario fails over to `static`.

### 2. Telemetry ingestion

```http
POST /api/events
Content-Type: application/json
Authorization: Bearer <cp_api_key>   # optional
```

Body:
```json
{
  "events": [
    {
      "type": "handshake.completed",
      "ts": "2026-05-25T12:00:00.000Z",
      "aid_a": "did:pubkey:z:...",
      "aid_b": "did:pubkey:z:...",
      "session_id": "uuid",
      "run_id": "run-abc",
      "grants": ["demo.echo"],
      "payload": { "...": "..." },
      "playground": { "run_id": "run-abc", "scenario": "research-and-write" }
    }
  ]
}
```

Notes for the CP:

- **snake_case is canonical from the playground.** The CP normalizes `aid_a`/`aid_b`/`session_id`/`run_id` to camelCase internally; the wire format from the playground stays snake_case.
- The call is **fire-and-forget** from the playground side. The CP must:
  - Return 2xx quickly (the playground times out at `cp_timeout_ms`, default 5000).
  - Tolerate duplicate `id`s (the playground may retry; the CP uses `ON CONFLICT DO NOTHING` on the audit-events insert).
  - Tolerate unknown event types (record them as-is; do not 4xx).
- Response is `{ "ingested": <n> }`.

The playground does **not** depend on:
- Specific event types being recognized.
- The CP fanning out to webhooks (though it does — RFC-AITP-0009).
- The CP persisting fast — best-effort batches are fine.

## Configuration mapping

| Playground config | CP env var | Notes |
|---|---|---|
| `cp_base_url` | `CP_BASE_URL` | Playground points at the CP's public URL |
| `cp_api_key` | one of `API_KEYS` | Optional. If unset on the playground side and `API_KEYS` is set on the CP, the playground gets 401 on both endpoints. In dev with `API_KEYS=` the CP accepts unauthenticated calls. |
| `cp_timeout_ms` | n/a | Client-side timeout, default 5000 |

## Versioning

The CP follows semver. The playground contract above is **stable** under v0.x — additions are allowed, breaking changes need coordination. Specifically:

- Adding new optional fields to the agent record or event envelope: non-breaking.
- Renaming or removing `handshakeEndpoint`, `aid`, `aid_a`, `aid_b`, `session_id`, `run_id`: breaking; coordinate with playground.
- Changing the auth model on these two endpoints: breaking; coordinate.

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

If the events show up, the integration is healthy.
