#!/usr/bin/env node
/**
 * SSE streaming conformance in the SHIPPED IMAGE — the container-level gate on
 * issue #89 (plan `plans/sse-stream-header-flush.md`, Phase 4).
 *
 * #89 was: `GET /api/events/stream` wrote no bytes at connect, and Next defers
 * `res.flushHeaders()` to the first body chunk
 * (`node_modules/next/dist/server/pipe-readable.js:59-74`), so on a quiet control
 * plane NO STATUS LINE AND NO HEADERS reached the client until the 15-second
 * heartbeat fired. Any client or proxy with a sub-heartbeat first-byte timeout saw
 * an indefinite hang. Phase 1 fixed it with a connect-time prelude; this harness is
 * the check that the fix holds in the artifact that actually deploys.
 *
 * ── WHY THIS CANNOT BE A UNIT TEST ─────────────────────────────────────────
 * The defect lives in the ADAPTER between a route handler's `Response` and the
 * Node `ServerResponse`. A test that calls `GET()` receives the `Response` object
 * and can never observe `res.flushHeaders()`. Two cheaper tiers already exist and
 * neither subsumes this one:
 *   - `src/app/api/events/stream/stream.test.ts` — the route's own behaviour.
 *   - `src/app/api/events/stream/stream.flush.test.ts` — pipes the route's real
 *     `Response.body` through Next's real `pipeToNodeResponse` into an
 *     `http.createServer` and asserts on a raw socket. That DOES observe the flush,
 *     runs on every `npm test`, and is the fast gate.
 * What only this harness can do:
 *   - it exercises the SHIPPED ARTIFACT — the standalone build, `node server.js`,
 *     and Next's real `router-server.js` compression middleware in the request
 *     path, which is the only place the `no-transform` / no-`content-encoding`
 *     assertions mean anything at all; and
 *   - it depends on no internal Next import that a version bump could rename.
 * Read the three as layered, not redundant.
 *
 * ── WHAT THIS FILE ASSERTS ─────────────────────────────────────────────────
 * Against a container running the image, with NO events ever published — the
 * empty-backlog case, which is exactly the production case on a fresh deploy and
 * the one case every backlog test in `stream.test.ts` pre-seeds past:
 *
 *   1. RESPONSE HEADERS FLUSH AT CONNECT. Time from `net.connect()` to the first
 *      response byte, twice: on the route's first-ever request (cold, so the route
 *      chunk load is in the number) and on a second connection (warm). Both must
 *      land inside FLUSH_BUDGET_MS. This is the #89 regression gate.
 *   2. THE STREAMING HEADER CONTRACT, with `Accept-Encoding: gzip, br` on the
 *      request: `content-type: text/event-stream`, `cache-control` containing
 *      `no-transform`, `x-accel-buffering: no`, `transfer-encoding: chunked`, and
 *      NO `content-encoding` and no `content-length`.
 *   3. THE FIRST BODY FRAME IS EXACTLY THE PRELUDE — byte equality against
 *      `retry: <SSE_HEARTBEAT_MS>\n: connected\n\n`.
 *   4. THE SECOND FRAME IS EXACTLY ONE `: heartbeat\n\n`, arriving no sooner than
 *      half and no later than three times SSE_HEARTBEAT_MS.
 *   5. THE ROUTE'S LIFECYCLE LOG LINES reach the container's stdout.
 *   6. OVER THE CAP, a second concurrent stream is refused `503` with
 *      `code: SSE_CAPACITY` — in a SECOND container started with
 *      `MAX_SSE_CONNECTIONS=1`, so exactly one variable differs.
 *   7. BOTH CONTAINERS ARE STILL RUNNING at the end.
 *
 * Checks 3 and 4 are what make check 1 non-vacuous, and the direction matters. A
 * fast first byte is only evidence of a PRELUDE flush if the bytes were the
 * prelude: on pre-Phase-1 code the first bytes are a `: heartbeat\n\n` at
 * `SSE_HEARTBEAT_MS`, which is a flush too. So the harness runs the container with
 * SSE_HEARTBEAT_MS = 2 * FLUSH_BUDGET_MS (asserted below, not assumed), which
 * makes "inside the budget" and "the heartbeat did it" mutually exclusive
 * arithmetic rather than a matter of interpretation. Check 4's byte equality then
 * rules out the other way to satisfy check 1 for the wrong reason — a replayed
 * backlog event — and check 3 rules out both at once.
 *
 * ── WHAT IS OUT OF SCOPE ───────────────────────────────────────────────────
 *   - GATE ATTACHMENT. That an anonymous request is refused, that the matcher is
 *     unchanged, that the compiled gate is the reviewed gate: all
 *     `scripts/verify-image.mjs`. This harness sends a valid API key and asserts
 *     nothing about what happens without one.
 *   - THE ROUTE'S LOGIC — dedup, backlog replay, the query filters, the capacity
 *     counter's arithmetic. Unit-tested against the source, where a failure names a
 *     line instead of a container.
 *   - THE DATABASE. Deliberate, and the one place this harness diverges from
 *     `verify-image.mjs`'s substrate on purpose rather than by omission — see
 *     NO POSTGRES below.
 *   - SPAN EXPORT, OTel, signing, CORS. All the sibling's.
 *
 * ── THREE HARNESSES, ON PURPOSE. DO NOT MERGE THEM. ────────────────────────
 *   - `verify-request-gate.mjs` owns the `next start` path and its own build.
 *   - `verify-image.mjs` owns the standalone artifact's STRUCTURE and its gate,
 *     signing, CORS and OTel paths — on a live Postgres substrate.
 *   - THIS file owns ONE ROUTE'S WIRE BEHAVIOUR OVER TIME in that same artifact.
 *     It is the only one of the three that measures a LATENCY and the only one
 *     that holds a connection open across seconds.
 * Duplicated assertions rot at different rates. In CI this runs as a second step
 * inside the `verify-image` job against the image that job has already built
 * (`--no-build --tag …`), because rebuilding the same image in a parallel job
 * would cost a second cold build for nothing — a separate FILE, a shared BUILD.
 *
 * NO POSTGRES, AND WHY THAT IS NOT A CORNER CUT. `verify-image.mjs` stands up a
 * network, a Postgres and the repo's migrations because its assertions are vacuous
 * without them (an unmigrated database still answers `db: "ok"`, and the revocation
 * producer publishes an empty-but-validly-signed list on a failed read). Here the
 * opposite holds. `/api/events/stream` touches no database: its event bus is a
 * plain array on a `globalThis` singleton (`src/lib/audit/stream.ts`), and the
 * assertions are about the first bytes on a socket. A database would COST
 * fidelity, not add it — an audit write would publish into the bus, the backlog
 * would stop being empty, and a replayed `data:` frame could flush the headers
 * instead of the prelude, which is check 1 passing for exactly the wrong reason.
 * So the container runs with DATABASE_URL pointed at a closed port, on purpose,
 * and `/api/health` answering `503` is the CORRECT readiness signal here (the
 * process is up; the database is not).
 *
 * RAW SOCKET, NOT `fetch`. The plan specified undici/`fetch` over shelling out to
 * curl, for a precise first-header timestamp. This goes one step further and
 * writes the request bytes to a `node:net` socket, for reasons that are specific
 * rather than stylistic:
 *   - #89's symptom is literally "not even an HTTP status line". A raw socket
 *     measures exactly that and can assert on the status line's bytes.
 *   - `fetch` is a client that TRANSFORMS what it reports: undici injects its own
 *     `accept-encoding`, may decompress a body, and normalises headers. Check 2
 *     asserts on the presence and ABSENCE of content coding, so a client that
 *     helpfully handles content coding is the wrong instrument.
 *   - the prelude assertion is a BYTE EQUALITY, and the bytes must be the ones the
 *     server sent, de-chunked here rather than by something whose framing rules
 *     are not in this file.
 * The cost is a chunked-transfer decoder in this file. It is a pure function, and
 * it is reachable without Docker through `--parse-fixture` for exactly the reason
 * `verify-image.mjs` exposes its log scan through `--scan-fixture`: there is no
 * test runner wired to a `.mjs` script in this repo, so a pure function with no
 * hook is not falsifiable from a diff plus output. `--dump-wire` writes the raw
 * bytes of a real run, which is how a fixture gets made in the first place.
 *
 * ── RESOURCE LIFECYCLE ─────────────────────────────────────────────────────
 * The rules, and the measurements behind them, are `verify-image.mjs`'s; this file
 * follows them rather than re-deriving them, and the constants below cite it. A CI
 * job of the sibling harness once passed every check and then hung for 18 minutes
 * because a killed child's stdio pipes stayed open.
 *   - Containers are registered for teardown BEFORE they are created: `docker rm -f`
 *     issued between the daemon creating a container and starting it removes
 *     nothing, which is how an earlier revision of the sibling leaked twelve
 *     containers in state `created`.
 *   - Containers start DETACHED (`docker run -d`), so nothing long-lived is ever a
 *     child of this process, and logs are read with ONE-SHOT `docker logs`, never
 *     `-f`.
 *   - ONE synchronous teardown, wired to `finally`, `process.on('exit')`, SIGINT
 *     and SIGTERM. Synchronous because an exit handler cannot await. Each signal
 *     handler calls `process.exit(1)` AFTER cleanup: installing a listener
 *     SUPPRESSES Node's default disposition, so a handler that only cleans up
 *     leaves the process alive on Ctrl-C.
 *   - THE SOCKETS ARE PART OF TEARDOWN, and they are this file's own resource
 *     class — the sibling has none. An SSE socket is by construction a long-lived
 *     handle on a stream that never ends, so a socket left open is precisely the
 *     "lingering handle turns a passing run into a silent hang" failure the
 *     sibling's explicit `process.exit(0)` exists to prevent. They are registered
 *     on creation and destroyed first in cleanup.
 *   - Teardown also sweeps BY LABEL, because the name registry cannot see a
 *     container the daemon created after teardown began.
 *   - The watchdog timer is `.unref()`ed, and the BUILD has its own separate
 *     timeout so "the build hung" and "a check hung" are distinguishable.
 *
 * ONE HONEST DIFFERENCE FROM THE SIBLING'S TEARDOWN: it gets a second container
 * sweep for free, because its network sweep spends another quiet window after the
 * container sweep ends, during which a late container create would otherwise be
 * invisible. This harness creates NO NETWORK (there is no Postgres to reach, so
 * the default bridge with a published loopback port is enough), so there is no
 * second window to piggyback on and the container reach is the one sweep's ~4.3 s.
 * Measured in the sibling over 24 SIGINT runs, late arrivals were detected
 * 284-618 ms in, and a deliberate 2.9 s arrival was still caught — so 4.3 s is
 * ample rather than lucky. Anything later is what `--prune` is for.
 *
 * Usage:
 *   node scripts/verify-sse-stream.mjs [options]
 *     --platform <os/arch>   one platform per invocation (default: host)
 *     --tag <tag>            image tag to build/use
 *     --no-build             reuse an existing local tag
 *     --keep                 skip Docker teardown (prints the cleanup commands)
 *     --prune                sweep leaked containers from an earlier crashed run
 *     --allow-skip           exit 0 with a message when Docker is unavailable
 *     --parse-fixture <file> run ONLY the wire parser over a local file and exit
 *     --dump-wire <file>     also write the measured connection's raw bytes
 *     --help
 *
 * Needs no host dev dependencies: no migrations, so no `drizzle-kit`, so `npm ci`
 * on the host is not a prerequisite the way it is for `verify-image.mjs`.
 *
 * Testability hooks, same rationale as the sibling's:
 *   AITP_VERIFY_SSE_WATCHDOG_MS   overrides the post-build ceiling
 *   AITP_VERIFY_SSE_BUILD_MS      overrides the build ceiling
 *   AITP_VERIFY_SSE_PAUSE_MS      holds the run up with BOTH containers and an
 *                                 OPEN STREAM SOCKET live, so teardown on a signal
 *                                 can be aimed at the state that actually has
 *                                 something to leak. That window is under a second
 *                                 wide otherwise, and a property that cannot be
 *                                 tested on demand is one that rots.
 *   AITP_VERIFY_SSE_SWEEP_TRACE=1 makes the label sweep say when it caught a late
 *                                 arrival, so "nothing was ever there" and
 *                                 "something appeared late and was swept" stop
 *                                 looking identical.
 *
 * NOT torn down: the IMAGE, exactly as in the sibling — it is left in the local
 * daemon under a deterministic tag so a failure can be re-probed with `--no-build`.
 * Remove it by hand (`docker image rm <tag>`); `--prune` does not touch images. One
 * consequence: the tag is not run-unique, so pass `--tag` when running two
 * platforms concurrently.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Label on every resource, so `--prune` can sweep orphans from a crashed run. */
