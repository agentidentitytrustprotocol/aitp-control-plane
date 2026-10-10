# Operations runbook

Running the control plane in production. Configuration is entirely environment
variables — `.env.example` in the repo is the canonical list, and the internal
[deployment guide](https://github.com/agentidentitytrustprotocol/aitp-control-plane/blob/main/internal_docs/DEPLOY.md)
covers the CI/CD and Railway path. This document explains the operational
subsystems and how to tune them.

## Identity

The CP has its own AITP identity (Ed25519), served at
`/.well-known/aitp-manifest` and used to sign the revocation list.

- **`CP_AID_SEED_HEX`** — 32-byte hex seed. **Required in production.** Outside
  production a missing seed is replaced by a random one on every boot (logged
  as a warning), so the CP's AID changes on restart and any peer that pinned
  the old key breaks. Under `NODE_ENV=production` a missing seed is **not** a
  boot check: the process starts, and the identity is built lazily on first use,
  which throws — so `/api/health`, `/.well-known/aitp-manifest` and the
  revocation list answer `500` until the seed is set. (A platform healthcheck
  on `/api/health`, such as the one in `railway.json`, therefore fails the
  deploy; a check on `/api/readyz` would not.) Generate once and store it as a
  secret:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- **`CP_BASE_URL`** — public URL embedded in the CP's own manifest. Set it to
  the externally reachable origin. The manifest advertises
  `<CP_BASE_URL>/api/aitp/handshake/hello` as its handshake endpoint, but the CP
  serves no handshake route: that URL returns `404`. The CP is an observer and
  signer, not a handshake peer.
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

## Revocation list

`GET /.well-known/aitp-revocation-list` serves a revocation snapshot signed with
the CP identity. The envelope and its signing input are the spec's —
[RFC-AITP-0008 §1.5](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0008-revocation.md#15-signed-revocation-response)
and [RFC-AITP-0001 §5.4.1](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0001-core.md#541-signing-input-jcs-profile)
— and verifying it with the SDK is covered in the
[aitp-rs Node SDK guide](https://github.com/agentidentitytrustprotocol/aitp-rs/blob/main/docs/sdk-node.md#revocation-lists-rfc-aitp-0008).
What is specific to this service:

- **Re-signed at most every 60 s per process.** The producer caches the signed
  envelope for 60 s, and the response carries `Cache-Control: max-age=60`.
  Recording a revocation (`POST /api/revocation/entries`) drops the cache on
  the replica that handled it only; other replicas pick the entry up within
  60 s.
- **`REVOCATION_LIST_TTL_SECS`** (default 3600) is the validity of each signed
  list (`expires_at`), not how often it is rebuilt.
- **Fails closed.** If `revocation_entries` cannot be read, the endpoint answers
  `503 REVOCATION_UNAVAILABLE` (`Cache-Control: no-store`, `Retry-After: 30`) and
  never signs an empty list, which would assert that nothing is revoked.
  `REVOCATION_FAIL_MODE=serve_stale` instead re-serves the last list that was
  backed by a successful read, for at most `REVOCATION_MAX_STALENESS_SECS`
  (default 300, clamped to `REVOCATION_LIST_TTL_SECS`), then `503`s; recording a
  revocation discards that fallback. Both paths log a line containing
  `revocation DB read failed` (warn when serving stale, error when refusing),
  and the shipped-image harness asserts on that text — keep it.

## Authentication & exposure

- **`API_KEYS`** — comma-separated allowlist for gated routes. **Required in
  production**: empty `API_KEYS` in prod makes every gated route return
  `503 SERVER_MISCONFIGURED` (fail-safe). Empty in non-prod disables auth and
  logs a one-time warning.
- **`ENROLLMENT_SECRET`** — server-side HMAC key for minting/verifying one-time
  enrollment tokens. Required, and **≥ 32 characters**. Callers never see it.
  Unset or too short takes out **both** `POST /api/registry/enroll` and
  `POST /api/registry/agents` — and unlike `API_KEYS` this is not a fail-safe on
  gated routes but the total unavailability of enrollment *and* registration: one
  route cannot mint tokens, the other cannot verify them. On a server that is
  running, both answer `503 SERVER_MISCONFIGURED` for every request; in
  production the server does not get that far.

  **Validated at boot, and under `NODE_ENV=production` an unusable value is
  fatal:** the process prints one line naming both affected routes and exits `1`
  before serving anything. Since the image's runner stage hardcodes
  `NODE_ENV=production`, that covers every container deploy — the healthcheck
  never passes, so the release fails and the previous one keeps serving, instead
  of a green deploy that 503s every enrollment for as long as it runs. (You will
  see Next's own `✓ Ready` line *above* the fatal one: the listener binds before
  the boot hook runs. The port is open for well under a second on a process that
  is already exiting.)

  Outside production the same line is printed as a warning and the process
  starts, because `.env.example` ships the variable empty and a hard stop would
  break `npm run dev` for anyone who only wants the discovery routes. Both
  routes' 503s are what covers that case, and they remain correct: a running
  process must answer sanely. Note `next start` defaults `NODE_ENV` to
  production, so a local `npm start` gets the fatal path, not this one.

  **The gate is `NODE_ENV === 'production'` exactly**, so a deployment that sets
  `NODE_ENV` to something else — `staging`, say — gets the warning and starts. That
  is deliberate consistency rather than an oversight: it is the same
  `config.isProduction` every other production gate in this service keys on, and a
  deployment with a non-`production` `NODE_ENV` has already lost more than this
  one check — empty `API_KEYS` stops failing closed and *disables auth on gated
  routes* instead. If you run a staging environment, set `NODE_ENV=production`
  there and differentiate it some other way; the image does this for you.

  **That single point of failure is now loud, not silent (#116).** `NODE_ENV` is
  trimmed (`"production "` is production), and at boot a value that is neither
  `production` nor a recognised development value (`development`, `test`) — including
  *unset* — makes the process print one `[aitp-cp] NODE_ENV is "staging", … every
  production safeguard is INACTIVE` line at error level, listing what is off. It is
  warn-only on purpose: making one gate stricter than the others would be inconsistent,
  and `development`/`test` must keep working. Treat that line in a deployed instance's
  logs as a misconfiguration.

  *Measured limit:* `next start` and the image's standalone `server.js` both
  **overwrite `NODE_ENV` with `production` before any app code runs** (`server.js` opens
  with `process.env.NODE_ENV = 'production'`), so on those two launch paths a stray
  value is already neutralised by Next and this line cannot fire. It covers launchers
  that bypass them — `next dev`, a custom server, a test runner — and the trim covers
  the rest of the module-scope reads.

  `/api/readyz` deliberately does **not** check it — see
  [Health, readiness & graceful shutdown](#health-readiness--graceful-shutdown)
  for why. Still verify an enrollment after any deploy that changes the value:
  boot only proves the secret is *usable*, not that it is the same one your
  already-issued tokens were minted under.
- **`CORS_ORIGIN`** — allowed browser origin (the UI console's origin). Set it
  to a single origin, e.g. `https://console.example.com`. Applied per-request at
  runtime by the proxy, so it can be changed via the deploy environment
  without rebuilding the image. Defaults to `http://localhost:3000` if unset.
  That "without rebuilding the image" claim is not taken on trust: `verify:image`
  runs the shipped image with a sentinel origin and asserts the served header
  equals it and **differs** from the value the `Dockerfile` bakes at build time —
  see [Verifying the shipped image](#verifying-the-shipped-image). Note the value
  is captured at *container start*, not re-read per request, so changing it means
  a restart and not just an environment edit.

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

Builds the app, boots it with `next start`, and asserts the contract over HTTP
in 15 checks: rejection of unauthenticated requests, acceptance of valid keys,
all three rate-limit buckets with their headers, probe-path exemption, preflight
handling, `/.well-known/*` not passing through the gate, fail-closed behaviour
when `API_KEYS` is unset in production, and that the gate is attached with an
unchanged matcher. It builds with one `CORS_ORIGIN` and runs with another, so a
build-frozen value fails; and it diffs the public route set enumerated from the
built manifest against `scripts/request-gate-baseline.json` rather than
re-deriving it from `PUBLIC_PATHS`. If a route's classification legitimately
changes, review every printed `public` entry, then regenerate with
`node scripts/verify-request-gate.mjs --build --update-baseline`. CI runs it on
every push. The rationale for each check is in the script's header.

### Verifying the shipped image

`verify:gate` runs `next start`; the Docker image runs Next's **standalone**
output (`node server.js`), which `next start` cannot serve. So a separate
harness proves the properties above in the artifact that actually deploys:

```sh
npm run verify:image                        # host platform
npm run verify:image -- --platform linux/amd64
```

It builds the image, asserts against the built artifact (native binary and
OpenTelemetry tree present and loadable; traced externals, native modules,
the gate's matcher set, the compiled gate and its load path, and the compiled
routing tables equal a committed baseline in
`scripts/image-artifact-baseline.json`), then runs the image against an
ephemeral Postgres with the repo's migrations and checks gate attachment, the
revocation-list signature (verified independently of the signer), that
`CORS_ORIGIN` is read at runtime rather than baked at build time, and — in a
second container — the `OTEL_ENABLED=true` path. 27 checks in all; it needs the
dev dependencies installed (`npm ci`), because migrations run from the host.
In CI the `verify-image` job gates `docker-publish`.

The per-check rationale, baseline-regeneration rules, CI topology and teardown
behaviour are maintainer material and live in
[`internal_docs/IMAGE-HARNESS.md`](https://github.com/agentidentitytrustprotocol/aitp-control-plane/blob/main/internal_docs/IMAGE-HARNESS.md),
an index into the header of `scripts/verify-image.mjs`.

### Verifying the SSE stream in the shipped image

```sh
npm run verify:sse                             # builds, then runs the image
npm run verify:sse -- --no-build --tag <tag>    # reuse an image you already have
```

`scripts/verify-sse-stream.mjs` runs the shipped image and opens real SSE
connections to `GET /api/events/stream` on an **empty backlog** — the state of
a freshly deployed process, and the state issue
[#89](https://github.com/agentidentitytrustprotocol/aitp-control-plane/issues/89)
occurred in. Its seven checks: time to first byte under **1 s** (cold and warm);
the header contract (`text/event-stream`, `no-transform`,
`x-accel-buffering: no`, chunked, no `content-encoding`/`content-length` even
with `Accept-Encoding: gzip, br`); the first frame is exactly
`retry: <SSE_HEARTBEAT_MS>\n: connected\n\n` in one write; the heartbeat is the
next frame and on time; the `sse stream opened`/`closed` log lines reach stdout;
`503 SSE_CAPACITY` with `MAX_SSE_CONNECTIONS=1`; and both containers still
running at the end. The container runs with `SSE_HEARTBEAT_MS` at twice the
budget, so a heartbeat cannot pass the first-byte check for the prelude.

It uses no Postgres (the route touches no database; `/api/health` answering
`503` is the expected readiness signal there) and reads a raw socket rather
than `fetch`. In CI it is a second step in the `verify-image` job, against the
image that job already built. `--allow-skip` turns "no Docker daemon" into
exit 0 — never pass it in CI; the in-process equivalent is
`src/app/api/events/stream/stream.flush.test.ts`, which runs on every
`npm test`. Details are in the script's header.

The three harnesses are deliberately **not** merged: `verify:gate` owns the
`next start` path and its own build; `verify:image` owns the standalone
artifact and not the build environment (the `Dockerfile` does); `verify:sse`
owns one route's wire behaviour over time in that artifact.

## Rate limiting

In-memory, per-process token buckets on every `/api/*` route except the probes
(`/api/health`, `/api/readyz`, `/api/metrics`). Over-limit → `429 RATE_LIMITED`
with `Retry-After` and `X-RateLimit-*` headers.

**`/.well-known/*` is not rate-limited.** `/.well-known/aitp-manifest` and
`/.well-known/aitp-revocation-list` are rewrites to `/api/well-known/*`, and the
request gate (`src/proxy.ts`, matcher `/api/:path*`) sees the incoming path, not
the rewrite destination — so those two URLs bypass the gate entirely: no rate
limit, no CORS headers, no `x-request-id`. Both are public anyway; the same
handlers reached at `/api/well-known/*` do go through the gate. Any future
rewrite to a public path would carry the same cost. If you need a limit on the
discovery paths, apply it at the edge.

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

### "The stream never responds" — and the invariant that prevents it

> **THE INVARIANT. Every streaming route in this repo must write a byte at
> connect time, before any `await`.**
>
> Next.js deliberately withholds the response headers until the first body chunk.
> The adapter that pipes a route handler's `ReadableStream` into the Node
> `ServerResponse` calls `res.flushHeaders()` from its `write()` callback and
> nowhere else — `node_modules/next/dist/server/pipe-readable.js:59-74` (Next
> 16.3.8), whose own
> comment says so: *"this ensures that we don't actually flush the headers until
> we've started writing chunks."* It is intentional (it lets a handler still change
> the status while the body is pending) and it is not specific to
> `output: 'standalone'` — the same module serves `next start` and `next dev`.
>
> **So a stream that stays silent sends no status line and no headers at all.** Not
> a slow response: *no response*, indistinguishable from a hung connection, until
> something writes. `curl` reports `http=000`, zero bytes and exit 28.

That was issue
[#89](https://github.com/agentidentitytrustprotocol/aitp-control-plane/issues/89),
in full: `/api/events/stream` wrote nothing at connect, its in-process event bus is
empty on a fresh deploy so the backlog replay wrote nothing either, and the 15-second
heartbeat was therefore the first thing to put a byte on the wire. Every client with
a first-byte timeout under 15 s saw a dead hang. The fix is one `ctrl.enqueue` as the
literal first statement of `start()` — see the route's own comment there for the
constraint that keeps it a single write — and the before/after measurements are
recorded on issue #89 itself.

Nothing structurally prevents the next streaming route from repeating it, which is
why this is written down. A lint rule is not practical for the shape; the two things
that are:

- `src/app/api/events/stream/stream.flush.test.ts` — pipes the route's real
  `Response.body` through Next's real adapter into an `http.createServer` and asserts
  on a raw socket. Runs on every `npm test`. **Copy it for any new streaming route.**
- `npm run verify:sse` — the same property in the shipped image, measured. See
  [Verifying the SSE stream in the shipped image](#verifying-the-sse-stream-in-the-shipped-image).

#### If a "stream is dead" report arrives anyway

**Measure first, in this order.** The point is to place the delay on one side of a
boundary before touching anything:

```sh
# 1. The CP itself, directly. <1 s and `: connected` first = the route is healthy.
curl -sN -H "Accept: text/event-stream" -H "Authorization: Bearer $API_KEY" \
  "$CP_URL/api/events/stream" --max-time 8 \
  -o - -w '\nhttp=%{http_code} starttransfer=%{time_starttransfer}\n'

# 2. The same stream through the console's proxy route — the full production path.
curl -sN -H "Accept: text/event-stream" \
  https://aitp-ui-console.vercel.app/api/cp/events/stream --max-time 45 \
  -o - -w '\nhttp=%{http_code} starttransfer=%{time_starttransfer} total=%{time_total}\n'

# 3. Was the handler even reached? /api/metrics is public and rate-limit exempt.
curl -s "$CP_URL/api/metrics" | grep aitp_control_plane_sse_streams
```

Read the three together:

| What you see | What it means |
|---|---|
| `: connected` arrives first and `starttransfer` is well under the heartbeat interval | The stream works. Look at the client, not the server. **Reference numbers, measured:** **0.007 s** with `curl` against the CP's own container (2026-09-25; `verify:sse`'s own socket client reports 0.015-0.025 s for the same flush, its connect and request included); **0.33 s warm / 1.13-1.30 s cold through the production console** (2026-09-28) — the spread is TLS, cross-region routing and a cold Vercel function, not buffering, since a buffering layer does not sometimes take 0.3 s. Compare against 15.047 s before the fix. |
| `http=000`, zero bytes, exit 28 | No headers were ever sent. The invariant above is broken — a streaming route is writing nothing at connect. This is #89's exact signature. |
| `starttransfer` ≈ `SSE_HEARTBEAT_MS` | Same thing, seen from the other end: the *heartbeat* is flushing the headers. Do **not** "fix" it by lowering `SSE_HEARTBEAT_MS`; that hides it. |
| CP direct is fast, console path is slow | The residual delay is in the proxy/platform, not this repo. File it against `aitp-ui-console` with both numbers, noting that #89's root cause was CP-side and is fixed, and that its `proxySse()` was ruled out (a structurally identical route through the same function always returned immediately — because its upstream wrote a byte on connect, which is the whole of the invariant above). |
| `sse_streams_open` flat at `0` while a client claims to be connecting | The handler is not being reached at all. Look at the request gate, the URL, or the proxy — not at the route. |
| `sse_streams_opened_total` climbing while `sse_streams_open` stays flat | **A DIFFERENT SYMPTOM, not a regression of the #89 fix.** Streams are being accepted and then dying, which is what an edge idle timeout or a serverless function duration cap looks like. The console's route is a Vercel function holding the upstream `fetch` open for the life of the stream, so its `maxDuration` bounds every stream through it. Measured 2026-09-28: two streams through the console each survived a full 45 s uninterrupted, delivering the prelude plus exactly the two `: heartbeat` frames a 15 s interval predicts, so no such cap was in force then. Compare the dying interval against `SSE_HEARTBEAT_MS` and against that cap before suspecting the route. |

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

**Webhook secrets and the admin audit log.** A `PATCH /api/webhooks/:id` that
changes `secret` is audited as `secretRotated: true`, never by value. Earlier
releases wrote the new secret itself into `admin_audit_log.details`, where
`GET /api/audit` returned it to any API-key holder. Migration
`0008_scrub_webhook_secret_audit.sql` (applied by `npm run db:migrate`) removes
those values from existing rows, but it cannot un-read them: **rotate every
webhook secret that was ever set via PATCH** (PATCH a new `secret`, then update
the receiver).

## Trust-anchor JWKS refresh

A background job (started at boot from `src/instrumentation.ts`, interval
`unref`'d) caches each OIDC trust anchor's JWKS in `trust_anchors.jwks_cache`;
`GET /api/trust-anchors/:id/jwks` serves it. It runs one pass immediately at
boot, then every `JWKS_REFRESH_INTERVAL_MS` (floored at 1000 ms), and each pass
refreshes anchors whose cache is missing or older than `JWKS_STALE_AFTER_MS`,
using the anchor's `jwksUrl`, else `<issuerUrl>/.well-known/openid-configuration`
-> `jwks_uri`. A failed refresh logs `jwks-refresher: refresh failed for trust
anchor` and keeps the previous cache (so the endpoint can serve a stale keyset
while the issuer is down; check `X-JWKS-Cached-At`). Replicas refresh
independently (idempotent; no lock).

**After a URL change.** A `PATCH /api/trust-anchors/:id` that actually changes
`issuerUrl` or `jwksUrl` clears the anchor's cache in the same `UPDATE` (a
label-only edit, or resending the same URLs, keeps it). The next pass picks the
anchor up because its cache is missing, so `GET /api/trust-anchors/:id/jwks`
answers `503 JWKS_NOT_CACHED` for **up to `JWKS_REFRESH_INTERVAL_MS`** (longer
if the new issuer cannot be fetched, indefinitely with
`JWKS_REFRESH_ENABLED=false`). The PATCH deliberately does not start a refresh
of its own: the "one pass at a time" guard is per module instance, and the
route and the boot-time job are separate instances, so a route-triggered pass
could overlap the scheduled one. Each refresher write is conditional on the
anchor still having the `issuer_url` / `jwks_url` the pass read, so a pass that
was mid-fetch when the URLs changed cannot put the old issuer's keys back; it
logs `jwks-refresher: anchor URLs changed (or anchor deleted) during refresh;
keyset discarded` (info) and the next pass fetches the new keyset.

- **`JWKS_REFRESH_ENABLED`** (default true), **`JWKS_REFRESH_INTERVAL_MS`**
  (default 900000), **`JWKS_STALE_AFTER_MS`** (default 3600000),
  **`JWKS_FETCH_TIMEOUT_MS`** (default 10000).
- **Egress.** The CP now makes outbound requests to operator-supplied issuer URLs.
  Each fetch (including the discovered `jwks_uri`) must be http(s) — https only in
  production — and every resolved address must be public (same rule as webhook
  targets); redirects are refused and bodies over 1 MiB are rejected.
  `WEBHOOK_URL_ALLOWLIST` does not apply. The CP needs outbound HTTPS to your
  issuers; an anchor it cannot reach stays `JWKS_NOT_CACHED`.

## Observed-artifact verification

The CP is an observer: `tct.issued` / `handshake.complete` / `delegation.issued`
events are agent-reported, and by default the projection (`issued_tcts`,
`delegations`) records the reported claims without checking any signature.
`OBSERVED_ARTIFACT_VERIFICATION` opts into checking them:

- **`off`** (default) — no verification; unchanged behaviour.
- **`warn`** — when a report carries the v0.2 `{ token, claims }` wrapper, verify
  the compact-JWS `token` with the SDK. A failure is logged (`tct-monitor:
  observed artifact failed verification`) and the row is projected anyway.
  Claims-only reports are projected silently.
- **`strict`** — project only reports whose token verifies. Claims-only reports,
  tampered tokens, and **expired** tokens are dropped (logged at warn). Turn this
  on only if every reporter sends the signed token and reports promptly.

What verification covers is the SDK's — see `verifyTct` and `verifyDelegation`
in the [aitp-rs Node SDK guide](https://github.com/agentidentitytrustprotocol/aitp-rs/blob/main/docs/sdk-node.md#tct-verification-rfc-aitp-0005-72).
The CP's choices: a TCT is checked against its own `aud` and its **first**
grant, so the audience and grant checks are tautological and the real signal is
signature + expiry; a TCT with no grants fails. A delegation is checked with the
strict single-hop `verifyDelegation`, passing the delegation's own `aud` as the
verifier AID, so **multi-hop chains fail** (and are dropped under `strict`).
Verification does not consult the revocation list, and no `verified` flag is
persisted: the outcome only gates projection and is logged.

## Data retention

A periodic sweep keeps storage bounded. It is multi-instance safe via a Postgres
advisory lock (`pg_try_advisory_xact_lock`), so replicas don't duplicate work.

**It starts lazily, not at boot.** The retention sweep, the agent-expiry job
(every 5 min) and the webhook retry reaper (every 60 s) are all started by the
first `POST /api/events` a process receives; the retention sweep then runs once
immediately and every `RETENTION_INTERVAL_MS` after. A replica that never
receives an ingest never sweeps, never marks agents `expired` and never picks
up webhook retries left `pending` by an earlier process. The trust-anchor JWKS refresher is the exception: it starts at
boot. (Under Jest none of the lazy jobs start.)

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
- **Logs:** via pino. `LOG_LEVEL` ∈ `trace|debug|info|warn|error|fatal`
  defaults to `info` under `NODE_ENV=production` and `debug` otherwise.
  Production logs are structured JSON; outside production they are
  pretty-printed through `pino-pretty`. Every response that passes the request
  gate (all of `/api/*`, but not the `/.well-known/*` rewrites) carries
  `x-request-id` for correlation.
- **Tracing (OpenTelemetry):** off by default. Set `OTEL_ENABLED=true` to export
  spans over OTLP/HTTP. The CP hands the exporter
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, else `OTEL_EXPORTER_OTLP_ENDPOINT`, as
  its **full URL** — so `/v1/traces` is **not** appended to
  `OTEL_EXPORTER_OTLP_ENDPOINT`; include the path yourself
  (e.g. `http://otel-collector:4318/v1/traces`). With neither set the exporter
  uses `http://localhost:4318/v1/traces`.
  `OTEL_SERVICE_NAME` defaults to `aitp-control-plane`. HTTP, `pg`, and `fetch`
  are auto-instrumented. Because the flag is off by default, the enabled path has
  its own arm in `verify:image`: a second container is run with
  `OTEL_ENABLED=true`, every gate, signing and CORS assertion is re-run against
  it, and the SDK is proven to have actually started by asserting the debug log
  contains `Patching pg.Client.prototype.query`. **Span *export* is explicitly out
  of scope there** — no collector is involved — so a green run means "the OTel path
  loads and instruments in the shipped image", not "spans arrive".

### Metrics

All series are prefixed `aitp_control_plane_`. Three different kinds of value sit
in this table, and conflating them will give you wrong numbers:

- **Process-local** — `rate_limit_drops`, `admin_audit_insert_failures`,
  `event_backlog_dropped`, `events_dropped_total`, `enroll_verification_failures`,
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
| `events_dropped_total` | counter | — | `POST /api/events` items dropped by per-item validation (column limit, NUL, lone UTF-16 surrogate in `payload`/`grants`, nesting); the rest of each batch was ingested |
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
  (`400 BODY_INVALID`, `400 MANIFEST_INVALID`). Never reaches the SDK. (The
  CP's `MANIFEST_INVALID` is broader than the
  [error-code registry](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/registries/error-codes.md)'s
  schema-only meaning; see [`api.md`](api.md).)
- **`503 SERVER_MISCONFIGURED`** — a server with no usable `ENROLLMENT_SECRET`
  rejects *every* enrollment while this counter stays flat at zero. The same
  fault also 503s every `POST /api/registry/agents`, and that half is invisible
  here in a stronger sense: this counter is the enroll route's alone, so the
  register route contributes nothing to it under any condition — not even when
  it is failing for exactly this reason. **A production process can no longer
  reach this state from a bad env var** — the boot check exits before serving —
  so in production this is now mostly a *deploy-time* failure you read in the
  container's first log lines rather than a runtime one you infer from a 5xx rate.
  Everything below still applies to non-production servers, which start anyway by
  design.
- **The rethrow to `500`** — an unclassifiable internal fault.

The first two are the loudest fleet-wide breakages, and — be blunt about it —
**nothing in this process increments on either of them**: the route logs only
classified verification failures, `src/proxy.ts` has no logger at all, and
`rate_limit_drops` moves only on a `429`. The register half of the `503` is
equally unlogged, and there is no register-side *failure* counter to catch it
either. So no counter here rises when this breaks; the detection path is your
ingress or load balancer: alert on the `5xx` rate of **both** registry POSTs —
`/api/registry/enroll` and `/api/registry/agents` — and on a sustained `400`
rate, not on this counter. (Something does go *quiet*, which is a weaker but real
signal — see below.)

For the bad-secret half specifically there is now one loud signal, and it is at
the front of the deploy rather than in the metrics: a production process with an
unusable `ENROLLMENT_SECRET` prints `[aitp-cp] FATAL: …` and exits `1`, so the
release fails its healthcheck and never takes traffic. That does not replace the
ingress alert — it covers a bad *env var*, not a secret that was valid at boot and
is now the wrong one (a rotation, say, which no boot check can detect) — but it
does mean a fleet-wide enrollment outage caused by configuration should reach you
as a failed deploy, not as a 5xx graph.

Because both routes construct the same service, a bad secret hits both at once —
so you never need the second route to corroborate the first. **But a `5xx` alone
is not the diagnosis: read the `code` in the body.** `SERVER_MISCONFIGURED` is
this fault. A `500` is an unclassifiable internal fault and belongs in the pod
logs — and note that the register POST has more ways to produce one than enroll
does, because it writes to Postgres (the jti consume, the upsert, the audit
ingest) while enroll's happy path touches no database at all. A plain database
outage therefore shows up as a sustained `5xx` rate on `/api/registry/agents`
**alone**, with a perfectly good `ENROLLMENT_SECRET`. Do not rotate the secret on
the strength of a `5xx` rate; confirm the `code` first.

**For the bad-secret fault specifically** — not the database variant just
described — there is one in-process *metric* signal, and it is an absence rather
than an increment: `audit_events{type="agent.registered"}` stops rising for the
whole outage, as does `agents_active`. Nobody can register, so nothing is
recorded. It does not tell you *why*, which is what the `code` is for, and it is
slow: you are waiting to notice that something stopped, so ingress `5xx` is still
the faster alert — and the boot failure above is faster than either, when the
cause is the environment.

That signal does **not** transfer to the database variant, for the reason given
above: those two series are DB-derived, so during a database outage they are
*absent* from the scrape entirely rather than flat, and a rate-based alert on them
goes no-data instead of firing. `db_up 0` is the signal there.

The third — the rethrow to `500` — *is* visible, but only in the application log:
Next prints the error and a stack trace to stderr. So during a `500` incident
read the pod logs; for the other two there is nothing there to read.

Its `code` label is a bounded set of **ten** values — the eight codes the `aitp`
SDK documents for manifest verification, plus:

- `none` — the manifest was rejected by *this service* rather than by the SDK
  (a `manifest.aid` that is not an AID, an `expires_at` inside the 5-minute
  registration window, or a value the `agents` row cannot store, such as a
  `display_name` over 256 characters). The SDK accepted it; we did not.
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

- **`GET /api/health`** — DB ping plus the CP's identity. Answers `503` with
  `db: "error"` whenever the database ping fails, and builds the CP manifest on
  every call, so it is also where identity setup is first reached (a production
  process without `CP_AID_SEED_HEX` answers `500` here). It ignores the drain
  flag, so it stays `200` while draining.
- **`GET /api/readyz`** — readiness: not draining, and the database answers
  `SELECT 1`. It does **not** check identity (that is `/api/health`'s and the
  manifest handler's business). See the section below for what else it
  deliberately leaves out.

On SIGTERM the process enters a drain window: `/api/readyz` flips to
`503 { "ready": false, "reason": "shutting_down" }` so a load balancer pulls the
pod out of rotation, while `/api/health` stays `200` (database permitting) so the
orchestrator doesn't hard-kill it mid-drain. Point your LB/orchestrator readiness
probe at `/api/readyz`.

> **Liveness hazard: do not use `/api/health` as a restart-triggering liveness
> probe unless you accept restarts on a database outage.** Because it answers
> `503` whenever the database is unreachable, an orchestrator that restarts on
> failed liveness will restart every replica during a DB outage — a restart loop
> that cannot fix the cause and drops in-memory state (SSE streams, rate-limit
> buckets, breaker state) on the way. It is fine as a **deploy** healthcheck
> (`railway.json` uses it, and a seed or database fault should fail a deploy).
> For a liveness probe, prefer a TCP/port check or a long failure threshold, and
> use `/api/readyz` for readiness.

### What `/api/readyz` deliberately does not check

It checks the drain flag and `SELECT 1`, and nothing else. In particular it does
**not** check `ENROLLMENT_SECRET`, and that is a decision rather than an
oversight (issue #99 asked for exactly that and it was answered at boot instead):

- **A readiness probe is for conditions that can change while a process runs.**
  The secret cannot. It is snapshotted from the environment at module load and
  the enrollment service memoizes on first success, so one process's verdict on
  it is fixed for the process's whole life. Failing readiness on a constant could
  only ever mean "this process should never have started" — so the honest place
  to say that is startup, which is where it is now said.
- **The blast radius is wrong.** A `503` from `/api/readyz` removes the replica
  from rotation for *every* route — discovery, the revocation list, sessions,
  audit — over a fault that affects two POSTs, and nothing the replica can do
  will clear it. The two routes' own `503 SERVER_MISCONFIGURED` is the
  proportionate answer, and `POST` callers get a `code` that names the fault.
- **It would not have caught the deploy anyway.** `railway.json` points the
  platform healthcheck at `/api/health`, not `/api/readyz`, so a readyz-only
  check would leave the very deploy this was reported against green.

If you add a check here, the bar is that a *running* replica can genuinely enter
and leave the state — a lost database connection qualifies, a startup config
value does not.

## Database

- **`DATABASE_URL`** — Postgres connection string (required).
- **`DB_POOL_MAX`** (default 20) — connection pool size.
- Migrations run via `npm run db:migrate` from a checkout; the runtime image
  does not bundle `drizzle-kit` — which is also why `verify:image` applies them
  from the host rather than from inside the container. See the internal
  [deployment guide](https://github.com/agentidentitytrustprotocol/aitp-control-plane/blob/main/internal_docs/DEPLOY.md)
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
