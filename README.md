# AITP Control Plane

A backend service that hosts the registry, audit log, revocation list, and webhook fan-out for an [AITP (Agent Identity & Trust Protocol)](https://agentidentitytrustprotocol.io/spec) deployment ([spec repo](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol)).

This service is **API-only**. It ships no UI. Operators consume the JSON endpoints directly or front them with a separate UI app.

## What this is

A coordination surface for AITP agents. It **observes and audits**; it does not sit in the trust path.

- **Agent registry** — agents self-enroll with a short-lived token; the CP caches their manifest and offered capabilities so peers can discover them.
- **Audit event store** — every handshake, delegation, and revocation reported by agents is persisted and streamed live over SSE.
- **Revocation list** — operators record revoked TCT JTIs; the CP signs and serves a periodically-refreshed revocation snapshot at `/.well-known/aitp-revocation-list` per [RFC-AITP-0008](https://agentidentitytrustprotocol.io/spec/revocation).
- **Webhook outbox** — subscribers receive HMAC-signed deliveries for selected event types, with retries.
- **Telemetry sink** — `POST /api/events` accepts batched run telemetry from the [aitp-playground](https://github.com/agentidentitytrustprotocol/aitp-playground) and any other AITP runner.

## What this is NOT

- **Not a TCT issuer.** AITP is bilateral peer-to-peer trust: agents issue TCTs to each other during the [mutual handshake (RFC-AITP-0004)](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0004-mutual-handshake.md), and each TCT is audience-bound and `cnf`-bound to the holder's key ([RFC-AITP-0005 §3](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0005-tct.md#3-confirmation-claim-cnf); Ed25519 or P-256 per [RFC-AITP-0001 §5.3](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0001-core.md#53-agent-id-aid) / [§5.4.3](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0001-core.md#543-algorithm-tagged-signature-wire-format-jcs-profile-only)). A central issuer would break the protocol's threat model.
- **Not a gateway or proxy.** Handshake traffic is agent-to-agent. The CP never sees handshake payloads.
- **Not a UI.** No dashboard, no admin pages. Build one separately against the JSON API if you need one.

> This README and [`docs/`](docs/README.md) describe the **control plane**. The protocol itself (handshake, TCTs, identity, revocation) is normatively defined by the [AITP RFCs](https://agentidentitytrustprotocol.io/spec) and implemented by [`aitp-rs`](https://agentidentitytrustprotocol.io/implementation) — these docs link to the RFCs rather than restate them.

## Quickstart

Prerequisites: **Node.js 24** (the version CI and the `Dockerfile` use; `package.json` declares no `engines` field) and Docker for Postgres.

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
| `CP_AID_SEED_HEX` | **prod** | empty | 32-byte hex seed for the CP's own Ed25519 identity. Outside production an unset seed is replaced by a random one on every boot, so the CP AID changes on restart. In production it is **not** a boot check: the process starts, and `/api/health`, `/.well-known/aitp-manifest` and the revocation list answer `500` until it is set — see [operations.md](docs/operations.md#identity). |
| `DATABASE_URL` | yes | none at runtime (`.env.example` and `drizzle-kit` use `postgres://postgres:postgres@localhost:5432/aitp_control_plane`) | Postgres connection string. The runtime pool passes it straight to `pg`, so leaving it unset falls back to `pg`'s own `PG*` defaults rather than this URL. |
| `DB_POOL_MAX` | no | `20` | Connection pool size |
| `API_KEYS` | **prod** | empty | Comma-separated allowlist. Empty in prod returns 503 on gated routes (fail-safe). Empty in dev disables auth. |
| `ENROLLMENT_SECRET` | yes | empty | Server-side HMAC secret (**≥ 32 chars**) for minting/verifying one-time enrollment tokens (callers never present it). **Checked at boot: with `NODE_ENV=production` an unset or too-short value makes the process print one fatal line and exit 1** — so a bad value fails the deploy instead of deploying green. Outside production it warns once at boot and starts, and both `POST /api/registry/enroll` and `POST /api/registry/agents` then return 503 for every request. Deliberately not checked by `/api/readyz` — see [operations.md](docs/operations.md#health-readiness--graceful-shutdown). |
| `CORS_ORIGIN` | **prod** | `http://localhost:3000` | Allowed origin for the JSON API. Defaults to `http://localhost:3000` if unset (including in prod) — set it to the UI plane origin. |
| `REVOCATION_LIST_TTL_SECS` | no | `3600` | Validity window (`expires_at`) of each signed revocation list. Independent of how often the list is rebuilt: each process re-reads the DB at most every 60 s (sooner on that replica after a revocation is recorded) — see [operations.md](docs/operations.md#revocation-list). |
| `REVOCATION_FAIL_MODE` | no | `fail_closed` | What the revocation list does when the DB read fails. `fail_closed` answers `503 REVOCATION_UNAVAILABLE`; `serve_stale` re-serves the last successfully-read list for up to `REVOCATION_MAX_STALENESS_SECS`, then `503`. It never signs an empty list. Unrecognised values mean `fail_closed`. |
| `REVOCATION_MAX_STALENESS_SECS` | no | `300` | `serve_stale` only: max age of the re-served list, clamped to `REVOCATION_LIST_TTL_SECS`. |
| `LOG_LEVEL` | no | `info` in production, `debug` otherwise | Pino log level: trace / debug / info / warn / error / fatal. Outside production logs go through `pino-pretty`; in production they are JSON. |
| `NODE_ENV` | **prod** | unset (`next start` and the image set `production`) | Every production safeguard keys on the exact (trimmed) value `production`: `API_KEYS` fail-closed, fatal `ENROLLMENT_SECRET` check, required `CP_AID_SEED_HEX`, https-only webhook URLs, JSON logs. Any value other than `production`, `development` or `test` logs an error at boot naming what is inactive — set `production` for staging too. See [operations.md](docs/operations.md#authentication--exposure). |

**Webhooks & SSE**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `WEBHOOK_RETRY_ATTEMPTS` | no | `3` | Per-delivery retry budget |
| `WEBHOOK_BREAKER_FAILURE_THRESHOLD` | no | `5` | Consecutive failures before an endpoint's circuit breaker opens |
| `WEBHOOK_BREAKER_RESET_MS` | no | `60000` | How long an open breaker waits before a half-open probe |
| `WEBHOOK_URL_ALLOWLIST` | no | empty | Comma-separated host allowlist for webhook targets. Empty = any public host (private/loopback/link-local ranges are always rejected as SSRF). Leading `.` matches subdomains. |
| `MAX_AUDIT_EVENTS_MEMORY` | no | `500` | Size of the per-process in-memory event backlog. A new `/api/events/stream` subscriber is replayed at most the **last 100** of it (then filtered). Unrelated to `GET /api/sessions/:sessionId/replay`, which reads Postgres (default 1000, max 10000 events). |
| `MAX_SSE_CONNECTIONS` | no | `500` | Concurrent `/api/events/stream` cap per process; over-limit returns `503 SSE_CAPACITY` |
| `SSE_HEARTBEAT_MS` | no | `15000` | Interval between `: heartbeat` frames on an open stream, and the `retry:` reconnect hint sent in the connect prelude. Tune below your edge's idle timeout — see [operations.md](docs/operations.md#keepalive-sse_heartbeat_ms). Clamped to 1000-2147483647 ms; read at boot. |

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

**Trust-anchor JWKS cache** (background refresh of `trust_anchors.jwks_cache`, served at `GET /api/trust-anchors/:id/jwks`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JWKS_REFRESH_ENABLED` | no | `true` | Master switch for the refresher |
| `JWKS_REFRESH_INTERVAL_MS` | no | `900000` | Pass cadence (15 min; floor 1 s) |
| `JWKS_STALE_AFTER_MS` | no | `3600000` | An anchor is refreshed when its cache is missing or older than this |
| `JWKS_FETCH_TIMEOUT_MS` | no | `10000` | Per-request timeout for discovery and JWKS fetches |

**Observed-artifact verification**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OBSERVED_ARTIFACT_VERIFICATION` | no | `off` | `off` \| `warn` \| `strict`. Verify the signed token in reported TCT/delegation telemetry before projecting it. `warn` logs failures; `strict` drops anything unverified (including claims-only reports). Unknown values fall back to `off`. See [operations.md](docs/operations.md#observed-artifact-verification). |

**Data retention** (periodic sweep, multi-instance safe — set any TTL to `0` to keep that table forever). The retention sweep, the agent-expiry job and the webhook retry reaper start **lazily on the first `POST /api/events`** a process receives, not at boot; a process that never ingests never runs them. (The JWKS refresher above is the exception: it starts at boot.)

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
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | no | empty | OTLP/HTTP traces URL. Takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | empty | Fallback OTLP/HTTP URL. Whichever of the two is set is passed to the exporter **verbatim as the full URL** — `/v1/traces` is **not** appended, so include it (e.g. `http://otel-collector:4318/v1/traces`). With neither set: `http://localhost:4318/v1/traces`. See [operations.md](docs/operations.md#observability). |

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
│  Next.js 16 route handlers + Postgres               │
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
npm run verify:gate       # build, boot, and assert the request gate (auth/CORS/rate limit) over HTTP
npm run verify:image      # build the Docker image and verify the shipped artifact (needs Docker)
npm run verify:sse        # SSE streaming contract against the shipped image (needs Docker)
npm run db:generate       # drizzle-kit: generate a migration from src/lib/db/schema.ts
npm run db:migrate        # drizzle-kit: apply migrations to DATABASE_URL
npm run db:studio         # drizzle-kit: browse the database
```

Unit tests (`*.test.ts`) are colocated with the code and mock the database;
integration tests (`*.integration.test.ts`) run against a real Postgres and
exercise routes/services end-to-end. CI runs both plus a production
`next build`, a dependency audit, a Docker image build check on PRs, and
`npm run verify:image` — which builds the standalone image and then asserts, first
statically and then against the artifact running on an ephemeral Postgres, that the
native NAPI and traced-external paths resolve inside it, that the request gate is
really **attached** (the one thing `next start` cannot show for a standalone build),
that **the image's compiled gate is byte-identical to the reviewed one** (an equality
pin, after five successive attempts to establish the same thing by probing the gate's
behaviour were each defeated), that the revocation list's signature verifies
two independent ways, that CORS comes from the runtime environment rather than the
value baked at build time, and that the `OTEL_ENABLED=true` path loads and
instruments. **Publishing to GHCR is gated on it**, so an unverified image cannot
ship. An arm64 arm of the same harness is opt-in from the Actions tab. A summary is
in [operations.md](docs/operations.md#verifying-the-shipped-image); the per-check
index is [`internal_docs/IMAGE-HARNESS.md`](https://github.com/agentidentitytrustprotocol/aitp-control-plane/blob/main/internal_docs/IMAGE-HARNESS.md).

Alongside it, in the same job and against the same image, `npm run verify:sse`
opens real SSE connections to `GET /api/events/stream` and **measures the time to
the first response byte** (under 1 s; 7-27 ms when measured), pins the connect
prelude's bytes, the absence of `content-encoding` under
`Accept-Encoding: gzip, br`, the keepalive interval on the wire, and the
`503 SSE_CAPACITY` refusal. That is the regression gate on
[#89](https://github.com/agentidentitytrustprotocol/aitp-control-plane/issues/89),
where the stream wrote nothing at connect and so sent no HTTP status line at all
until its 15-second heartbeat — invisible to a unit test of the route, which
receives a `Response` object and never a socket.

Bring up the test database:

```bash
docker compose up -d postgres-test
```

The integration suite expects `DATABASE_URL=postgres://postgres:postgres@localhost:5433/aitp_control_plane_test`.

## Project layout

```
src/
  app/api/        Next.js App Router route handlers (the only thing rendered)
  proxy.ts        Request gate for /api/*: API-key auth, rate limiting, CORS, x-request-id
  instrumentation.ts  Boot hook: NODE_ENV/ENROLLMENT_SECRET checks, OTel, shutdown hooks, JWKS refresher
  e2e/, test/     Integration-test flows and shared test setup
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
    trust-anchors/  Background JWKS refresher for OIDC trust anchors
    webhooks/     Outbox dispatcher, HMAC signing, circuit breaker, retry reaper
    config.ts, logger.ts, retention.ts, idempotency.ts, rate-limit.ts, ...  (top-level modules)
drizzle/          SQL migrations
scripts/          verify:gate / verify:image / verify:sse harnesses and their committed baselines
e2e/              Playground end-to-end driver (real LLM; see e2e/README.md)
openapi.yaml      Machine-readable API schema
docs/             Published docs: API reference, events, data model, ops runbook, integration contract
internal_docs/    Internal-only docs (DEPLOY.md, IMAGE-HARNESS.md) — NOT published to the website
```

## Deployment

CI builds a multi-arch container image and publishes it to GHCR
(`ghcr.io/agentidentitytrustprotocol/aitp-control-plane`) on every push to
`main`. The `aitp` SDK is the published
[`@agentidentitytrustprotocol/aitp`](https://www.npmjs.com/package/@agentidentitytrustprotocol/aitp)
npm package, so the image and CI are self-contained — no sibling `aitp-rs`
checkout or Rust toolchain required.

The full CI/CD pipeline and a step-by-step Railway deployment guide live in
[`internal_docs/README.md`](https://github.com/agentidentitytrustprotocol/aitp-control-plane/blob/main/internal_docs/README.md)
— operational detail kept out of the published docs site.

## License

See [`LICENSE`](LICENSE).