const LABEL = 'aitp-verify-sse';
const RUN_LABEL = 'aitp-verify-sse-run';
/** Run-unique id, so two concurrent runs share the daemon without colliding. */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ── the numbers the assertions turn on ──────────────────────────────────────
/**
 * The #89 gate: how long the first response byte may take.
 *
 * 1 s is the plan's acceptance criterion, and it is loose on purpose — the
 * measured figure is ~7 ms in a native container and 4.7 ms in the in-process
 * adapter harness, so this has two orders of magnitude of headroom and is not a
 * performance assertion. What it is is the boundary between "the prelude flushed
 * the headers" and "nothing wrote until the heartbeat", which is the whole of #89.
 */
const FLUSH_BUDGET_MS = 1000;
/**
 * `SSE_HEARTBEAT_MS` for the container under test. NOT the 15 000 default, and the
 * value is load-bearing twice over:
 *   - it must be at least 2x FLUSH_BUDGET_MS, or a heartbeat could land inside the
 *     budget and check 1 would pass on pre-Phase-1 code. Asserted at startup, so
 *     editing one constant without the other fails loudly instead of quietly
 *     weakening the gate.
 *   - it must be SHORT, because check 4 waits for a real heartbeat on a real
 *     socket, and at the default that is a 15-second sleep per run.
 * 2 s also keeps the whole run comfortably inside the plan's "under ~60 s
 * excluding the build" criterion.
 */
const HEARTBEAT_MS = 2000;
if (HEARTBEAT_MS < FLUSH_BUDGET_MS * 2) {
  // Not a `fail()`: this is a contradiction in the file itself, discovered before
  // any Docker call, and it must not be reportable as a check result.
  console.error(
    `verify-sse-stream: HEARTBEAT_MS (${HEARTBEAT_MS}) must be at least twice ` +
      `FLUSH_BUDGET_MS (${FLUSH_BUDGET_MS}), or "the headers flushed inside the budget" ` +
      'and "the first bytes were a heartbeat" stop being mutually exclusive and check 1 ' +
      'would pass against pre-Phase-1 code. Fix the constants, not this message.',
  );
  process.exit(1);
}
/**
 * The prelude the route writes as the first statement of `start()`, as a function
 * of the heartbeat interval in force. This is a COPY OF THE WIRE CONTRACT, kept
 * here deliberately and not derived from `src/app/api/events/stream/route.ts`:
 * re-deriving the expectation from the code under test is the tautology
 * `verify-request-gate.mjs` records as the reason its baseline is committed. The
 * same bytes are documented for clients in `docs/api.md` (the "first bytes are a
 * prelude" section) and in `openapi.yaml`, so a change here is a change to a
 * documented contract and should fail this check.
 */
const PRELUDE = `retry: ${HEARTBEAT_MS}\n: connected\n\n`;
/** The keepalive frame. A comment frame, which every conformant SSE parser drops. */
const HEARTBEAT_FRAME = ': heartbeat\n\n';
/**
 * Must be NON-EMPTY. The image runs `NODE_ENV=production`, where an empty
 * `API_KEYS` makes the gate answer `503 SERVER_MISCONFIGURED` on every gated
 * route — so an empty value here would silently exercise the gate's fail-safe
 * instead of the stream.
 */
const API_KEY = 'verify-sse-harness-key-0000';
/** A fixed NON-PRODUCTION seed, so identity-touching routes answer normally rather
 *  than throwing into the logs this harness reads. Not a secret. */
const SEED_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

// ── timeouts ────────────────────────────────────────────────────────────────
const DEFAULT_DOCKER_MS = 60_000;
/**
 * Post-build ceiling. Budget, so it can be kept in step with the run: TWO app
 * boots at APP_READY_MS (8 min) plus the checks, which are seconds — the longest
 * is check 4's one heartbeat interval. 10 minutes leaves real headroom without
 * sitting so far above the run that a genuine hang burns a CI slot. Keep
 * BUILD_MS_NATIVE + this below the `verify-image` job's `timeout-minutes`, which
 * this harness shares in CI.
 */
const WATCHDOG_MS = Number(process.env.AITP_VERIFY_SSE_WATCHDOG_MS) || 10 * 60_000;
/** Build ceilings, separate from the watchdog so "the build hung" and "a check
 *  hung" are distinguishable. Same figures as the sibling harness. */
const BUILD_MS_NATIVE = Number(process.env.AITP_VERIFY_SSE_BUILD_MS) || 25 * 60_000;
const BUILD_MS_EMULATED = Number(process.env.AITP_VERIFY_SSE_BUILD_MS) || 60 * 60_000;
/** Readiness deadline, generous enough for an emulated boot. Elapsed time is
 *  printed on success so a slow boot is visible rather than mysterious. */
const APP_READY_MS = 240_000;
/**
 * How long a connection may stay silent before the harness gives up on it.
 *
 * Deliberately larger than both FLUSH_BUDGET_MS and HEARTBEAT_MS: against
 * pre-Phase-1 code the first byte arrives AT the heartbeat, and the failure
 * "2001 ms, which is SSE_HEARTBEAT_MS — the first bytes were a heartbeat, not a
 * prelude" is worth far more than "timed out with nothing". Both diagnoses exist;
 * this is what buys the better one.
 */
const WIRE_DEADLINE_MS = Math.max(FLUSH_BUDGET_MS * 8, HEARTBEAT_MS * 4);

// ── teardown sweep window ───────────────────────────────────────────────────
/**
 * How long the daemon's label-filtered listing must stay EMPTY before the sweep
 * believes it, measured from the last sighting so any late arrival resets it.
 *
 * These three numbers are `verify-image.mjs`'s, and they were bought with
 * measurement rather than taste: at ~300 ms a probe container leaked in state
 * `created` in 1 run out of 24, because the daemon finished creating it after the
 * sweep concluded. Do not re-derive them here — read that file's SWEEP_QUIET_MS
 * comment and keep the two in step.
 */
