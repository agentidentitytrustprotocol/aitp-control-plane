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
  enrollment tokens. Required, and **≥ 32 characters**. Callers never see it.
  Unset or too short makes `POST /api/registry/enroll` return
  `503 SERVER_MISCONFIGURED` for every request, **in every environment** — not
  just production, and unlike `API_KEYS` this is not a fail-safe on gated routes
  but the total unavailability of enrollment. It is not validated at startup
  either (the service is constructed lazily on the first enrollment), and
  `/api/readyz` does not check it, so a bad value deploys green and fails only
  when an agent tries to enroll. Verify after any deploy that changes it.
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

### Verifying the shipped image

`verify:gate` above boots the server with `next start`. The Docker image does
not: it ships Next's **standalone** output (`NEXT_OUTPUT=standalone` in the
`Dockerfile`, then `node server.js`), and `next start` is incompatible with that
output — the reason the standalone opt-in is env-gated at all, recorded in
`next.config.ts`. So gate attachment was proven in a configuration the image
never runs, and in the artifact that actually deploys nothing tested it.

It has two halves. The **static** half asserts against the built artifact and
needs no server and no database. The **live** half stands up a real deployment —
its own private network, its own Postgres, the repo's own migrations — and runs
the image against it, which is where **gate attachment is proven in the artifact
that actually deploys**. The signing path and the CORS build-freeze build on that
same substrate and are documented here as they land.

The two harnesses are **deliberately not merged**. `verify:gate` owns the
`next start` path — a real developer workflow — and owns its own build, because it
must bake a `CORS_ORIGIN` that differs from the runtime one. This one owns the
standalone Docker artifact and does not own the build; the `Dockerfile` does. It
also does not re-prove the gate's *logic*: the rate-limit bucket assertions need
isolated per-IP buckets and are already covered against a running server by the
sibling. Duplicated assertions rot at different rates.

```sh
npm run verify:image                        # host platform
npm run verify:image -- --platform linux/amd64
```

It needs the repo's dev dependencies installed (`npm ci`): migrations go through
`npm run db:migrate`, and the runtime image bundles no `drizzle-kit`.

It builds the image for one platform, then asserts against the built artifact:

- **The NAPI binary loads** — `typeof require('aitp').AitpAgent === 'function'`
  inside the image, i.e. under the image's arch and libc, not the build host's.
- **The OpenTelemetry SDK was traced in** — the `@opentelemetry` scope exists
  under `.next/node_modules` and `sdk-node` resolves *through that traced path*.
  Resolving it the obvious way instead, from the image's working directory, would
  answer a weaker question: a bare `require.resolve` finds the copy in
  `/app/node_modules` and so passes on an image where nothing was traced at all.
  Being installed is not being traced, and only the traced copy is what the
  compiled server chunks load.
