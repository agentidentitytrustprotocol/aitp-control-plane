# Operations runbook

Running the control plane in production. Configuration is entirely environment
variables — `.env.example` in the repo is the canonical list, and the internal
[deployment guide](https://github.com/agentidentitytrustprotocol/aitp-control-plane/tree/main/internal_docs)
covers the CI/CD and Railway path. This document explains the operational
subsystems and how to tune them.

## Identity

The CP has its own AITP identity (Ed25519), served at
`/.well-known/aitp-manifest` and used to sign the revocation list.

- **`CP_AID_SEED_HEX`** — 32-byte hex seed. **Required in production.** Without
  it the seed is regenerated on every boot, so the CP's AID changes on restart
  and any peer that pinned the old key breaks. Generate once and store it as a
  secret:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- **`CP_BASE_URL`** — public URL embedded in the CP's own manifest. Set it to
  the externally reachable origin.
- The CP's own manifest has a **86400s (24h) TTL** (`MANIFEST_TTL_SECS`) and
  is rebuilt in place once it comes within **3600s** of expiry
  (`MANIFEST_REBUILD_MARGIN_SECS`), on the next call to `getCpManifestJson()`
  after that point — a long-lived process never serves a permanently expired
  manifest and does not need a periodic restart to stay fresh. These are
  hardcoded constants in `src/lib/identity/cp-agent.ts`, not environment
  variables — there is nothing to configure here. (This applies only to the
  CP's own self-published manifest at `/.well-known/aitp-manifest`; it has no
  bearing on agent-submitted manifests handled by `POST
  /api/registry/enroll`, a separate code path.)

Rotating `CP_AID_SEED_HEX` rotates the control-plane identity — treat it like a
signing key, not a config toggle.

## Authentication & exposure

- **`API_KEYS`** — comma-separated allowlist for gated routes. **Required in
  production**: empty `API_KEYS` in prod makes every gated route return
  `503 SERVER_MISCONFIGURED` (fail-safe). Empty in non-prod disables auth and
  logs a one-time warning.
- **`ENROLLMENT_SECRET`** — server-side HMAC key for minting/verifying one-time
  enrollment tokens. Required. Callers never see it.
- **`CORS_ORIGIN`** — allowed browser origin (the UI console's origin). Set it
  to a single origin, e.g. `https://console.example.com`. Applied per-request at
  runtime by the proxy, so it can be changed via the deploy environment
  without rebuilding the image. Defaults to `http://localhost:3000` if unset.

See [`api.md`](api.md#authentication) for the full auth matrix.

### Verifying the request gate

Auth, rate limiting, CORS and `x-request-id` injection all live in one file
(`src/proxy.ts`). Unit tests call its exported function directly, which
proves the *logic* but cannot prove Next actually **attached** it — a gate file
in a location Next does not recognise builds green, emits no warning, and leaves
every `/api/*` route unauthenticated and unthrottled.

```sh
npm run verify:gate
```

Builds the app and boots it, then asserts the whole contract over HTTP: 15
checks covering rejection of unauthenticated requests, acceptance of valid keys,
all three rate-limit buckets with their `Retry-After` / `X-RateLimit-*` headers,
probe-path exemption, preflight handling, fail-closed behaviour when `API_KEYS`
is unset in production, and that the gate is attached with an unchanged matcher.

Two properties make it worth more than a smoke test:

- **It runs with a different `CORS_ORIGIN` than it built with**, and asserts the
  served header matches the *runtime* value. Asserting mere presence would pass
  on an artifact that had frozen the value at build time.
- **It enumerates the public route set from the built manifest, never from
  `PUBLIC_PATHS`**, and diffs it against `scripts/request-gate-baseline.json`.
  Re-deriving the expectation from the code under test would be a tautology that
  reports green while the gate is open.

If a route's classification legitimately changes, review every line of the
printed diff — each `public` entry is a route reachable with no credentials —
then regenerate:

```sh
node scripts/verify-request-gate.mjs --build --update-baseline
```

CI runs this on every push; a non-zero exit fails the build.

## Rate limiting

In-memory, per-process token buckets on every `/api/*` route except the probes
(`/api/health`, `/api/readyz`, `/api/metrics`). Over-limit → `429 RATE_LIMITED`
with `Retry-After` and `X-RateLimit-*` headers.

| Bucket | Default | Env var | Keyed by |
|---|---|---|---|
| `enroll-ip` | 5/min | `RATE_LIMIT_ENROLLMENT_PER_IP_MIN` | client IP (brute-force guard on enrollment) |
| `public-ip` | 60/min | `RATE_LIMIT_PUBLIC_PER_IP_MIN` | client IP |
| `api-key` | 600/min | `RATE_LIMIT_API_KEY_PER_MIN` | API key prefix |

- `RATE_LIMIT_WINDOW_MS` (default 60000) is the accumulation window.
- `RATE_LIMIT_ENABLED=false` disables the limiter entirely (dev / load tests).
- Set any individual limit to `0` to disable that bucket.

> **Buckets are per-process.** Behind multiple replicas the effective limit is
> roughly `N × limit`. For a hard global limit, put a shared limiter at the edge.

### Client-IP trust (important behind a proxy)

`X-Forwarded-For` is client-controllable, so per-IP buckets are spoofable unless
you tell the CP which hop to trust:

- **`CLIENT_IP_HEADER`** — a single trusted header your edge sets to the real
  client IP (e.g. `cf-connecting-ip`, `x-vercel-forwarded-for`). Wins when set.
- **`TRUSTED_PROXY_HOPS`** — number of trusted proxies appending to XFF; the
  client IP is read this many entries **from the right**. Default `0` = XFF not
  trusted at all (leftmost is spoofable).

Misconfigure these and per-IP limits either bucket every request under one key
or are trivially bypassed. Match them to your actual edge.

## SSE capacity

`GET /api/events/stream` holds an in-process subscription per open stream.

- **`MAX_SSE_CONNECTIONS`** (default 500) caps concurrent streams per process;
  over the cap returns `503 SSE_CAPACITY`. Clients should back off and retry.
- **`MAX_AUDIT_EVENTS_MEMORY`** (default 500) sizes the bus's total in-memory
  retention (older events are evicted and counted as dropped). Each new
  subscriber replays at most the last **100** events before going live,
  regardless of this setting.

If you front the CP with a fan-out proxy that opens its own upstream pool, raise
`MAX_SSE_CONNECTIONS` accordingly.

## Webhook delivery

Each delivery retries up to `WEBHOOK_RETRY_ATTEMPTS` (default 3) with
exponential backoff. A per-endpoint circuit breaker sits in front of the
retries:

- **`WEBHOOK_BREAKER_FAILURE_THRESHOLD`** (default 5) — consecutive failures
  before the breaker opens and deliveries to that endpoint are skipped.
- **`WEBHOOK_BREAKER_RESET_MS`** (default 60000) — how long the breaker stays
  open before a half-open probe is allowed.

Inspect or reset a breaker via `GET /api/webhooks/:id/circuit-breaker` and
`POST /api/webhooks/:id/circuit-breaker/reset` (see [`api.md`](api.md#webhooks)).

## Data retention

A periodic sweep keeps storage bounded. It is multi-instance safe via a Postgres
advisory lock (`pg_try_advisory_xact_lock`), so replicas don't duplicate work.

- **`RETENTION_ENABLED`** (default true) — master switch.
- **`RETENTION_INTERVAL_MS`** (default 1800000 / 30 min) — sweep cadence.
- **`RETENTION_BATCH_LIMIT`** (default 10000) — max rows deleted per sweep, so a
  sweep never locks a table for minutes.

What is swept (set any TTL to `0` to keep that table indefinitely):

| Table | Env var | Default |
|---|---|---|
| `audit_events` | `AUDIT_EVENTS_TTL_DAYS` | 90 |
| `webhook_deliveries` (terminal rows) | `WEBHOOK_DELIVERY_TTL_DAYS` | 14 |
| `admin_audit_log` | `ADMIN_AUDIT_TTL_DAYS` | 365 |
| `idempotency_keys` | `IDEMPOTENCY_KEY_TTL_DAYS` | 7 |
| `enrollment_jtis` (past expiry) | — | token TTL |
| `agents` with `status='deregistered'` | `EXPIRED_AGENT_GRACE_DAYS` | 30 |

> Despite its name, `EXPIRED_AGENT_GRACE_DAYS` GCs **operator-deregistered**
> agents, not `expired` ones — `expired` rows are left in place so they can be
> re-enrolled. Authoritative records (`revocation_entries`, `issued_tcts`,
> `delegations`, `trust_anchors`, `pinned_keys`) are **never** swept.

## Observability

- **Metrics:** `GET /api/metrics` exposes Prometheus text format (public, exempt
  from rate limiting). See [Metrics](#metrics) below for the series it emits.
- **Logs:** structured JSON via pino. `LOG_LEVEL` ∈ `trace|debug|info|warn|error|fatal`
  (default `info`). Every request/response carries `x-request-id` for correlation.
- **Tracing (OpenTelemetry):** off by default. Set `OTEL_ENABLED=true` to export
  spans to the OTLP HTTP endpoint at `OTEL_EXPORTER_OTLP_ENDPOINT` (path
  `/v1/traces` is appended unless `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set).
  `OTEL_SERVICE_NAME` defaults to `aitp-control-plane`. HTTP, `pg`, and `fetch`
  are auto-instrumented.

### Metrics

All series are prefixed `aitp_control_plane_`. Three different kinds of value sit
in this table, and conflating them will give you wrong numbers:

- **Process-local** — `rate_limit_drops`, `admin_audit_insert_failures`,
  `event_backlog_dropped`, `enroll_verification_failures`,
  `webhook_circuit_breaker_open`. Held in memory and **per replica**, so
  aggregating across instances is the scraper's job, and all of them **reset on
  restart**. For the four counters that is harmless (a Prometheus counter reset is
  something the scraper handles). For `webhook_circuit_breaker_open` — a gauge
  over an in-memory `Map` — it is a trap: after a rolling restart every breaker
  reads `closed`, which looks identical to "the fleet recovered" and is not.
  Confirm a breaker recovery against delivery success, not against this gauge
  going quiet.
- **Database-derived** — `agents_active`, `agents_expired`, `sessions_total`,
  `webhook_deliveries`, `audit_events`. These are `COUNT(*)`/`GROUP BY` queries
  against shared state, so they are *already* cluster-wide and survive restarts.
  **Do not `sum()` them across replicas** — you would multiply the true value by
  the replica count.
- **Per-replica, per-scrape** — `db_up` alone. It is this instance's DB
  reachability at the moment of the scrape, not a count of anything and not a
  cluster-wide fact: replica A reaching the database while replica B cannot is
  exactly what the series exists to show. Alert per instance, or on `min()` —
  never `sum()`.

| Series (`aitp_control_plane_`…) | Type | Labels | Meaning |
|---|---|---|---|
| `agents_active` | gauge | — | Agents with `status='active'` |
| `agents_expired` | gauge | — | Agents whose manifest expired, awaiting re-enrollment |
| `sessions_total` | counter | — | Handshake sessions ever observed |
| `webhook_deliveries` | gauge | `status` | Deliveries `pending` / `failed` |
| `audit_events` | counter | `type` | Audit events by event type |
| `db_up` | gauge | — | `1` if the DB answered this scrape, else `0` |
| `rate_limit_drops` | counter | `bucket` | Requests rejected by the limiter |
| `webhook_circuit_breaker_open` | gauge | `state` | Webhooks with the breaker `open` / `half_open` |
| `admin_audit_insert_failures` | counter | — | Admin-audit writes that failed (silent-degradation surface) |
| `event_backlog_dropped` | counter | — | Audit events evicted from the in-memory SSE backlog |
| `enroll_verification_failures` | counter | `code` | Failed enrollment manifest verifications |

The DB-derived series (`agents_*`, `sessions_total`, `webhook_deliveries`,
`audit_events`) are **absent** from a scrape taken while the database is
unreachable; `db_up 0` plus a `# DB unavailable` comment appears instead, and
the scrape still returns `200`. Alert on `db_up`, not on the absence of the
others.

**`enroll_verification_failures`** is worth an alert: `POST /api/registry/enroll`
is the only public, unauthenticated endpoint that runs cryptographic
verification, and a spike is either a broken client fleet or someone probing.

**Know what it does not count**, or you will read a flat line as "no problem":
only failures that reached manifest verification are counted. A caller posting
malformed JSON or a body with no `manifest` at all (`400 BODY_INVALID`,
`400 MANIFEST_INVALID`) never reaches the SDK and is **not** counted, and neither
is `503 SERVER_MISCONFIGURED` — a server with no usable `ENROLLMENT_SECRET`
rejects every enrollment while this counter stays at zero. Both exclusions are
deliberate (counting them would corrupt the code breakdown, which is the whole
point of the metric), but they mean the two loudest fleet-wide breakages are
invisible here. Watch `rate_limit_drops{bucket="enroll-ip"}` and the route's own
log lines alongside it.

Its `code` label is a bounded set of **ten** values — the eight codes the `aitp`
SDK documents for manifest verification, plus:

- `none` — the manifest was rejected by *this service* rather than by the SDK
  (a `manifest.aid` that is not an AID, or an `expires_at` inside the 5-minute
  registration window). The SDK accepted it; we did not.
- `other` — the SDK returned a code this build does not recognize. **`other`
  becoming non-zero is itself a signal**: the SDK's code set has grown and this
  service's label allowlist needs updating. Nothing breaks in the meantime —
  the total stays correct and only the breakdown loses detail.

The label is allowlisted deliberately. The wire field `verifyCode` passes an
unknown SDK code through verbatim (the SDK owns that vocabulary), but a label
value is a cardinality dimension derived from caller-supplied input, so passing
unknown values through would let a caller mint unbounded time series. All ten of
*this* metric's series are pre-seeded at `0`, so none of them is ever missing
from a scrape — that guarantee is specific to `enroll_verification_failures`;
`rate_limit_drops` and `audit_events` emit only labels they have actually seen.

## Health, readiness & graceful shutdown

- **`GET /api/health`** — liveness + DB ping. Stays `200` even while draining.
- **`GET /api/readyz`** — readiness (DB reachable, identity initialized).

On SIGTERM the process enters a drain window: `/api/readyz` flips to
`503 { "ready": false, "reason": "shutting_down" }` so a load balancer pulls the
pod out of rotation, while `/api/health` stays `200` so the orchestrator doesn't
hard-kill it mid-drain. Point your LB/orchestrator readiness probe at
`/api/readyz` and the liveness probe at `/api/health`.

## Database

- **`DATABASE_URL`** — Postgres connection string (required).
- **`DB_POOL_MAX`** (default 20) — connection pool size.
- Migrations run via `npm run db:migrate` from a checkout; the runtime image
  does not bundle `drizzle-kit`. See the internal
  [deployment guide](https://github.com/agentidentitytrustprotocol/aitp-control-plane/tree/main/internal_docs)
  for the migration step against a hosted database.

## Multi-tenancy

Namespaces (`namespace` column, `X-Aitp-Namespace` header, `?namespace=` filter)
are an **opt-in** scoping convention, not an enforced boundary. `GET
/api/registry/agents` without `?namespace=` returns rows across all tenants by
design — registry discovery is an [operational, non-normative][disc] layer in
AITP, not a protocol-defined isolation boundary. If you need isolation, your
callers must set the namespace on both discovery and enrollment; the CP enforces
no implicit boundary.

[disc]: https://agentidentitytrustprotocol.io/docs/discovery