const SWEEP_QUIET_MS = 4_000;
const SWEEP_BUDGET_MS = 20_000;
const SWEEP_MAX_LIST_ERRORS = 5;

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    platform: null,
    tag: 'aitp-control-plane:verify-sse',
    build: true,
    keep: false,
    prune: false,
    allowSkip: false,
    parseFixture: null,
    dumpWire: null,
    help: false,
  };
  /** A value-taking flag must actually be followed by a value, not by nothing and
   *  not by the next flag — otherwise `--tag` as the last token would silently fall
   *  back to the default and the run would verify something other than what was
   *  asked for. */
  const value = (flag, i) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--platform':
        opts.platform = value(a, ++i);
        break;
      case '--tag':
        opts.tag = value(a, ++i);
        break;
      case '--no-build':
        opts.build = false;
        break;
      case '--keep':
        opts.keep = true;
        break;
      case '--prune':
        opts.prune = true;
        break;
      case '--allow-skip':
        opts.allowSkip = true;
        break;
      case '--parse-fixture':
        opts.parseFixture = value(a, ++i);
        break;
      case '--dump-wire':
        opts.dumpWire = value(a, ++i);
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${a} (try --help)`);
    }
  }
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  // Parsing happens before main(), so without this an unknown flag prints a raw
  // Node stack trace instead of one actionable line.
  console.error(`verify-sse-stream: ${err.message}`);
  process.exit(1);
}

const HELP = `verify-sse-stream — prove GET /api/events/stream flushes its response
headers at connect time in the shipped standalone Docker image (issue #89).

  node scripts/verify-sse-stream.mjs [options]

  --platform <os/arch>   one platform per invocation (default: the host's).
                         A comma-separated list is rejected: "docker buildx
                         build --load" cannot load a multi-platform manifest.
  --tag <tag>            image tag to build and run
                         (default aitp-control-plane:verify-sse). In CI this is
                         pointed at the image the verify-image job already built.
  --no-build             reuse an existing local tag instead of building
  --keep                 skip Docker teardown and print the cleanup commands
  --prune                remove containers left by an earlier crashed run, then exit
  --allow-skip           when Docker is unavailable, print why and exit 0 instead
                         of failing. For a dev machine without a daemon; never
                         pass it in CI, where a silent skip is a green run that
                         checked nothing.
  --parse-fixture <file> run ONLY the wire parser (chunked-transfer decode + SSE
                         frame split) over a local file and exit: 0 if it parses,
                         1 if it does not. No Docker, no image, no container. This
                         exists so the one piece of non-trivial pure logic in this
                         file is falsifiable by hand — there is no test runner
                         wired to a .mjs script in this repo. Make a fixture with
                         --dump-wire, then edit it and watch this reject it.
  --dump-wire <file>     also write the measured connection's RAW received bytes
                         (status line, headers, chunk framing and all) to a file.
                         A debugging aid and the way to produce a --parse-fixture
                         input from a real run.
  --help                 this text
`;

// ── resource registry ───────────────────────────────────────────────────────
/** Containers created this run. Registered BEFORE creation, never after. */
const containers = new Set();
/**
 * Was a container EVER registered this run? The registry empties on teardown, so it
 * cannot answer this on its own.
 *
 * It gates the label sweep, and the reasoning is what makes that safe: registration
 * strictly precedes `docker run`, so if nothing was ever registered then no
 * container can carry this run's label and there is nothing for a sweep to find.
 * Without the gate, every run that creates nothing — `--help`, `--parse-fixture`,
 * `--prune`, a machine with no daemon — spends five failing `docker ps` listings and
 * then prints "teardown CANNOT confirm it left nothing behind", which is alarming,
 * slow, and false.
 */
let everRegisteredContainer = false;
/**
 * Open sockets. THIS harness's own resource class, and the reason teardown here is
 * not just a copy of the sibling's: an SSE socket is a handle on a stream that by
 * design never ends, so one left open keeps the event loop alive forever.
 */
const sockets = new Set();
/** Live `docker` CLI children, so no pipe can outlive a signal. */
const liveChildren = new Set();

function nameFor(kind) {
  return `${LABEL}-${RUN_ID}-${kind}`;
}

function labelArgs() {
  return ['--label', `${LABEL}=1`, '--label', `${RUN_LABEL}=${RUN_ID}`];
}

// ── docker plumbing ─────────────────────────────────────────────────────────
/**
 * Run a `docker` command and capture its output.
 *
 * The child is tracked so a signal or the watchdog can kill it and destroy its
 * pipes; the per-call timeout means one wedged docker invocation cannot consume
 * the whole ceiling.
 */
function docker(args, { timeoutMs = DEFAULT_DOCKER_MS, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    liveChildren.add(child);
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      reject(new Error(`could not run \`docker ${args[0]}\`: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      // Drop our end of the pipes so they cannot pin the event loop.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (timedOut) {
        reject(new Error(`\`docker ${args.join(' ')}\` timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0 && !allowFail) {
        reject(
          new Error(
            `\`docker ${args.join(' ')}\` exited ${code}\n${(err.trim() || out.trim()).slice(0, 4000)}`,
          ),
        );
        return;
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

/**
 * Run a `docker` command with its output inherited (live progress, no pipes).
 *
 * Used for the build: it is the one long-running invocation, and inheriting stdio
 * means there is no pipe to leak in the first place.
 */
function dockerStream(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    liveChildren.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      reject(new Error(`could not run \`docker ${args[0]}\`: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      if (timedOut) {
        reject(
          new Error(
            `the image build exceeded its own ${Math.round(timeoutMs / 60_000)}-minute ` +
              'timeout (separate from the post-build watchdog, so this is "the build hung", ' +
              'not "a check hung")',
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(new Error(`\`docker ${args.slice(0, 3).join(' ')} ...\` exited ${code}`));
        return;
      }
      resolve();
    });
  });
}

// ── teardown ────────────────────────────────────────────────────────────────
function killLiveChildren() {
  for (const child of liveChildren) {
    // Every child here is a `docker` CLI invocation spawned without `detached`, so
    // none leads a process group of its own and a plain kill is the whole story.
    // The sibling harness needs a group kill because it spawns `npm run db:migrate`
    // (npm with drizzle-kit as a grandchild); this file runs no migrations, and
    // adding the group machinery for children that have no group would be a
    // negative-pid kill waiting for a pid it does not own.
    try {
      child.kill('SIGKILL');
    } catch {
      /* genuinely gone */
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  liveChildren.clear();
}

/**
 * Destroy every socket this run opened.
 *
 * `destroy()` and not `end()`: a half-close on an SSE stream leaves the server
 * writing into a socket nobody reads, and this runs from paths that cannot wait
 * for a graceful close (the `exit` handler, a signal). Registry emptied first so a
 * second call is a no-op.
 */
function destroySockets() {
  for (const s of [...sockets]) {
    sockets.delete(s);
    try {
      s.destroy();
    } catch {
      /* already gone */
    }
  }
}

function printKeepInstructions() {
  const cs = [...containers];
  if (!cs.length) return;
  console.log('\n--keep: containers left running. Remove them with:');
  console.log(`  docker rm -f -v ${cs.join(' ')}`);
  console.log('  # or sweep every orphan of this harness: node scripts/verify-sse-stream.mjs --prune');
}

/** Block the thread. Only ever called from teardown, where nothing else may run. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A synchronous `docker` listing, which THROWS rather than reporting nothing.
 *
 * The distinction is load-bearing and was a measured bug in the sibling: reading
 * `stdout` unconditionally means a `docker` that exited 125, or was not on PATH,
 * returns `[]` — indistinguishable from "the daemon holds nothing". The sweep
 * would then count that as quiet, conclude teardown was clean, and leak in
 * silence. A daemon that cannot answer is not evidence of an empty daemon.
 */
function dockerSyncLines(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 20_000 });
  if (r.error) throw new Error(`\`docker ${args[0]}\` could not run: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `\`docker ${args.join(' ')}\` exited ${r.status}: ` +
        (String(r.stderr ?? '').trim() || '(no stderr)').slice(0, 300),
    );
  }
  return String(r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

let sweepDone = false;
let keepPrinted = false;

/**
 * THE ONLY TEARDOWN. Synchronous, and used by every exit path: the end of
 * `main()`, the error path, `process.on('exit')`, SIGINT and SIGTERM.
 *
 * Synchronous because an exit handler cannot await, so async teardown there
 * silently does nothing — and having ONE implementation means the path that is
 * hardest to test cannot drift from the path that is easy to test.
 *
 * Idempotent: every registry is emptied on the first call.
 */
function cleanupSync() {
  // Sockets FIRST and unconditionally, before the `--keep` early return. `--keep`
  // is a promise about the CONTAINERS a reader may want to re-probe; a dangling
  // socket is not something anyone inspects, and it is the one resource here that
  // can hang this process rather than merely outlive it.
  destroySockets();
  killLiveChildren();
  if (opts.keep) {
    if (!keepPrinted) {
      keepPrinted = true;
      printKeepInstructions();
    }
    return;
  }
  // A signal handler runs cleanup and then `process.exit(1)`, which fires the
  // 'exit' handler, which would otherwise repeat the whole label sweep for
  // nothing. Idempotence is kept (the registry is emptied on the first call);
  // this only skips the redo.
  if (sweepDone && !containers.size) return;
  // See everRegisteredContainer: nothing was ever registered, so nothing can bear
  // this run's label, so there is nothing to sweep and no "cannot confirm" to report.
  if (!everRegisteredContainer) {
    sweepDone = true;
    return;
  }
  const cs = [...containers];
  containers.clear();

  // Fast path: remove what we know we created, by name. `-v` because an image that
  // declares a VOLUME makes an anonymous volume on `docker run`, and `docker rm -f`
  // without it strands one — a leak no container registry can see.
  for (const c of cs) {
    spawnSync('docker', ['rm', '-f', '-v', c], { stdio: 'ignore', timeout: 30_000 });
  }

  // Correctness path: sweep by LABEL, because `docker rm -f <name>` issued in the
  // window between the daemon creating a container and starting it removes nothing,
  // and the name registry cannot see a container created after teardown began.
  sweepByLabelSync(
    'container',
    () => dockerSyncLines(['ps', '-aq', '--filter', `label=${RUN_LABEL}=${RUN_ID}`]),
    (ids) => spawnSync('docker', ['rm', '-f', '-v', ...ids], { stdio: 'ignore', timeout: 30_000 }),
  );

  sweepDone = true;
}

/**
 * Remove everything this run labelled, and keep watching until the daemon's own
 * view has been EMPTY FOR A CONTINUOUS QUIET PERIOD rather than for a fixed number
 * of listings.
 *
 * Ported from `verify-image.mjs`, whose comment carries the measurements: a
 * fixed-count grace period of ~300 ms missed a late container create once in 24
 * SIGINT runs, and missed it SILENTLY because the leftover listing also ran before
 * the container existed. Any sighting resets the window; SWEEP_BUDGET_MS bounds
 * the whole thing so a daemon that keeps producing resources cannot turn teardown
 * into the hang this file exists to avoid; a listing that FAILS is reported as a
 * failure rather than read as "nothing there".
 */
function sweepByLabelSync(kind, list, remove) {
  const started = Date.now();
  let lastSighting = started;
  /** Elapsed ms of the last sighting, or -1 if nothing was ever listed. */
  let lastSightingAt = -1;
  /** Was the FIRST listing empty? If it was, anything seen later arrived after
   *  teardown began — which is the race, and the only interesting case. */
  let firstListingEmpty = null;
  let listErrors = 0;
  let lastListError = null;
  let pollMs = 100;
  while (Date.now() - lastSighting < SWEEP_QUIET_MS) {
    if (Date.now() - started > SWEEP_BUDGET_MS) break;
    if (listErrors >= SWEEP_MAX_LIST_ERRORS) break;
    let ids;
    try {
      ids = list();
      listErrors = 0;
    } catch (err) {
      listErrors++;
      lastListError = err.message;
      // Hold the quiet window open: an unanswerable daemon must not be recorded as
      // a clean one.
      lastSighting = Date.now();
      sleepSync(pollMs);
      pollMs = Math.min(pollMs * 2, 500);
      continue;
    }
    if (firstListingEmpty === null) firstListingEmpty = ids.length === 0;
    if (ids.length) {
      lastSighting = Date.now();
      lastSightingAt = lastSighting - started;
      try {
        remove(ids);
      } catch (err) {
        // A throw here would abort teardown for everything after it.
        console.error(`  (teardown) removing ${kind}(s) threw: ${err.message}`);
      }
    }
    sleepSync(pollMs);
    pollMs = Math.min(pollMs * 2, 500);
  }
  if (listErrors >= SWEEP_MAX_LIST_ERRORS) {
    console.error(
      `  (teardown) could not list ${kind}(s) — ${listErrors} consecutive failures, last: ` +
        `${lastListError}\n  Teardown CANNOT confirm it left nothing behind. Sweep with ` +
        '`node scripts/verify-sse-stream.mjs --prune` once the daemon answers again.',
    );
    return;
  }

  // FINAL PASS, unconditional. The loop exits on a quiet window or on the budget;
  // either way, ask once more and try once more, so a resource that appeared during
  // the last sleep is removed rather than merely reported. Measured to be
  // load-bearing in the sibling: a container landing 2.9 s after the signal was
  // removed HERE, not by the loop.
  let leftover = [];
  let finalListFailed = false;
  try {
    leftover = list();
  } catch (err) {
    finalListFailed = true;
    lastListError = err.message;
  }
  if (leftover.length) {
    if (firstListingEmpty === null) firstListingEmpty = false;
    lastSightingAt = Date.now() - started;
    try {
      remove(leftover);
    } catch {
      /* reported below */
    }
    sleepSync(250);
    try {
      leftover = list();
    } catch (err) {
      finalListFailed = true;
      lastListError = err.message;
      leftover = [];
    }
  }
  if (finalListFailed) {
    // Say so rather than falling through to "nothing survived": the whole point of
    // the throwing listing is that an unanswered question is not a negative answer.
    console.error(
      `  (teardown) the final ${kind} listing FAILED (${lastListError}), so teardown cannot ` +
        'confirm it left nothing behind. Sweep with ' +
        '`node scripts/verify-sse-stream.mjs --prune`.',
    );
    return;
  }
  // Never let a teardown failure mask the real check failure: report and move on.
  if (leftover.length) {
    console.error(
      `  (teardown) ${leftover.length} ${kind}(s) survived: ${leftover.join(', ')} — ` +
        'sweep them with `node scripts/verify-sse-stream.mjs --prune`',
    );
  } else if (process.env.AITP_VERIFY_SSE_SWEEP_TRACE) {
    const detail =
      lastSightingAt < 0
        ? 'nothing was ever listed'
        : firstListingEmpty
          ? `APPEARED ${lastSightingAt}ms in, after an empty first listing, and was removed`
          : `present at the first listing, last sighting ${lastSightingAt}ms in, all removed`;
    console.error(`  (teardown) ${kind} sweep: ${detail} (sweep took ${Date.now() - started}ms)`);
  }
}

let watchdog = null;
function armWatchdog(ms) {
  watchdog = setTimeout(() => {
    const human = ms < 60_000 ? `${ms}ms` : `${(ms / 60_000).toFixed(1)} minutes`;
    console.error(
      `\nharness watchdog: exceeded ${human} of post-build work. Failing rather than ` +
        'hanging the job.',
    );
    cleanupSync();
    process.exit(1);
  }, ms);
  // An unref'd timer still fires while main() is awaiting, and cannot itself be the
  // handle that pins a loop which would otherwise drain.
  watchdog.unref();
}

// ── platform helpers ────────────────────────────────────────────────────────
const DOCKER_ARCH = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'amd64', amd64: 'amd64' };

