# AITP Control Plane

A backend service that hosts the registry, audit log, revocation list, and webhook fan-out for an [AITP (Agent Identity Trust Protocol)](https://github.com/agentidentitytrustprotocol/aitp-rs) deployment.

This service is **API-only**. It ships no UI. Operators consume the JSON endpoints directly or front them with a separate UI app.

## What this is

A coordination surface for AITP agents. It **observes and audits**; it does not sit in the trust path.

- **Agent registry** — agents self-enroll with a short-lived token; the CP caches their manifest and offered capabilities so peers can discover them.
- **Audit event store** — every handshake, delegation, and revocation reported by agents is persisted and streamed live over SSE.
- **Revocation list** — operators record revoked TCT JTIs; the CP signs and serves a periodically-refreshed revocation snapshot at `/.well-known/aitp-revocation-list` per [RFC-AITP-0008](https://agentidentitytrustprotocol.io/spec/revocation).
- **Webhook outbox** — subscribers receive HMAC-signed deliveries for selected event types, with retries.
- **Telemetry sink** — `POST /api/events` accepts batched run telemetry from the [aitp-playground](https://github.com/agentidentitytrustprotocol/aitp-playground) and any other AITP runner.

## What this is NOT

- **Not a TCT issuer.** AITP is bilateral peer-to-peer trust. Agents issue TCTs to each other in a four-message handshake, audience-bound and `cnf`-bound to the holder's Ed25519 key. A central issuer would break the protocol's threat model.
- **Not a gateway or proxy.** Handshake traffic is agent-to-agent. The CP never sees handshake payloads.
- **Not a UI.** No dashboard, no admin pages. Build one separately against the JSON API if you need one.

> This README and [`docs/`](docs/README.md) describe the **control plane**. The protocol itself (handshake, TCTs, identity, revocation) is normatively defined by the [AITP RFCs](https://agentidentitytrustprotocol.io/spec) and implemented by [`aitp-rs`](https://agentidentitytrustprotocol.io/implementation) — these docs link to the RFCs rather than restate them.

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

All settings are environment variables. `.env.example` is the canonical list;
[`docs/operations.md`](docs/operations.md) is the runbook explaining how the
rate-limit, retention, and telemetry subsystems behave.

**Core**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `4000` | HTTP listen port |
| `CP_BASE_URL` | no | `http://localhost:4000` | Public base URL used in the CP's own manifest |
| `CP_AID_SEED_HEX` | **prod** | empty (regenerated each boot) | 32-byte hex seed for the CP's Ed25519 identity. Without it, the CP AID changes on restart. |
| `DATABASE_URL` | yes | `postgres://postgres:postgres@localhost:5432/aitp_control_plane` | Postgres connection string |
| `DB_POOL_MAX` | no | `20` | Connection pool size |
| `API_KEYS` | **prod** | empty | Comma-separated allowlist. Empty in prod returns 503 on gated routes (fail-safe). Empty in dev disables auth. |
| `ENROLLMENT_SECRET` | yes | empty | Server-side HMAC secret for minting/verifying one-time enrollment tokens (callers never present it) |
| `CORS_ORIGIN` | **prod** | `http://localhost:3000` | Allowed origin for the JSON API. Defaults to `http://localhost:3000` if unset (including in prod) — set it to the UI plane origin. |
| `REVOCATION_LIST_TTL_SECS` | no | `3600` | TTL on the signed revocation snapshot |
| `LOG_LEVEL` | no | `info` | Pino log level: trace / debug / info / warn / error / fatal |

**Webhooks & SSE**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `WEBHOOK_RETRY_ATTEMPTS` | no | `3` | Per-delivery retry budget |
| `WEBHOOK_BREAKER_FAILURE_THRESHOLD` | no | `5` | Consecutive failures before an endpoint's circuit breaker opens |
| `WEBHOOK_BREAKER_RESET_MS` | no | `60000` | How long an open breaker waits before a half-open probe |
| `WEBHOOK_URL_ALLOWLIST` | no | empty | Comma-separated host allowlist for webhook targets. Empty = any public host (private/loopback/link-local ranges are always rejected as SSRF). Leading `.` matches subdomains. |
| `MAX_AUDIT_EVENTS_MEMORY` | no | `500` | In-memory SSE backlog replayed to each new subscriber |
| `MAX_SSE_CONNECTIONS` | no | `500` | Concurrent `/api/events/stream` cap per process; over-limit returns `503 SSE_CAPACITY` |

**Rate limiting** (in-memory, per-process — see [operations.md](docs/operations.md#rate-limiting))

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RATE_LIMIT_ENABLED` | no | `true` | Master switch for the limiter |
| `RATE_LIMIT_ENROLLMENT_PER_IP_MIN` | no | `5` | `/api/registry/enroll` per-IP budget |
| `RATE_LIMIT_PUBLIC_PER_IP_MIN` | no | `60` | Public routes per-IP budget |
| `RATE_LIMIT_API_KEY_PER_MIN` | no | `600` | Authenticated routes per-key budget |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | Window over which the per-min limits accumulate |
| `CLIENT_IP_HEADER` | **prod** | empty | Trusted edge header carrying the real client IP (e.g. `cf-connecting-ip`). Takes precedence over `X-Forwarded-For` for rate-limit keying. |
| `TRUSTED_PROXY_HOPS` | **prod** | `0` | Trusted proxies appending to `X-Forwarded-For`; client IP is read this many entries from the right. `0` = XFF untrusted (leftmost is spoofable). |

**Data retention** (periodic sweep, multi-instance safe — set any TTL to `0` to keep that table forever)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RETENTION_ENABLED` | no | `true` | Master switch for the retention sweep |
| `RETENTION_INTERVAL_MS` | no | `1800000` | Sweep cadence (30 min) |
| `RETENTION_BATCH_LIMIT` | no | `10000` | Max rows deleted per sweep |
| `AUDIT_EVENTS_TTL_DAYS` | no | `90` | `audit_events` retention |
| `WEBHOOK_DELIVERY_TTL_DAYS` | no | `14` | Terminal `webhook_deliveries` retention |
| `ADMIN_AUDIT_TTL_DAYS` | no | `365` | `admin_audit_log` retention |
| `IDEMPOTENCY_KEY_TTL_DAYS` | no | `7` | `idempotency_keys` retention |
| `EXPIRED_AGENT_GRACE_DAYS` | no | `30` | Grace before GC'ing operator-**deregistered** agents (`expired` rows are kept) |

**Telemetry (OpenTelemetry, off by default)**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OTEL_ENABLED` | no | `false` | Enable OTLP span export |
| `OTEL_SERVICE_NAME` | no | `aitp-control-plane` | Service name on exported spans |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | empty | OTLP HTTP collector endpoint (`/v1/traces` appended unless `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set) |

## API surface

See [`docs/`](docs/README.md) for the full documentation set — [`docs/api.md`](docs/api.md) (prose API reference), [`docs/events.md`](docs/events.md) (event types & projections), [`docs/data-model.md`](docs/data-model.md) (Postgres schema), and [`docs/operations.md`](docs/operations.md) (runbook) — plus [`openapi.yaml`](openapi.yaml) for the machine-readable schema. High-level groups:

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

See [`docs/integration-playground.md`](docs/integration-playground.md) for the exact contract, and [`docs/events.md`](docs/events.md) for the event types a runner can report (and which ones drive session/TCT projections and webhook fan-out).

## Development

```bash
npm run typecheck         # tsc --noEmit
npm run lint              # eslint
npm test                  # jest unit suite (no DB; coverage thresholds enforced with --coverage)
npm run test:integration  # jest against real Postgres on :5433
npm run test:conformance  # protocol-conformance subset of the integration suite
```

Unit tests (`*.test.ts`) are colocated with the code and mock the database;
integration tests (`*.integration.test.ts`) run against a real Postgres and
exercise routes/services end-to-end. CI runs both plus a production
`next build`, a dependency audit, and a Docker image build check on PRs.

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
    audit-log/    Admin-action audit log (who did what via the API)
    dashboard/    Aggregation queries behind /api/dashboard/*
    db/           Drizzle schema + connection
    http/         Request-body reading helpers
    identity/     CP's own AITP keypair + manifest
    registry/     Agent CRUD, enrollment tokens, expiry job
    revocation/   Signed revocation snapshot producer
    sessions/     Handshake-session monitor (from audit events)
    tcts/         Observed-TCT / delegation projection from audit events
    webhooks/     Outbox dispatcher, HMAC signing, circuit breaker, retry reaper
drizzle/          SQL migrations
docs/             Published docs: API reference, events, data model, ops runbook, integration contract
internal_docs/    Internal-only docs (deployment/CI) — NOT published to the website
```

## Deployment

CI builds a multi-arch container image and publishes it to GHCR
(`ghcr.io/agentidentitytrustprotocol/aitp-control-plane`) on every push to
`main`. The `aitp` SDK is the published
[`@agentidentitytrustprotocol/aitp`](https://www.npmjs.com/package/@agentidentitytrustprotocol/aitp)
npm package, so the image and CI are self-contained — no sibling `aitp-rs`
checkout or Rust toolchain required.

The full CI/CD pipeline and a step-by-step Railway deployment guide live in
[`internal_docs/`](https://github.com/agentidentitytrustprotocol/aitp-control-plane/tree/main/internal_docs)
— operational detail kept out of the published docs site.

## License

See [`LICENSE`](LICENSE).
