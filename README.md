# AITP Control Plane

A backend service that hosts the registry, audit log, revocation list, and webhook fan-out for an [AITP (Agent Identity Trust Protocol)](https://github.com/agentidentitytrustprotocol/aitp-rs) deployment.

This service is **API-only**. It ships no UI. Operators consume the JSON endpoints directly or front them with a separate UI app.

## What this is

A coordination surface for AITP agents. It **observes and audits**; it does not sit in the trust path.

- **Agent registry** — agents self-enroll with a short-lived token; the CP caches their manifest and offered capabilities so peers can discover them.
- **Audit event store** — every handshake, delegation, and revocation reported by agents is persisted and streamed live over SSE.
- **Revocation list** — operators record revoked TCT JTIs; the CP signs and serves a periodically-refreshed revocation snapshot at `/.well-known/aitp-revocation-list` per RFC-AITP-0008.
- **Webhook outbox** — subscribers receive HMAC-signed deliveries for selected event types, with retries.
- **Telemetry sink** — `POST /api/events` accepts batched run telemetry from the [aitp-playground](https://github.com/agentidentitytrustprotocol/aitp-playground) and any other AITP runner.

## What this is NOT

- **Not a TCT issuer.** AITP is bilateral peer-to-peer trust. Agents issue TCTs to each other in a four-message handshake, audience-bound and `cnf`-bound to the holder's Ed25519 key. A central issuer would break the protocol's threat model.
- **Not a gateway or proxy.** Handshake traffic is agent-to-agent. The CP never sees handshake payloads.
- **Not a UI.** No dashboard, no admin pages. Build one separately against the JSON API if you need one.

## Quickstart

```bash
# 1. Postgres
docker compose up -d postgres

# 2. Environment
cp .env.example .env
# Generate secrets:
node -e "console.log('CP_AID_SEED_HEX=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('ENROLLMENT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"

# 3. Install + migrate + run
npm install
npm run db:migrate
npm run dev
```

The service listens on `http://localhost:4000`. Probe it:

```bash
curl http://localhost:4000/api/health
curl http://localhost:4000/.well-known/aitp-manifest
```

## Configuration

All settings are environment variables. See `.env.example` for the canonical list.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `4000` | HTTP listen port |
| `CP_BASE_URL` | no | `http://localhost:4000` | Public base URL used in the CP's own manifest |
| `CP_AID_SEED_HEX` | **prod** | empty (regenerated each boot) | 32-byte hex seed for the CP's Ed25519 identity. Without it, the CP AID changes on restart. |
| `DATABASE_URL` | yes | `postgres://postgres:postgres@localhost:5432/aitp_control_plane` | Postgres connection string |
| `DB_POOL_MAX` | no | `20` | Connection pool size |
| `API_KEYS` | **prod** | empty | Comma-separated allowlist. Empty in prod returns 503 on gated routes (fail-safe). Empty in dev disables auth. |
| `ENROLLMENT_SECRET` | yes | empty | HMAC secret for one-time enrollment tokens |
| `CORS_ORIGIN` | **prod** | `http://localhost:3000` | Allowed origin for the JSON API. Falls back to `*` with a warning in prod if unset. |
| `REVOCATION_LIST_TTL_SECS` | no | `3600` | TTL on the signed revocation snapshot |
| `WEBHOOK_RETRY_ATTEMPTS` | no | `3` | Per-delivery retry budget |
| `WEBHOOK_URL_ALLOWLIST` | no | empty | Comma-separated host allowlist for webhook targets. Empty = any public host (private/loopback/link-local ranges are always rejected as SSRF). Leading `.` matches subdomains. |
| `CLIENT_IP_HEADER` | **prod** | empty | Trusted edge header carrying the real client IP (e.g. `cf-connecting-ip`). Takes precedence over `X-Forwarded-For` for rate-limit keying. |
| `TRUSTED_PROXY_HOPS` | **prod** | `0` | Trusted proxies appending to `X-Forwarded-For`; client IP is read this many entries from the right. `0` = XFF untrusted (leftmost is spoofable). |
| `MAX_AUDIT_EVENTS_MEMORY` | no | `500` | In-memory SSE backlog size |
| `LOG_LEVEL` | no | `info` | Pino log level: trace / debug / info / warn / error / fatal |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | Window over which the per-min rate limits accumulate |

## API surface

See [`docs/api.md`](docs/api.md) for the prose reference and [`openapi.yaml`](openapi.yaml) for the machine-readable schema. High-level groups:

- Public discovery: `/api/health`, `/api/readyz`, `/api/metrics`, `/.well-known/aitp-manifest`, `/.well-known/aitp-revocation-list`
- Registry: `/api/registry/enroll`, `/api/registry/agents`, `/api/registry/agents/:aid`, `/api/registry/agents/:aid/manifest`, `/api/registry/agents/:aid/export`
- Sessions: `/api/sessions`, `/api/sessions/:sessionId`, `/api/sessions/:sessionId/export`, `/api/sessions/:sessionId/replay`
- Events: `POST /api/events`, `GET /api/events/history`, `GET /api/events/stream` (SSE)
- Audit: `/api/audit`
- Webhooks: `/api/webhooks`, `/api/webhooks/:id`, `/api/webhooks/:id/circuit-breaker`, `/api/webhooks/:id/circuit-breaker/reset`
- Revocation: `/api/revocation/entries`
- Dashboard JSON: `/api/dashboard/overview`, `/api/dashboard/agents`
- TCT lifecycle: `/api/tcts` (observed; CP does not issue)
- Delegation chains: `/api/delegations`
- Trust store: `/api/trust-anchors`, `/api/trust-anchors/:id`, `/api/pinned-keys`

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  AITP Control Plane (this repo)                     │
│  Next.js 15 route handlers + Postgres               │
│                                                     │
│  ┌──────────┐  ┌────────────┐  ┌────────────────┐   │
│  │ Registry │  │ Audit / SSE│  │ Webhook outbox │   │
│  └──────────┘  └────────────┘  └────────────────┘   │
│  ┌──────────────┐  ┌──────────────────────────┐     │
│  │ Revocation   │  │ /.well-known + CP AITP   │     │
│  │  list        │  │  identity (Ed25519)      │     │
│  └──────────────┘  └──────────────────────────┘     │
└────────────────┬────────────────────────────────────┘
                 │ JSON over HTTP
   ┌─────────────┴──────────────┐
   ▼                            ▼
┌──────────────────┐    ┌─────────────────────────┐
│ aitp-playground  │    │ Agents (aitp-rs / py)   │
│  (scenario       │    │  - publish manifests    │
│   runner)        │    │  - 4-msg handshake p2p  │
└──────────────────┘    └─────────────────────────┘
```

The CP **never** participates in a handshake. Agents talk to each other directly. They optionally:

1. **Discover** peers via `GET /api/registry/agents?capability=demo.echo`
2. **Report** events (handshake completed, delegation issued, TCT revoked) via `POST /api/events`
3. **Enroll** as a known agent via `POST /api/registry/enroll` → `POST /api/registry/agents`

## Integration with aitp-playground

See [`docs/integration-playground.md`](docs/integration-playground.md) for the exact contract.

## Development

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # jest unit
npm run test:integration  # jest against real Postgres on :5433
```

Bring up the test database:

```bash
docker compose up -d postgres-test
```

The integration suite expects `DATABASE_URL=postgres://postgres:postgres@localhost:5433/aitp_control_plane_test`.

## Project layout

```
src/
  app/api/        Next.js App Router route handlers (the only thing rendered)
  lib/
    audit/        Event store, in-memory SSE bus
    db/           Drizzle schema + connection
    identity/     CP's own AITP keypair + manifest
    registry/     Agent CRUD, enrollment tokens, expiry job
    revocation/   Signed revocation snapshot producer
    sessions/     Handshake-session monitor (from audit events)
    webhooks/     Outbox dispatcher, HMAC signing, retry reaper
drizzle/          SQL migrations
docs/             API reference + integration contracts
plans/            Forward-looking roadmap
```

## Deployment

CI builds a multi-arch container image and publishes it to GHCR
(`ghcr.io/agentidentitytrustprotocol/aitp-control-plane`) on every push to
`main`. The `aitp` SDK is the published
[`@agentidentitytrustprotocol/aitp`](https://www.npmjs.com/package/@agentidentitytrustprotocol/aitp)
npm package, so the image and CI are self-contained — no sibling `aitp-rs`
checkout or Rust toolchain required.

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for the full CI/CD pipeline and a
step-by-step Railway deployment guide.

## License

See [`LICENSE`](LICENSE).