function platformArch(platform) {
  return platform.split('/')[1] ?? '';
}

async function assertDockerAvailable() {
  try {
    const { stdout } = await docker(['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    if (opts.allowSkip) return null;
    throw new Error(
      'docker is unavailable — install the CLI and start the daemon. This harness runs the ' +
        'shipped image, so it cannot run without one. Pass --allow-skip to make that a ' +
        `skip instead of a failure on a machine without Docker.\n  underlying error: ${err.message}`,
    );
  }
}

async function hostPlatform() {
  const { stdout } = await docker(['info', '--format', '{{.OSType}}/{{.Architecture}}'], {
    timeoutMs: 30_000,
  });
  const [osType, arch] = stdout.trim().split('/');
  return `${osType || 'linux'}/${DOCKER_ARCH[arch] ?? arch}`;
}

async function buildImage(platform, tag, emulated) {
  console.log(`building ${tag} for ${platform} (no layer cache configured; budget for a cold build)`);
  await dockerStream(
    [
      'buildx',
      'build',
      '--platform',
      platform,
      '--load',
      '--file',
      path.join(ROOT, 'Dockerfile'),
      '--tag',
      tag,
      ROOT,
    ],
    { timeoutMs: emulated ? BUILD_MS_EMULATED : BUILD_MS_NATIVE },
  );
}

/** One-shot `docker logs`. Never `-f`: a follower is a long-lived child holding
 *  pipes open, which is the 18-minute-hang bug class. */
async function containerLogs(name) {
  const { stdout, stderr } = await docker(['logs', name], { allowFail: true, timeoutMs: 60_000 });
  return `${stdout}${stderr}`.trim() || '(no output)';
}

/**
 * The same read, but for a check that ASSERTS ON LOG CONTENT.
 *
 * `containerLogs` is deliberately forgiving because most of its callers are
 * building a failure message, where "(no output)" beats a second error on top of
 * the first. A check that reads the logs for evidence cannot use it: a `docker
 * logs` that failed and a container that logged nothing must be findings, not an
 * ambiguous empty string the caller then reasons about.
 */
async function containerLogsStrict(name, why) {
  const { code, stdout, stderr } = await docker(['logs', name], {
    allowFail: true,
    timeoutMs: 60_000,
  });
  const text = `${stdout}${stderr}`.trim();
  if (code !== 0) {
    fail(
      `\`docker logs ${name}\` exited ${code}, so its output could not be read — and ${why} ` +
        `reads it for evidence. stderr: ${JSON.stringify(stderr.trim().slice(0, 500))}`,
    );
  }
  if (!text) {
    fail(
      `\`docker logs ${name}\` returned nothing at all, and ${why} reads it for evidence. The ` +
        'container should have logged its Next.js startup banner by now; that it did not is ' +
        'the finding.',
    );
  }
  return text;
}

/**
 * Run the image under test and wait until it answers.
 *
 * `label` distinguishes the two containers in one run; `extraEnv` is how the
 * capacity container varies one variable while holding the rest fixed.
 */
async function startApp(platform, label, extraEnv = {}) {
  const name = nameFor(label);
  // REGISTERED BEFORE CREATED, and the order is not stylistic: `docker rm -f <name>`
  // issued in the window between the daemon creating a container and starting it
  // removes nothing, so a signal that lands there must still find the name here.
  containers.add(name);
  everRegisteredContainer = true;
  const env = {
    API_KEYS: API_KEY,
    CP_AID_SEED_HEX: SEED_HEX,
    SSE_HEARTBEAT_MS: String(HEARTBEAT_MS),
    // NO DATABASE, on purpose — see the NO POSTGRES note in the file header. A
    // closed loopback port fails fast with ECONNREFUSED instead of waiting on DNS,
    // and it is the same default `src/lib/config.ts` would have used anyway; naming
    // it here makes the intent legible in `docker inspect`.
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/aitp_verify_sse_no_db',
    // The retention sweep would otherwise retry against that closed port on a timer
    // and fill the logs check 5 reads with noise unrelated to the stream.
    RETENTION_ENABLED: 'false',
    // Explicit and generous: a future change to the defaults in src/lib/config.ts
    // must not be able to make these checks flaky through rate limiting.
    RATE_LIMIT_PUBLIC_PER_IP_MIN: '10000',
    RATE_LIMIT_API_KEY_PER_MIN: '10000',
    RATE_LIMIT_ENROLLMENT_PER_IP_MIN: '10000',
    ...extraEnv,
  };
  await docker(
    [
      'run',
      '-d',
      '--name',
      name,
      // Ephemeral and loopback-bound: a fixed 4000 would collide with a local
      // `npm run dev`, and 0.0.0.0 would publish a harness container to the LAN.
      '-p',
      '127.0.0.1:0:4000',
      ...(opts.platform ? ['--platform', platform] : []),
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ...labelArgs(),
      opts.tag,
    ],
    { timeoutMs: 180_000 },
  );

  const { stdout: portOut } = await docker(['port', name, '4000/tcp'], { timeoutMs: 20_000 });
  const hostPort = Number(portOut.trim().split('\n')[0]?.split(':').pop());
  if (!Number.isInteger(hostPort) || hostPort <= 0) {
    fail(
      `could not read the app's published host port from \`docker port\`: ` +
        `${JSON.stringify(portOut)}. Every assertion here is made over that port, so there ` +
        'is nothing to fall back to.',
    );
  }

  const started = Date.now();
  for (;;) {
    // Poll liveness ALONGSIDE the HTTP probe. A container that dies at boot is then
    // reported in about a second with its logs, instead of as a four-minute timeout
    // with no explanation.
    const { stdout: running } = await docker(['inspect', '-f', '{{.State.Running}}', name], {
      allowFail: true,
      timeoutMs: 20_000,
    });
    const state = running.trim();
    if (state === 'false') {
      fail(
        `the app container exited during readiness, after ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s. Its logs:\n${await containerLogs(name)}`,
      );
    }
    if (state !== 'true') {
      // Neither `true` nor `false` means `docker inspect` could not answer — the
      // container was removed out of band, or the daemon is unwell. Without this the
      // loop would spin out the full readiness deadline and then blame a slow boot.
      fail(
        `\`docker inspect\` reported the app container's running state as ` +
          `${JSON.stringify(state)}, which is neither "true" nor "false" — the container has ` +
          'probably been removed from under this run, or the daemon is failing to answer. Not ' +
          'waiting out the readiness deadline for that.',
      );
    }
    try {
      // BREAK ON ANY HTTP RESPONSE — never on `res.ok`. With no database
      // `/api/health` answers 503, which is the CORRECT "process up, DB down"
      // answer here and is all readiness means: the server is listening.
      await fetch(`http://127.0.0.1:${hostPort}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      break;
    } catch {
      if (Date.now() - started > APP_READY_MS) {
        fail(
          `the app never answered on 127.0.0.1:${hostPort} within ` +
            `${Math.round(APP_READY_MS / 1000)}s. Its logs:\n${await containerLogs(name)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(
    `app "${label}" answered in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(127.0.0.1:${hostPort}${Object.keys(extraEnv).length ? `, ${JSON.stringify(extraEnv)}` : ''})`,
  );
  return { name, hostPort };
}

// ── the wire parser (pure; see --parse-fixture) ─────────────────────────────
/**
 * Parse an HTTP/1.1 response head out of a buffer.
 *
 * Returns `null` while the head is still incomplete — the caller feeds more bytes
 * — and throws on anything that is not an HTTP/1.1 response head, because a
 * garbled head must be a loud failure and not a header map that silently lacks
 * every key the assertions look for.
 */
function parseHead(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) {
    // Fail closed rather than buffering forever on something that is not HTTP.
    if (buf.length > 64 * 1024) throw new Error('no end of response head in the first 64 KiB');
    return null;
  }
  // latin1: header bytes are, and a decoder that "fixes" invalid UTF-8 here would
  // change the bytes being asserted on.
  const lines = buf.subarray(0, sep).toString('latin1').split('\r\n');
  const statusLine = lines[0] ?? '';
  const m = /^HTTP\/1\.1 (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!m) {
    throw new Error(
      `the first line is not an HTTP/1.1 status line: ${JSON.stringify(statusLine.slice(0, 120))}`,
    );
  }
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) throw new Error(`malformed header line: ${JSON.stringify(line.slice(0, 120))}`);
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    // Join repeats rather than overwrite: a second `content-encoding` would
    // otherwise be invisible to check 2, which asserts that header is ABSENT.
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return {
    statusLine,
    status: Number(m[1]),
    reason: m[2] ?? '',
    headers,
    rest: buf.subarray(sep + 4),
  };
}

/**
 * Incremental body reader: chunked-transfer decode, then SSE frame split.
 *
 * Every SSE frame ends at a blank line, so frames are split on `\n\n` and the
 * terminator is KEPT — the prelude assertion is a byte equality against
 * `retry: N\n: connected\n\n`, and a split that dropped the terminator would be
 * asserting on different bytes than the server sent.
 *
 * Each frame carries the arrival timestamp of the read that COMPLETED it, which is
 * what makes check 4's heartbeat interval measurable at all.
 *
 * `chunked: false` is the fixed-length path (the 503 capacity response), where the
 * body is simply accumulated.
 */
function createBodyReader({ chunked }) {
  let pending = Buffer.alloc(0);
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let state = chunked ? 'size' : 'identity';
  let need = 0;
  let complete = false;
  const frames = [];
  let text = '';
  /** Decoded body bytes so far, so a fixed-length body can be known complete from
   *  `content-length` rather than from the connection closing — which under HTTP/1.1
   *  keep-alive it never does. */
  let bodyBytes = 0;

  const emit = (s, at) => {
    text += s;
    carry += s;
    for (;;) {
      const i = carry.indexOf('\n\n');
      if (i < 0) break;
      frames.push({ text: carry.slice(0, i + 2), at });
      carry = carry.slice(i + 2);
    }
  };

  function push(buf, at = now()) {
    pending = pending.length ? Buffer.concat([pending, buf]) : buf;
    if (state === 'identity') {
      bodyBytes += pending.length;
      emit(decoder.write(pending), at);
      pending = Buffer.alloc(0);
      return;
    }
    for (;;) {
      if (state === 'size') {
        const i = pending.indexOf('\r\n');
        if (i < 0) {
          if (pending.length > 1024) throw new Error('chunk size line longer than 1 KiB');
          return;
        }
        // Chunk extensions (`1a;foo=bar`) are legal and Node never emits them, but
        // tolerating them costs one split and a fixture is allowed to contain one.
        const sizeText = pending.subarray(0, i).toString('latin1').split(';')[0].trim();
        if (!/^[0-9a-fA-F]+$/.test(sizeText)) {
          throw new Error(`chunk size is not hexadecimal: ${JSON.stringify(sizeText.slice(0, 40))}`);
        }
        need = parseInt(sizeText, 16);
        pending = pending.subarray(i + 2);
        state = need === 0 ? 'trailer' : 'data';
        continue;
      }
      if (state === 'data') {
        if (pending.length < need) return;
        bodyBytes += need;
        emit(decoder.write(pending.subarray(0, need)), at);
        pending = pending.subarray(need);
        need = 0;
        state = 'crlf';
        continue;
      }
      if (state === 'crlf') {
        if (pending.length < 2) return;
        if (pending[0] !== 0x0d || pending[1] !== 0x0a) {
          throw new Error('a chunk was not followed by CRLF');
        }
        pending = pending.subarray(2);
        state = 'size';
        continue;
      }
      if (state === 'trailer') {
        // The last chunk's trailer section ends at a blank line. Nothing here
        // depends on trailer fields, so the only job is to notice the end.
        const i = pending.indexOf('\r\n');
        if (i < 0) return;
        if (i === 0) {
          pending = pending.subarray(2);
          complete = true;
          state = 'done';
          continue;
        }
        pending = pending.subarray(i + 2);
        continue;
      }
      return; // 'done'
    }
  }

  return {
    push,
    frames,
    /** Bytes left undecoded — non-zero at the end means a truncated body. */
    get pendingBytes() {
      return pending.length;
    },
    /** Decoded body bytes received so far. */
    get bodyBytes() {
      return bodyBytes;
    },
    /** A partial frame: decoded bytes not yet terminated by a blank line. */
    get partial() {
      return carry;
    },
    get complete() {
      return complete;
    },
    get text() {
      return text;
    },
  };
}

/** Monotonic milliseconds, as a float. `Date.now()` is not monotonic and these are
 *  latency measurements small enough for a clock step to matter. */
function now() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

/**
 * Open ONE request and return once the response head has arrived.
 *
 * Timings mirror curl's, so the numbers in this harness's output can be compared
 * with the `curl -w` measurements in the plan and in `PROGRESS.md` directly:
 *   - `connectMs`     — curl's `time_connect`
 *   - `firstByteMs`   — curl's `time_starttransfer`, i.e. from the start of the
 *                       request (here `net.connect`, no DNS on loopback) to the
 *                       FIRST byte of the response
 *   - `headMs`        — first byte to the end of the header block
 *
 * The socket stays OPEN and registered; the caller reads frames from it and must
 * `close()` it. Every wait has a deadline, because the failure mode under test is
 * a request that never answers.
 */
function openStream(hostPort, { path: reqPath = '/api/events/stream', key = API_KEY, deadlineMs = WIRE_DEADLINE_MS, dump = false } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = now();
    let connectedAt = null;
    let firstByteAt = null;
    let head = null;
    let reader = null;
    const raw = dump ? [] : null;
    let buf = Buffer.alloc(0);
    /** Resolver for a pending nextFrame() call. */
    let waiter = null;
    /** Resolver for a pending readBody() call. */
    let bodyWaiter = null;
    let failure = null;

    const socket = net.connect({ host: '127.0.0.1', port: hostPort });
    sockets.add(socket);
    socket.setNoDelay(true);

    /** Declared before `done` so the two cannot land in a temporal-dead-zone order
     *  if a future edit makes any of these handlers run synchronously. */
    let timer = null;
    /** Abandon the connection and reject the open() promise. Only used before the
     *  head has arrived — afterwards the caller owns the socket. */
    const done = (err) => {
      clearTimeout(timer);
      failure = err;
      socket.destroy();
      sockets.delete(socket);
      reject(err);
    };

    timer = setTimeout(() => {
      // The message distinguishes the two silences that matter: no bytes at all
      // (#89's exact symptom, "not even an HTTP status line") from a head that
      // arrived and a body that never did.
      const what =
        firstByteAt === null
          ? "NO RESPONSE BYTES AT ALL — not even an HTTP status line, which is issue #89's " +
            'exact symptom'
          : `the first response byte arrived after ${(firstByteAt - startedAt).toFixed(1)}ms ` +
            'but the header block never completed';
      done(new Error(`${what}, within a ${deadlineMs}ms deadline on ${reqPath}`));
    }, deadlineMs);

    /** Fail whatever is waiting on more bytes, without touching the open() promise. */
    const rejectWaiters = (err) => {
      for (const slot of ['waiter', 'bodyWaiter']) {
        const w = slot === 'waiter' ? waiter : bodyWaiter;
        if (!w) continue;
        if (slot === 'waiter') waiter = null;
        else bodyWaiter = null;
        clearTimeout(w.timer);
        w.reject(err);
      }
    };

    socket.on('error', (err) => {
      const e = new Error(`socket error on ${reqPath}: ${err.message}`);
      rejectWaiters(e);
      if (!head) done(e);
      else failure = e;
    });

    socket.on('close', () => {
      sockets.delete(socket);
      // A close AFTER the head is only a failure for a reader still waiting — the
      // caller's own `close()` lands here too, and must not turn a finished
      // observation into an error.
      const e = failure ?? new Error(`the server closed the connection on ${reqPath}`);
      rejectWaiters(e);
      if (!head) done(e);
    });

    socket.on('connect', () => {
      connectedAt = now();
      // `Accept-Encoding: gzip, br` ON EVERY REQUEST, deliberately. Next enables
      // its `compression` middleware by default and skips any response carrying
      // `no-transform`; asking for compression is what makes check 2's "no
      // content-encoding" assertion a live test of that rather than a tautology
      // about a request that never asked. It has a second effect worth knowing: if
      // compression ever did apply, the body would be gzip bytes and the prelude
      // byte-equality in check 3 would fail too, so the regression is caught twice.
      socket.write(
        `GET ${reqPath} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${hostPort}\r\n` +
          'Accept: text/event-stream\r\n' +
          'Accept-Encoding: gzip, br\r\n' +
          (key ? `Authorization: Bearer ${key}\r\n` : '') +
          '\r\n',
      );
    });

    socket.on('data', (d) => {
      const at = now();
      if (firstByteAt === null) firstByteAt = at;
      if (raw) raw.push(d);
      if (!head) {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        let parsed;
        try {
          parsed = parseHead(buf);
        } catch (err) {
          done(new Error(`could not parse the response head on ${reqPath}: ${err.message}`));
          return;
        }
        if (!parsed) return;
        head = parsed;
        const te = (head.headers.get('transfer-encoding') ?? '').toLowerCase();
        reader = createBodyReader({ chunked: te.includes('chunked') });
        clearTimeout(timer);
        try {
          if (head.rest.length) reader.push(head.rest, at);
        } catch (err) {
          done(new Error(`could not decode the response body on ${reqPath}: ${err.message}`));
          return;
        }
        resolve(api);
        drain();
        return;
      }
      try {
        reader.push(d, at);
      } catch (err) {
        failure = new Error(`could not decode the response body on ${reqPath}: ${err.message}`);
        if (waiter) {
          const w = waiter;
          waiter = null;
          w.reject(failure);
        }
        socket.destroy();
        return;
      }
      drain();
    });

    /** Hand queued bytes to whatever is waiting for them. */
    function drain() {
      if (!reader) return;
      if (waiter && reader.frames.length > waiter.index) {
        const w = waiter;
        waiter = null;
        clearTimeout(w.timer);
        w.resolve(reader.frames[w.index]);
      }
      if (bodyWaiter && bodyComplete()) {
        const w = bodyWaiter;
        bodyWaiter = null;
        clearTimeout(w.timer);
        w.resolve(reader.text);
      }
    }

    /**
     * Is a NON-STREAMING body fully received?
     *
     * Never by the connection closing, and that is a measured correction rather than
     * a precaution. The 503 capacity refusal — the one non-streaming response this
     * harness reads — comes back `Transfer-Encoding: chunked` with
     * `Connection: keep-alive`, not `Content-Length`. An earlier version of this
     * function tested `content-length` and then fell through to `'end'`, so it sat
     * through the server's whole 5-second keep-alive timeout and then reported "the
     * server closed the connection" instead of reading a body that had arrived in
     * milliseconds. THREE signals, in the order of how definite they are:
     *   - the chunked terminator (`0\r\n\r\n`) was decoded — the body is over and the
     *     connection is still perfectly healthy;
     *   - `content-length` bytes arrived;
     *   - the peer ended the stream, which is the only signal available when neither
     *     framing declares a length.
     */
    function bodyComplete() {
      if (reader.complete) return true;
      // `has` before `Number`, because `Number(null)` is 0 and `0 >= 0` would report
      // every chunked stream complete the instant anything asked.
      if (head?.headers.has('content-length')) {
        const len = Number(head.headers.get('content-length'));
        if (Number.isInteger(len) && len >= 0) return reader.bodyBytes >= len;
      }
      return socket.readableEnded || socket.destroyed;
    }

    const api = {
      get statusLine() {
        return head.statusLine;
      },
      get status() {
        return head.status;
      },
      get headers() {
        return head.headers;
      },
      /** curl's time_connect / time_starttransfer, in ms. */
      get connectMs() {
        return connectedAt - startedAt;
      },
      get firstByteMs() {
        return firstByteAt - startedAt;
      },
      get headMs() {
        return now() - firstByteAt;
      },
      get frames() {
        return reader.frames;
      },
      get partial() {
        return reader.partial;
      },
      get bodyText() {
        return reader.text;
      },
      get rawBytes() {
        return raw ? Buffer.concat(raw) : null;
      },
      /**
       * Wait for frame number `index` (0-based over the whole connection).
       *
       * Indexed rather than "the next one" so a check cannot consume a frame another
       * check is about to assert on — the frames are shared observations, exactly
       * like the revocation envelope in `verify-image.mjs`.
       */
      nextFrame(index, timeoutMs) {
        // Frames already in hand FIRST: a socket that errored after delivering them
        // must not turn an observation that exists into a rejection.
        if (reader.frames.length > index) return Promise.resolve(reader.frames[index]);
        if (failure) return Promise.reject(failure);
        if (waiter) return Promise.reject(new Error('nextFrame() is already waiting'));
        return new Promise((res, rej) => {
          const t = setTimeout(() => {
            waiter = null;
            rej(
              new Error(
                `frame ${index} never arrived within ${timeoutMs}ms on ${reqPath} ` +
                  `(${reader.frames.length} frame(s) so far` +
                  (reader.partial ? `, plus ${JSON.stringify(reader.partial)} unterminated` : '') +
                  ')',
              ),
            );
          }, timeoutMs);
          waiter = { index, resolve: res, reject: rej, timer: t };
          drain();
        });
      },
      /** Wait for a fixed-length body to be complete (see bodyComplete), or the
       *  deadline. Used for the one non-streaming response here: the 503 refusal. */
      readBody(timeoutMs) {
        if (bodyComplete()) return Promise.resolve(reader.text);
        if (failure) return Promise.reject(failure);
        if (bodyWaiter) return Promise.reject(new Error('readBody() is already waiting'));
        return new Promise((res, rej) => {
          const t = setTimeout(() => {
            bodyWaiter = null;
            rej(
              new Error(
                `the body did not complete within ${timeoutMs}ms on ${reqPath} ` +
                  `(content-length ${show(head.headers.get('content-length') ?? null)}, ` +
                  `${reader.bodyBytes} byte(s) received)`,
              ),
            );
          }, timeoutMs);
          bodyWaiter = { resolve: res, reject: rej, timer: t };
          drain();
        });
      },
      close() {
        clearTimeout(timer);
        sockets.delete(socket);
        socket.destroy();
      },
    };
  });
}

// ── check plumbing ──────────────────────────────────────────────────────────
const results = [];

async function runCheck(id, title, fn) {
  try {
    const detail = await fn();
    console.log(`  ok   ${String(id).padStart(2)}  ${title}`);
    if (detail) console.log(`         ${String(detail).split('\n').join('\n         ')}`);
    results.push({ id, ok: true });
  } catch (err) {
    console.log(`  FAIL ${String(id).padStart(2)}  ${title}`);
    console.log(`         ${String(err.message).split('\n').join('\n         ')}`);
    results.push({ id, ok: false });
  }
}

function fail(msg) {
  throw new Error(msg);
}

/** `\n` and `\r` are the bytes these assertions are about, so print them visibly
 *  rather than as real line breaks inside a message. */
function show(s) {
  return JSON.stringify(s);
}

// ── prune ───────────────────────────────────────────────────────────────────
/**
 * Sweep containers left by an EARLIER run.
 *
 * Only containers carrying this harness's label, and never THIS run's own —
 * Docker's `--filter label=` has no negation, so the run id is excluded host-side.
 * Note what that does NOT protect: every OTHER run's containers are removed, live
 * or not. `--prune` is for orphans left by a crash; running it while another
 * verify:sse run is in flight will break that run.
 */
async function prune() {
  let removed = 0;
  const { stdout } = await docker(
    ['ps', '-a', '--filter', `label=${LABEL}=1`, '--format', `{{.Names}}\t{{.Label "${RUN_LABEL}"}}`],
    { allowFail: true },
  );
  for (const line of stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [name, runId] = line.split('\t');
    if (runId === RUN_ID) continue;
    await docker(['rm', '-f', '-v', name], { allowFail: true, timeoutMs: 30_000 });
    console.log(`  pruned container ${name} (run ${runId || 'unlabelled'})`);
    removed++;
  }
  console.log(removed ? `\npruned ${removed} container(s)` : '\nnothing to prune');
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (opts.help) {
    console.log(HELP);
    return;
  }

  // BEFORE the Docker check, on purpose: this path involves no image, no container
  // and no daemon, so requiring one would make the harness's own falsifiability
  // hook unavailable on a machine without Docker — including a reviewer's.
  if (opts.parseFixture) {
    const file = path.resolve(ROOT, opts.parseFixture);
    const rel = path.relative(ROOT, file);
    const shown = rel.startsWith('..') ? file : rel;
    const bytes = readFileSync(file);
    const parsed = parseHead(bytes); // throws on a malformed head — exit 1 below
    if (!parsed) fail(`${shown} holds no complete HTTP response head`);
    const te = (parsed.headers.get('transfer-encoding') ?? '').toLowerCase();
    const chunked = te.includes('chunked');
    const bulk = createBodyReader({ chunked });
    bulk.push(parsed.rest, 0);
    console.log(`${shown}: ${parsed.statusLine}`);
    for (const [k, v] of parsed.headers) console.log(`  ${k}: ${v}`);
    console.log(
      `  body: ${chunked ? 'chunked' : 'identity'}, ${bulk.frames.length} complete frame(s), ` +
        `${bulk.pendingBytes} undecoded byte(s), ${bulk.complete ? 'terminated' : 'NOT terminated'}`,
    );
    for (const [i, f] of bulk.frames.entries()) console.log(`  frame ${i}: ${show(f.text)}`);
    if (bulk.partial) console.log(`  unterminated tail: ${show(bulk.partial)}`);

    // THE SELF-CHECK, and the reason this hook is worth more than a pretty-printer.
    // On a real socket the bytes arrive in splits nobody chooses: TCP may deliver the
    // status line in two reads, or a chunk size line split across the `\r` and the
    // `\n`. Every assertion in this harness is made on the OUTPUT of these two
    // functions, so a state machine that only works when fed whole messages would
    // produce a wrong prelude, a wrong frame count or a wrong heartbeat gap — and it
    // would do it intermittently. Feeding the same fixture ONE BYTE AT A TIME must
    // give an identical parse, and a mismatch is reported as a failure of this file
    // rather than of the image.
    let incremental = null;
    for (let i = 1; i <= bytes.length; i++) {
      const p = parseHead(bytes.subarray(0, i));
      if (p) {
        incremental = { at: i, head: p };
        break;
      }
    }
    if (!incremental) fail('the head parsed in bulk but never parsed incrementally');
    if (
      incremental.head.statusLine !== parsed.statusLine ||
      incremental.head.headers.size !== parsed.headers.size ||
      [...parsed.headers].some(([k, v]) => incremental.head.headers.get(k) !== v)
    ) {
      fail('the head parses DIFFERENTLY byte-by-byte than in bulk');
    }
    const drip = createBodyReader({ chunked });
    for (const b of parsed.rest) drip.push(Buffer.from([b]), 0);
    const same =
      drip.frames.length === bulk.frames.length &&
      drip.frames.every((f, i) => f.text === bulk.frames[i].text) &&
      drip.partial === bulk.partial &&
      drip.complete === bulk.complete &&
      drip.bodyBytes === bulk.bodyBytes;
    if (!same) {
      fail(
        'the body parses DIFFERENTLY one byte at a time than in bulk — the decoder is not ' +
          `resumable.\n  bulk: ${bulk.frames.length} frame(s), partial ${show(bulk.partial)}\n` +
          `  drip: ${drip.frames.length} frame(s), partial ${show(drip.partial)}`,
      );
    }
    console.log(
      `  self-check: identical under a bulk feed and a 1-byte-at-a-time feed (head complete ` +
        `at byte ${incremental.at} of ${bytes.length}, ${bulk.bodyBytes} body byte(s) decoded)`,
    );
    return;
  }

  const serverVersion = await assertDockerAvailable();
  if (serverVersion === null) {
    // Only reachable with --allow-skip. Exit 0 loudly rather than quietly: a skip
    // that reads like a pass is how a check stops being a check.
    console.log(
      'verify-sse-stream SKIPPED: no Docker daemon, and --allow-skip was passed. NOTHING WAS ' +
        'VERIFIED. This harness runs the shipped image; there is no degraded mode. The ' +
        'in-process equivalent that needs no Docker is ' +
        'src/app/api/events/stream/stream.flush.test.ts, which runs on every `npm test`.',
    );
    return;
  }

  if (opts.prune) {
    console.log(`docker ${serverVersion} — pruning orphans labelled ${LABEL}=1`);
    console.log(
      '  (this removes containers from EVERY other run of this harness, so do not run it ' +
        'while another verify:sse run is in flight — it is for orphans left by a crashed run.)',
    );
    await prune();
    return;
  }

  if (opts.platform && opts.platform.includes(',')) {
    fail(
      `--platform ${opts.platform} names more than one platform. \`docker buildx build --load\` ` +
        'cannot load a multi-platform manifest into the daemon, so this harness takes ONE ' +
        'platform per invocation. Run it twice.',
    );
  }
  if (opts.platform && !/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/.test(opts.platform)) {
    fail(`--platform ${opts.platform} is not an <os>/<arch> pair (e.g. linux/amd64).`);
  }
  const host = await hostPlatform();
  const platform = opts.platform ?? host;
  const emulated = platformArch(platform) !== platformArch(host);

  console.log(`docker ${serverVersion}`);
  console.log(`run id ${RUN_ID} · platform ${platform} · host ${host} · tag ${opts.tag}`);
  console.log(
    `SSE_HEARTBEAT_MS=${HEARTBEAT_MS} in the container, header-flush budget ` +
      `${FLUSH_BUDGET_MS}ms — the budget is half the heartbeat, so "flushed in time" and ` +
      '"the heartbeat did it" cannot both be true',
  );
  if (emulated) {
    console.log(
      `NOTE: ${platform} is emulated on a ${host} host (QEMU). Everything is slow, and ` +
        '`docker run` prints a platform-mismatch WARNING on stderr that is not a failure.',
    );
  }

  if (opts.build) await buildImage(platform, opts.tag, emulated);
  else console.log('--no-build: reusing the existing local tag');

  // The build has its own timeout above; this ceiling covers the checks, so "the
  // build hung" and "a check hung" are distinguishable.
  armWatchdog(WATCHDOG_MS);

  const app = await startApp(platform, 'app');

  // ── the observations, taken once and asserted by several checks ───────────
  //
  // TWO CONNECTIONS, and both numbers are reported. The first request to the route
  // in the life of the process also pays for loading its compiled chunk, so it is
  // the honest COLD number and the one a fresh deploy's first client actually sees;
  // the second is the steady-state header-flush latency. Asserting only the warm one
  // would let a pathological cold path pass; asserting only the cold one would put a
  // one-off module load inside a latency budget. Both are held to FLUSH_BUDGET_MS —
  // measured at ~7 ms in a native container, so there is no tension in practice.
  let cold = null;
  let warm = null;
  try {
    cold = await openStream(app.hostPort);
    // Read frame 0 before closing, so the cold connection proves it carried a
    // prelude too rather than merely returning headers fast.
    await cold.nextFrame(0, WIRE_DEADLINE_MS);
  } catch (err) {
    // Not a check failure: every check below reads these observations, and reporting
    // the same underlying error seven times would bury it. Fail the run here.
    fail(
      `the first connection to /api/events/stream could not be observed: ${err.message}\n` +
        `The container's logs:\n${await containerLogs(app.name)}`,
    );
  }
  const coldFirstByteMs = cold.firstByteMs;
  const coldFrame0 = cold.frames[0]?.text ?? '';
  cold.close();

  try {
    warm = await openStream(app.hostPort, { dump: Boolean(opts.dumpWire) });
  } catch (err) {
    fail(
      `the second connection to /api/events/stream could not be observed: ${err.message}\n` +
        `The container's logs:\n${await containerLogs(app.name)}`,
    );
  }

  await runCheck(
    1,
    'response headers flush at connect on an empty backlog (the #89 gate)',
    async () => {
      // Frame 0 is awaited here, not in the check that asserts its bytes, so the
      // measurement and the frame belong to the same connection and neither check
      // can pass on the other's connection.
      await warm.nextFrame(0, WIRE_DEADLINE_MS);
      const measured = [
        ['cold (first request to the route in this process)', coldFirstByteMs],
        ['warm (second connection)', warm.firstByteMs],
      ];
      const lines = measured.map(([label, ms]) => `${label}: ${ms.toFixed(1)}ms`);
      // BOTH numbers are reported before anything fails. Failing inside the loop
      // printed the cold breach and swallowed the warm measurement, which is the
      // number that says whether the delay is systemic or a one-off module load —
      // observed while running this against a pre-Phase-1 image.
      const over = measured.filter(([, ms]) => ms > FLUSH_BUDGET_MS);
      if (over.length) {
        // The heartbeat comparison is the diagnosis, not decoration: at
        // SSE_HEARTBEAT_MS the first bytes on the wire are a heartbeat, which is #89
        // exactly, and saying so turns a red check into a finding.
        const nearHeartbeat = over.every(
          ([, ms]) => ms >= HEARTBEAT_MS * 0.9 && ms <= HEARTBEAT_MS * 1.5,
        );
        fail(
          `${over.length} of 2 connections missed the ${FLUSH_BUDGET_MS}ms budget for the ` +
            `first byte on the wire — ${lines.join('; ')}.\n` +
            (nearHeartbeat
              ? `EVERY BREACH IS AT SSE_HEARTBEAT_MS (${HEARTBEAT_MS}ms): the first bytes were ` +
                'a HEARTBEAT, not a connect prelude — which is issue #89 exactly. Next defers ' +
                'res.flushHeaders() to the first body chunk ' +
                '(next/dist/server/pipe-readable.js:59-74), so a stream that writes nothing at ' +
                'connect sends no status line and no headers at all until the heartbeat fires. ' +
                'The fix is the prelude enqueue at the top of start() in ' +
                'src/app/api/events/stream/route.ts.'
              : 'The breaches are NOT at the heartbeat interval, so this is not #89 in its ' +
                'original shape: something else delayed the first write. Read check 3\'s frames ' +
                "and the container's logs."),
        );
      }
      return (
        `${lines.join('; ')} — both inside the ${FLUSH_BUDGET_MS}ms budget and well under ` +
        `SSE_HEARTBEAT_MS=${HEARTBEAT_MS}ms, so the prelude flushed the headers, not a ` +
        `heartbeat. (connect ${warm.connectMs.toFixed(1)}ms, head complete ` +
        `${warm.headMs.toFixed(1)}ms after the first byte.)`
      );
    },
  );

  await runCheck(
    2,
    'the streaming header contract holds, with Accept-Encoding: gzip, br on the request',
    () => {
      if (warm.status !== 200) {
        fail(
          `status ${warm.status} (${show(warm.statusLine)}), expected 200. With a valid API key ` +
            'on an empty backlog the stream must open.',
        );
      }
      const h = (name) => warm.headers.get(name);
      const must = [
        ['content-type', (v) => v === 'text/event-stream', 'text/event-stream'],
        [
          'cache-control',
          (v) => v?.includes('no-transform'),
          'a value containing no-transform (which is also what makes Next\'s compression ' +
            'middleware skip this response)',
        ],
        ['x-accel-buffering', (v) => v === 'no', 'no'],
        [
          'transfer-encoding',
          (v) => v?.toLowerCase().includes('chunked'),
          'chunked — a Content-Length here would mean something buffered the whole stream',
        ],
      ];
      for (const [name, ok, expected] of must) {
        if (!ok(h(name))) {
          fail(`${name}: ${show(h(name) ?? null)}, expected ${expected}`);
        }
      }
      // THE ABSENCES. This is the assertion that only means something in the shipped
      // artifact: Next's router-server enables its `compression` middleware by
      // default, and the only reason it skips this response is the `no-transform`
      // above. A future next.config.ts change, or a `cache-control` edit that drops
      // that token, would gzip the stream — and a gzip stream buffers, which is #89
      // with a different cause. The in-process adapter harness cannot see this: a
      // bare http.createServer has no compression middleware in the path.
      for (const name of ['content-encoding', 'content-length']) {
        if (warm.headers.has(name)) {
          fail(
            `${name} is present (${show(h(name))}) and must not be. The request asked for ` +
              '`gzip, br`, so a content coding here means something in the shipped server is ' +
              'transforming or buffering the stream.',
          );
        }
      }
      return (
        `${show(warm.statusLine)}; content-type ${show(h('content-type'))}, cache-control ` +
        `${show(h('cache-control'))}, x-accel-buffering ${show(h('x-accel-buffering'))}, ` +
        `transfer-encoding ${show(h('transfer-encoding'))}; no content-encoding and no ` +
        'content-length despite `Accept-Encoding: gzip, br`' +
        (warm.headers.has('x-request-id')
          ? `; x-request-id ${show(h('x-request-id'))} (injected by the gate)`
          : '')
      );
    },
  );

  await runCheck(3, 'the first body frame is exactly the connect prelude', () => {
    // BYTE EQUALITY, and it is what makes check 1 non-vacuous. A fast first byte
    // proves only that SOMETHING was written; this proves it was the prelude and not
    // a replayed backlog event (the other way a fast flush could happen) or a
    // heartbeat. It also pins `retry:` to SSE_HEARTBEAT_MS in the shipped artifact,
    // which until now was only asserted in-process.
    for (const [label, got] of [
      ['cold connection', coldFrame0],
      ['warm connection', warm.frames[0]?.text ?? ''],
    ]) {
      if (got !== PRELUDE) {
        fail(
          `the ${label}'s frame 0 was ${show(got)}, expected ${show(PRELUDE)}.\n` +
            (got.startsWith(': heartbeat')
              ? 'It is a HEARTBEAT, so nothing was written at connect: this is #89. See check 1.'
              : got.startsWith('data:')
                ? 'It is a data frame, so an event flushed the headers rather than the prelude. ' +
                  'The backlog was not empty — which is the one condition this harness exists to ' +
                  'test, since a fresh deploy always has an empty one.'
                : 'The prelude is a documented client contract (docs/api.md, openapi.yaml): a ' +
                  'retry: hint tracking SSE_HEARTBEAT_MS, then a `: connected` comment frame, in ' +
                  'ONE write.'),
        );
      }
    }
    return (
      `both connections opened with ${show(PRELUDE)} — one write, and retry: tracks the ` +
      `container's SSE_HEARTBEAT_MS=${HEARTBEAT_MS}`
    );
  });

  await runCheck(4, 'the heartbeat arrives on time, and nothing else arrives', async () => {
    // FRAME 0 MUST BE THE PRELUDE, or this check has no premise. Measured, against a
    // pre-Phase-1 image: without this guard the check PASSED and its own detail line
    // said "2 s after the prelude" when frame 0 was a heartbeat and the interval
    // measured was heartbeat-to-heartbeat. A check whose prose claims more than it
    // asserts is the failure shape this repo keeps finding; check 3 owns the prelude
    // equality, and this one refuses to report a gap it cannot name the ends of.
    if ((warm.frames[0]?.text ?? '') !== PRELUDE) {
      fail(
        `frame 0 is ${show(warm.frames[0]?.text ?? null)}, not the prelude, so there is no ` +
          'prelude-to-heartbeat interval to measure here. See check 3 (and check 1).',
      );
    }
    // Waiting for a REAL heartbeat on a REAL socket. The route's unit tests reach
    // this with fake timers and a setInterval spy; the plan's Phase 3 left "observed
    // over HTTP" explicitly to this phase.
    const frame = await warm.nextFrame(1, HEARTBEAT_MS * 3 + 2000);
    const gap = frame.at - warm.frames[0].at;
    if (frame.text !== HEARTBEAT_FRAME) {
      fail(
        `frame 1 was ${show(frame.text)}, expected ${show(HEARTBEAT_FRAME)}. On an empty ` +
          'backlog nothing but the keepalive may follow the prelude — a data frame here means ' +
          'the bus was not empty and check 1 could have been satisfied by a replayed event.',
      );
    }
    // BOTH BOUNDS. The upper one is the keepalive doing its job; the lower one is the
    // wire-level guard on the flood `src/lib/config.ts` clamps for — past 2^31-1 ms
    // Node resets a setInterval delay to 1 ms, which was measured as ~80 ticks per
    // 100 ms, and a harness that only checked "a heartbeat arrived" would call that a
    // pass.
    const lo = HEARTBEAT_MS * 0.5;
    const hi = HEARTBEAT_MS * 3;
    if (gap < lo || gap > hi) {
      fail(
        `the heartbeat arrived ${gap.toFixed(1)}ms after the prelude, outside ` +
          `[${lo}, ${hi}]ms for SSE_HEARTBEAT_MS=${HEARTBEAT_MS}. ` +
          (gap < lo
            ? 'Too FAST is the interesting direction: it means the interval in force is not the ' +
              'one configured, which is exactly what a 32-bit setInterval overflow produces.'
            : 'Too slow means the keepalive cannot hold a connection open against an edge idle ' +
              'timeout, which is the only thing it is for.'),
      );
    }
    return `frame 1 was ${show(HEARTBEAT_FRAME)}, ${gap.toFixed(1)}ms after the prelude`;
  });

  await runCheck(5, "the route's lifecycle log lines reach the container's stdout", async () => {
    // The observability half of the fix, in the artifact. #89 took days partly
    // because a dead stream endpoint was invisible from outside the process; Phase 2
    // added two log lines per stream and three metrics, and nothing until now had
    // checked that they survive the standalone build. The cold connection was opened
    // and CLOSED above, so both lines must be present by now.
    const logs = await containerLogsStrict(app.name, 'check 5 (the stream lifecycle log lines)');
    const opened = logs.split('\n').filter((l) => l.includes('sse stream opened'));
    const closed = logs.split('\n').filter((l) => l.includes('sse stream closed'));
    if (!opened.length) {
      fail(
        `no "sse stream opened" line in ${logs.split('\n').length} lines of container output, ` +
          'after two connections. Either the route never logged it or pino is not writing to ' +
          "the container's stdout in the standalone build.",
      );
    }
    if (!closed.length) {
      fail(
        `${opened.length} "sse stream opened" line(s) but no "sse stream closed" — the cold ` +
          'connection above was destroyed, so the route should have run cleanup() and logged ' +
          'it with a reason. Without the close line, open/close pairing (and so a leak) is not ' +
          'observable from outside the process, which is the capability Phase 2 added.',
      );
    }
    return `${opened.length} "sse stream opened" and ${closed.length} "sse stream closed" line(s)`;
  });

  // ── the capacity gate, in a second container ──────────────────────────────
  //
  // A SECOND CONTAINER, varying exactly one variable, for the same reason the
  // sibling harness starts one for OTEL_ENABLED: `MAX_SSE_CONNECTIONS` is read once
  // at boot, so it cannot be varied on a running container — and running the checks
  // above at a cap of 1 would make them depend on the server having noticed the
  // previous socket's abort, which is a race, not an assertion.
  console.log('\nstarting a second container with MAX_SSE_CONNECTIONS=1');
  const capApp = await startApp(platform, 'app-cap', { MAX_SSE_CONNECTIONS: '1' });

  let capFirst = null;
  await runCheck(6, 'over the cap, the next stream is refused 503 SSE_CAPACITY', async () => {
    capFirst = await openStream(capApp.hostPort);
    if (capFirst.status !== 200) {
      fail(`the FIRST stream on the capacity container returned ${capFirst.status}, expected 200`);
    }
    // Wait for its FIRST FRAME, whatever that frame is, before opening the second:
    // the slot is taken inside GET() before the Response is even constructed, so a
    // 200 head already implies it — but a frame on the wire is what proves the stream
    // is LIVE and still holding it. Deliberately NOT asserted to be the prelude:
    // check 3 owns that equality, and borrowing it here would make a pre-Phase-1
    // image fail the CAPACITY check for a reason that has nothing to do with
    // capacity. (The capacity gate does work on pre-Phase-1 code, and this check
    // says so — measured.)
    await capFirst.nextFrame(0, WIRE_DEADLINE_MS);
    const second = await openStream(capApp.hostPort);
    try {
      if (second.status !== 503) {
        fail(
          `the SECOND concurrent stream returned ${second.status} at MAX_SSE_CONNECTIONS=1, ` +
            'expected 503. The cap is the only thing bounding in-process subscriptions.',
        );
      }
      // THE WIRE CONTRACT, NOT THE STATUS CODE. A 503 without `code: SSE_CAPACITY` is
      // a different failure wearing the right status — `/api/health` answers 503 with
      // no database, and the gate answers 503 SERVER_MISCONFIGURED on an empty
      // API_KEYS, so the status alone identifies nothing.
      const text = await second.readBody(WIRE_DEADLINE_MS);
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        fail(`the 503 body is not JSON: ${show(text.slice(0, 300))}`);
      }
      if (body?.code !== 'SSE_CAPACITY') {
        fail(
          `the 503 body's code is ${show(body?.code ?? null)}, expected "SSE_CAPACITY". A 503 ` +
            'from the health route or from the gate\'s SERVER_MISCONFIGURED path wears the same ' +
            'status; the code is what identifies the capacity refusal.',
        );
      }
      return (
        `stream 1: 200 and a first frame on the wire, holding the only slot; stream 2: ` +
        `${show(second.statusLine)} with code ${show(body.code)}` +
        (second.headers.has('retry-after') ? `, retry-after ${show(second.headers.get('retry-after'))}` : '')
      );
    } finally {
      second.close();
    }
  });

  // Testability hook, same rationale as the sibling's PAUSE hooks. The whole run
  // takes seconds, so the window in which two containers AND an open stream socket
  // are live is far too narrow to aim a signal at. Teardown across every exit path
  // is the property this harness most needs to keep — and the socket is the resource
  // class the sibling does not have, so it is the one worth aiming at. Unset in
  // normal runs, including CI.
  const pauseMs = Number(process.env.AITP_VERIFY_SSE_PAUSE_MS) || 0;
  if (pauseMs) {
    console.log(
      `\nAITP_VERIFY_SSE_PAUSE_MS=${pauseMs}: holding 2 containers and ` +
        `${sockets.size} open socket(s) up. Ctrl-C now to exercise teardown.`,
    );
    await new Promise((r) => setTimeout(r, pauseMs));
  }

  capFirst?.close();
  warm.close();

  await runCheck(7, 'both containers are still running at the end', async () => {
    // A container that answered every assertion and then died would leave the whole
    // run green on a dead artifact, because each check read what it needed and moved
    // on. The specific risk here is the one the route's own comments name: an
    // unhandled exception thrown from a heartbeat timer ends the Node process.
    const states = [];
    for (const c of [app, capApp]) {
      const { stdout } = await docker(['inspect', '-f', '{{.State.Running}}', c.name], {
        allowFail: true,
        timeoutMs: 20_000,
      });
      const state = stdout.trim();
      if (state !== 'true') {
        fail(
          `docker inspect reports Running=${show(state)} for ${c.name}. It booted, served ` +
            'streams, and then stopped.\nIts logs end with:\n' +
            (await containerLogs(c.name)).split('\n').slice(-40).join('\n'),
        );
      }
      states.push(`${c.name}: Running=true`);
    }
    return states.join('; ');
  });

  if (opts.dumpWire) {
    // Written LAST and only on the measured connection: the point is a fixture for
    // --parse-fixture and a debugging artifact, so it must hold whatever arrived,
    // including on a red run.
    const out = path.resolve(ROOT, opts.dumpWire);
    const raw = warm.rawBytes;
    if (!raw) fail('--dump-wire was requested but no raw bytes were captured');
    writeFileSync(out, raw);
    console.log(`\nwrote ${raw.length} raw wire byte(s) to ${path.relative(ROOT, out)}`);
  }

  const failures = results.filter((r) => !r.ok).length;
  if (failures) throw new Error(`${failures}/${results.length} SSE stream checks FAILED`);
  console.log(`\nall ${results.length} SSE stream checks passed`);
}

// ── lifecycle wiring ────────────────────────────────────────────────────────
//
// Both halves are required. `cleanupSync()` alone would leave the process ALIVE on
// Ctrl-C, because installing a signal listener suppresses Node's default
// disposition — and with an SSE socket open, "alive" means forever.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(
      `\n${sig} — tearing down ${containers.size} container(s) and ${sockets.size} socket(s)`,
    );
    cleanupSync();
    process.exit(1);
  });
}

// Last-resort sweep for any path that skipped a `finally`. MUST be synchronous.
process.on('exit', cleanupSync);

main()
  .then(() => {
    clearTimeout(watchdog);
    cleanupSync();
    // Exit explicitly: a lingering handle must not turn a passing run into a silent
    // hang, and this harness's whole subject matter is handles that never close.
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\nharness error: ${err.message}`);
    clearTimeout(watchdog);
    cleanupSync();
    process.exit(1);
  });