- **Every traced external resolves.** `.next/node_modules` holds one hashed
  entry per traced external (`aitp-<16 hex>`, and the compiled server chunks ask
  for exactly that hashed specifier). Each must be a **symlink** whose realpath
  is under `/app/node_modules` and which resolves from the server chunks. A
  hashed *copy* instead of a symlink would lose the sibling native binary
  (vercel/next.js#88844); a dangling link or a missing external fails loudly.
  Names are compared with the hash stripped, so a Next upgrade that changes the
  hash scheme does not produce a false red.
- **The native-module inventory** — every `.node` under `/app`, diffed against
  `scripts/image-artifact-baseline.json`, plus the assertion that the `aitp`
  binary carries the `linux-<arch>-gnu` token the requested platform asked for.
  That last one catches an amd64 image shipping an arm64 binary, or none.

It then stands up the **live** half and runs the image for real:

- A run-unique private bridge network, so the app reaches Postgres by container
  name — the same topology locally and in CI, depending on nothing like
  `host.docker.internal`.
- `postgres:16-alpine` (the pin `ci.yml` and `docker-compose.yml` already use),
  waited on via its **own** healthcheck rather than a third readiness idiom.
- **Migrations, applied from the host** through `npm run db:migrate`, against an
  ephemeral loopback-bound port. On the host because the runtime image bundles no
  `drizzle-kit`; ephemeral because a fixed 5432/5433 collides with
  `docker-compose` and with `ci.yml`'s service container. Postgres keeps its data
  directory on a **tmpfs**, so no anonymous volume is created and there is nothing
  to leak — the database is throwaway, and this is faster besides.
- **The schema is then verified**, not assumed from drizzle-kit's exit code. This
  matters more than it sounds: `/api/health` probes the database with `SELECT 1`,
  which needs no schema, so against a *completely unmigrated* database it still
  answers `db: "ok"` with the right AID and a 200. Every live check below would be
  green. The harness therefore counts tables in `public` and rows in
  `drizzle.__drizzle_migrations` and fails if either is zero.
- The image itself, detached, on that network, and `/api/health` asserted to
  report **`db: "ok"`** and an **`aid`** equal to one derived independently from
  `CP_AID_SEED_HEX` on the host with `node:crypto` alone. Deriving it with the SDK
  would compare the SDK against itself; deriving it independently makes it a real
  cross-implementation check.

Migrations are **not optional**, and the reason is specific rather than
housekeeping: unmigrated, the revocation producer catches the failed DB read and
publishes an **empty but validly signed** list. A signature check would then pass
against an image whose database access is completely broken, and `/api/audit` with
a valid key would answer 500, leaving no way to tell an attached gate from one
that rejects everything. An unmigrated harness is a harness that lies.

Then **gate attachment**, which is the gap the whole effort is named for. Auth,
rate limiting and CORS live in `src/proxy.ts`; a gate file in a location Next does
not recognise builds green, emits no warning, and leaves every `/api/*` route
unauthenticated. `verify:gate` cannot see that in the standalone output, because
`next start` cannot run it. So against the running image:

- Unauthenticated `GET /api/audit` → **401** *and* `code: INVALID_API_KEY`.
  `/api/audit` is genuinely gated — absent from `PUBLIC_PATHS`, matching no public
  GET pattern — and is a different handler from the one the sibling probes, so a
  shared-fixture mistake cannot make both harnesses agree wrongly.
- The same request **with** a valid key reaches the handler. Without this half, a
  gate that rejected everything unconditionally would satisfy the check above.
- **`x-request-id` on both.** The gate injects it, so its presence is evidence the
  gate *ran*, not merely that something answered 401.
- `OPTIONS` → **204** with an empty body, answered by the gate without ever
  reaching a handler.

- **The gate's matcher set is exactly the pinned one.** This is what keeps the four
  above from being vacuous, and it is an *equality against a committed value*
  (`middlewareMatchers` in `scripts/image-artifact-baseline.json`) rather than a test
  of what the matcher satisfies. Any matcher key beyond `regexp`/`originalSource`
  fails closed, and the built-route count is pinned as well.

  That shape was arrived at the hard way. Three earlier versions tested
  *satisfaction* and each fell to a one-line edit of `src/proxy.ts`:

  | matcher | what it defeated | what leaked |
  |---|---|---|
  | `['/api/audit']` | a one-path HTTP probe | the whole admin surface |
  | `['/api/audit','/api/webhooks','/api/health']` | a three-path probe | 5 routes, incl. the sibling harness's own |
  | `['/api/:path([^0-9]+)']` | testing the built route list | all 10 dynamic routes — the check substitutes a literal `a` per `[param]`, and `a` has no digit, so every route "matched" while every real id did not |
  | `{source:'/api/:path*', missing:[{type:'header',key:'cookie'}]}` | all of the above, *source unchanged* | everything, to any request with a cookie |

  The last is the instructive one: Next enforces `has`/`missing` at **runtime**, so
  the matcher looked correct in every check while `GET /api/audit` with a cookie —
  i.e. any browser request — returned the admin audit log. A sampled predicate can
  always be satisfied by something narrower than it appears to be, which is why the
  matcher itself is pinned and unknown conditions are rejected rather than ignored.

  (Read from `functions-config-manifest.json`, not `middleware-manifest.json` — the
  latter is `{"middleware":{},"sortedMiddleware":[]}` in this image *and* in one whose
  gate is correctly attached, so a check against it would be green forever. The
  former is load-bearing at runtime: delete it and the server refuses to boot.)

- **The gate actually runs**, on a second gated route under a different top-level
  segment and on a public route that must still carry the injected `x-request-id`.
  This is the behavioural complement: a manifest can show the matcher covers a route
  but not that the gate does anything when it runs.

It asserts the **wire contract, not the status code**: a 401 without
`code: INVALID_API_KEY` is a different failure wearing the right status. And empty
`API_KEYS` under `NODE_ENV=production` makes the gate answer `503
SERVER_MISCONFIGURED` instead, which is reported as its own distinct failure —
otherwise it would read as "wrong status" and send you looking at the gate when the
problem is the environment.

The health assertion checks `db` **before** the HTTP status, deliberately.
`/api/health` answers 503 whenever the DB ping fails, so a status-first assertion
reports "status 503" — the symptom — for an unreachable database and buries the
cause in a JSON blob. All three properties are still asserted; only the order of
the messages changes.

Two properties make it worth more than a smoke test:

- **The expectation is a committed baseline**
  (`scripts/image-artifact-baseline.json`), not a value re-derived from
  `next.config.ts`. Without it these probes catch only a *crash*; with it they
  also catch **drift** — a new traced external appearing, `sharp`'s binary
  vanishing, or a package quietly dropping out of the traced set. Drift is the
  failure mode that ships quietly.
- **The baseline is normalised, so one file serves both arches**: the arch token
  becomes `<ARCH>` and a trailing `-<semver>` before `.node` is dropped (which
  absorbs a `sharp` bump). A genuinely new or missing binary still fails, and
  should — that is a review point, not noise.

Note what the baseline is **not**: it tracks the set Next actually **traces**,
which is not `serverExternalPackages`. `pg` and `pino` are traced without being
listed there, and `@grpc/grpc-js` is listed without ever being traced — so
removing `@grpc/grpc-js` from that list would not move this baseline at all.

After reviewing a legitimate change, regenerate:

```sh
node scripts/verify-image.mjs --update-baseline
```

Regeneration is deliberately hard to do by accident, because a baseline written
from a broken image is worse than no baseline — every later run would compare
the defect against itself and report green. Two guards:

- It **refuses outright** if any structural check (1–4) failed, so a dangling
  symlink or a wrong-architecture binary can never be recorded as normal.
- It prints the **diff against the existing baseline** and refuses if any entry
  would *disappear*. Additions are the benign direction and are written; a
  removal means something that used to ship no longer does, which is the exact
  regression the baseline exists to catch. If the removal really is intended,
  re-run with `--allow-removals`.

Other flags: `--no-build` reuses an existing local tag (and fails fast if its
architecture does not match `--platform`), `--tag` names the image, `--keep`
skips teardown and prints the cleanup commands, and `--prune` sweeps resources
left behind by an earlier crashed run. `--platform` takes **one** platform per
invocation — `docker buildx build --load` cannot load a multi-platform manifest.

Two things to know about what it leaves behind:

- **Containers and networks are always torn down** — on success, on failure, and
  on Ctrl-C (`SIGINT`/`SIGTERM` are handled explicitly, unlike in the sibling
  harness). The **image** is deliberately kept, under a deterministic tag, so a
  failure can be re-probed with `--no-build`; remove it with `docker image rm`.
  `--prune` does not touch images.
- **`--prune` removes resources from every other run of this harness**, not just
  dead ones — it is for orphans left by a crash, so do not run it while another
  `verify:image` run is in flight. And because the default tag is not
  run-unique, pass `--tag` if you run two platforms concurrently.

The two harnesses are deliberately **not** merged: `verify:gate` owns the
`next start` path, a real developer workflow, and owns its own build;
`verify:image` owns the standalone artifact and does *not* own the build
environment — the `Dockerfile` does. Two harnesses, two configurations, one
shared discipline. Duplicated assertions rot at different rates.

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

### Keepalive: `SSE_HEARTBEAT_MS`

**`SSE_HEARTBEAT_MS`** (default `15000`) sets two things at once: the interval
between `: heartbeat` comment frames on an open stream, and the `retry:`
reconnect delay the stream advertises to `EventSource` clients in its connect
prelude.

**Tune it against your edge's idle timeout, which is the only thing it is for.**
A proxy or load balancer that closes idle connections after N seconds will drop
an SSE stream that has been quiet for N seconds, and the heartbeat exists purely
to stop that from happening. So the interval must sit **below** the timeout:

- Common edge idle timeouts are 30-60 s, which is why the default is 15 s.
- If streams are dying on a fixed cadence shorter than 15 s, set this below that
  cadence. `sse_streams_opened_total` climbing while `sse_streams_open` stays
  flat is the signature (see "Is the stream healthy?" immediately below).
- Above 60 s the CP logs a warning at boot, but does not override you — a
  deployment behind an edge with a long or absent idle timeout may legitimately
  want a slow heartbeat.

Six behaviours worth knowing before you change it:

- **It is clamped to a 1000 ms floor.** `SSE_HEARTBEAT_MS=0` and negative values
  are *accepted* by the env parser (`"0"` is a non-empty string, so it is not
  treated as unset) and would make `setInterval` fire roughly every millisecond
  on every open stream — a CPU spin and a bandwidth flood. Values below the floor
  are raised to it rather than replaced by the default, so an explicit "as fast
  as possible" still means "as fast as we allow". A **non-numeric** value is
  different: there is no intent to preserve, so it falls back to `15000`.
- **It is also clamped to a 2147483647 ms ceiling**, for the same reason as the
  floor rather than as a policy about slow heartbeats. `setInterval` keeps its
  delay in a signed 32-bit int, so a larger delay overflows and Node **resets it
  to 1 ms** — an extra-zeros typo like `SSE_HEARTBEAT_MS=15000000000`, meaning
  "basically never", would produce the exact millisecond flood the floor exists
  to prevent. The ceiling is ~24.8 days, so it cannot override any interval a
  real deployment would pick, and the boot log says explicitly when it has
  clamped (naming both the value you set and the value in force).
- **It is read once, at boot.** The config object is built at module load, so
  changing the variable on a running instance has no effect until the process
  restarts (on Railway, an env change triggers one).
- **One edge case scales with it:** a request whose client had already
  disconnected before the handler ran holds its capacity slot until the next
  heartbeat tick notices, because there is no abort event left to fire. That is
  one `SSE_HEARTBEAT_MS` — a second at the floor, five minutes at `300000`. Every
  other disconnect releases the slot immediately.
- **It also sets the clients' reconnect delay, so lowering it is not free.** The
  prelude advertises `retry: <this value>`, and a browser `EventSource` waits
  that long before reconnecting. It cuts both ways. Browsers default to roughly
  3 s, so any value *below* ~3000 ms makes disconnected clients come back
  **faster** than they otherwise would — into `MAX_SSE_CONNECTIONS` and the rate
  limiter; if you need a sub-3 s heartbeat to survive an aggressive edge, expect
  the reconnect rate to rise with it and watch `sse_streams_rejected_total`. And a
  large value slows reconnects by the same amount: `SSE_HEARTBEAT_MS=300000` tells
  every console to wait five minutes after a dropped stream before trying again,
  which looks exactly like the stream being broken. That is a second reason the
  >60 s boot warning is worth heeding, beyond idle timeouts.
- **It is no longer load-bearing for connect.** The stream writes its prelude
  immediately on connect, so response headers reach the client in milliseconds
  regardless of this setting. It used to be the *only* thing that ever wrote a
  byte on a quiet control plane, and because Next defers the response headers
  until the first body chunk, that meant no client saw an HTTP status line for
  15 seconds. Lowering this value is therefore no longer a fix for a stream that
  seems not to respond at all.

### Is the stream healthy? (three metrics, no log access needed)

`/api/metrics` is public and rate-limit exempt, so these answer the question
from anywhere — which is the point: they exist because a dead stream endpoint
was once undiagnosable from outside the process for days.

| Series (`aitp_control_plane_`…) | Read it as |
|---|---|
| `sse_streams_open` | Streams alive on this replica right now. Flat at `0` while the console claims to be connected means the handler is not being reached — look at the gate, the proxy, or the URL, not at the route. |
| `sse_streams_opened_total` | Connect *rate*, by differencing. Climbing fast with `sse_streams_open` flat is a reconnect loop: streams are being accepted and dying immediately. Suspect an idle timeout or a function duration cap at the edge rather than the route. |
| `sse_streams_rejected_total` | Connections refused by the cap. Any movement means `MAX_SSE_CONNECTIONS` is too low for the current client population, or streams are leaking rather than closing. |

Both counters are cumulative and per-process, so they reset on restart and on a
redeploy — normal for a Prometheus counter, and a reset is itself the signal that
the replica restarted.

For per-stream detail, the route logs exactly two lines per connection —
`sse stream opened` (with the active filters and the resulting open count) and
`sse stream closed` (with `durationMs` and a `reason` of `cancel`, `abort` or
`enqueue-failed`) — plus one `sse stream rejected` warning per capacity refusal.
Nothing is logged per heartbeat, so the volume is bounded by connect rate, which
the rate limiter already caps.

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
  `sse_streams_open`, `sse_streams_opened_total`, `sse_streams_rejected_total`,
  `webhook_circuit_breaker_open`. Held in memory and **per replica**, so
  aggregating across instances is the scraper's job, and all of them **reset on
  restart**. For the counters in that list that is harmless (a Prometheus counter
  reset is something the scraper handles). For the two **gauges** —
  `webhook_circuit_breaker_open` over an in-memory `Map`, and `sse_streams_open`
  over a per-process count — it is a trap, because a restart makes both read like
  good news: every breaker reads `closed`, which is indistinguishable from "the
  fleet recovered", and every stream count reads `0`, which is
  indistinguishable from "no clients are connected". Confirm a breaker recovery
  against delivery success, and read `sse_streams_open` next to
  `sse_streams_opened_total` rather than alone.
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
| `sse_streams_open` | gauge | — | `/api/events/stream` connections open right now on this replica |
| `sse_streams_opened_total` | counter | — | Stream connections accepted since process start |
| `sse_streams_rejected_total` | counter | — | Stream connections refused by `MAX_SSE_CONNECTIONS` |

The DB-derived series (`agents_*`, `sessions_total`, `webhook_deliveries`,
`audit_events`) are **absent** from a scrape taken while the database is
unreachable; `db_up 0` plus a `# DB unavailable` comment appears instead, and
the scrape still returns `200`. Alert on `db_up`, not on the absence of the
others.

**`enroll_verification_failures`** is worth an alert: `POST /api/registry/enroll`
is the only public, unauthenticated endpoint that runs cryptographic
verification, and a spike is either a broken client fleet or someone probing.

**Know what it does not count**, or you will read a flat line as "no problem":
only failures that reached manifest verification are counted. Three classes are
excluded, all deliberately — counting them would corrupt the `code` breakdown,
which is the whole point of the metric:

- **Pre-validation** — malformed JSON, or a body with no `manifest` at all
  (`400 BODY_INVALID`, `400 MANIFEST_INVALID`). Never reaches the SDK.
- **`503 SERVER_MISCONFIGURED`** — a server with no usable `ENROLLMENT_SECRET`
  rejects *every* enrollment while this counter stays flat at zero.
- **The rethrow to `500`** — an unclassifiable internal fault.

The first two are the loudest fleet-wide breakages, and — be blunt about it —
**neither has any other in-process signal**: the route logs only classified
verification failures, `src/proxy.ts` has no logger at all, and
`rate_limit_drops` moves only on a `429`. Until that is fixed (tracked as an open
question on the #69 plan) the detection path for those two is your ingress or
load balancer: alert on the enroll route's `5xx` rate and on a sustained `400`
rate, not on this counter.

The third — the rethrow to `500` — *is* visible, but only in the application log:
Next prints the error and a stack trace to stderr. So during a `500` incident
read the pod logs; for the other two there is nothing there to read.

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
  does not bundle `drizzle-kit` — which is also why `verify:image` applies them
  from the host rather than from inside the container. See the internal
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
