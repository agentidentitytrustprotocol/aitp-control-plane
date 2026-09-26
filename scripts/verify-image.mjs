#!/usr/bin/env node
/**
 * Shipped-image conformance harness.
 *
 * `scripts/verify-request-gate.mjs` proves the request gate (`src/proxy.ts`) is
 * ATTACHED — but it boots the server with `npx next start`, and
 * `next.config.ts:3-8` records that `next start` is incompatible with
 * `output: 'standalone'`. The Docker image ships the standalone output
 * (`Dockerfile`: `NEXT_OUTPUT=standalone`, `COPY .next/standalone`,
 * `CMD node server.js`). So gate attachment is proven in a configuration the
 * image never runs, and in the artifact that actually deploys nothing tested it
 * at all. This harness exists to close that gap (aitp-control-plane#68).
 *
 * ── WHAT THIS FILE COVERS TODAY ────────────────────────────────────────────
 * First, static assertions against a BUILT IMAGE, needing no server and no
 * database: the NAPI binary loads, the OpenTelemetry tree was traced in, every
 * traced external present is a symlink that resolves, and the `.node` inventory
 * matches a committed baseline including the arch token.
 *
 * Then a LIVE SUBSTRATE: a run-unique private bridge network, an ephemeral
 * Postgres, the repo's own migrations applied from the host, and the image itself
 * run against them — with `/api/health` asserted to report `db: "ok"` and an AID
 * equal to one derived independently from `CP_AID_SEED_HEX` on the host.
 *
 * On that substrate, GATE ATTACHMENT — the gap #68 is named for: an unauthenticated
 * /api/audit is rejected 401 with `code: INVALID_API_KEY`, a valid key reaches the
 * handler, `x-request-id` is injected on both, and OPTIONS is answered 204 by the
 * gate without reaching a handler.
 *
 * Plus the check that stops all of those being vacuous, which is a PINNED EQUALITY
 * rather than a test of what the matcher satisfies. The gate's matcher set is read
 * out of the image's own .next/server/functions-config-manifest.json and compared to
 * `middlewareMatchers` in the committed baseline, and any matcher key beyond
 * regexp/originalSource fails closed. Three earlier versions of this check tested
 * satisfaction — over HTTP at one path, then at three, then against the whole built
 * route list — and each was defeated by a ONE-LINE matcher edit, because a sampled
 * predicate can always be satisfied by something narrower than it looks. The route
 * count is pinned too, so a manifest that under-reports cannot make the coverage
 * cross-check vacuous. A behavioural probe of a second gated route and a public route
 * sits alongside it, catching a matcher that is correct but whose gate is inert.
 *
 * What is NOT here yet: the revocation signing path and the CORS build-freeze,
 * which land in later commits of this series. Nothing below should be read as
 * already asserting those two.
 *
 * TWO HARNESSES, ON PURPOSE. DO NOT MERGE THEM.
 *   - `verify-request-gate.mjs` owns the `next start` path — a real developer
 *     workflow (`package.json`'s `start` script) — and owns its own build,
 *     because it must bake a CORS_ORIGIN that differs from the runtime one.
 *     `.github/workflows/ci.yml` explicitly protects that file from being
 *     "optimised".
 *   - THIS file owns the standalone Docker artifact, and does NOT own the build
 *     environment — the Dockerfile does.
 * Duplicated assertions rot at different rates.
 *
 * SCOPE LINE. This harness proves ATTACHMENT AND LOADING IN THE STANDALONE
 * ARTIFACT. It must never re-prove the gate's
 * logic: the rate-limit bucket checks need isolated per-IP buckets via
 * CLIENT_IP_HEADER and are already covered against a running server by the
 * sibling harness.
 *
 * ── THE CONTRACT THIS FILE IS HELD TO ─────────────────────────────────────
 * Rule 1 binds the CORS check that is still to come; it is written here, ahead of
 * the code, because it is the reason that check will be worth having. Rules 2 and 3
 * are in force now.
 *   1. THE RUNTIME ENVIRONMENT DIFFERS FROM THE BUILD ENVIRONMENT. When the CORS
 *      check lands it must assert the served header equals the RUNTIME value AND
 *      differs from the value baked into the Dockerfile — parsed out of the
 *      Dockerfile, never hardcoded here, since this harness does not choose it.
 *      Asserting mere presence would pass on a build-frozen artifact, which is
 *      the exact failure being guarded against.
 *   2. EXPECTATIONS COME FROM A COMMITTED, HUMAN-AUDITABLE SNAPSHOT, never
 *      re-derived from the thing under test. Here that is
 *      `scripts/image-artifact-baseline.json`. IN FORCE NOW.
 *   3. ASSERT THE WIRE CONTRACT, NOT THE STATUS CODE. A 401 without
 *      `code: INVALID_API_KEY` is a different failure wearing the right status.
 *      IN FORCE NOW, in checks 8-10.
 *
 * RESOURCE LIFECYCLE — the part a past incident dictates.
 * `verify-request-gate.mjs` records a CI job that passed every check and then
 * hung for 18 minutes because a killed child's stdio pipes stayed open and
 * pinned the event loop. The Docker analogue is a foreground `docker run` or a
 * `docker logs -f`: a long-lived child holding pipes. The design that cannot
 * reproduce it:
 *   - One-shot probe containers run to completion under a per-call timeout and are
 *     registered for teardown BEFORE they are started, so a signal mid-probe still
 *     sweeps them even if `--rm` never fires. Registration-before-creation is not
 *     stylistic: `docker rm -f <name>` issued in the window between the daemon
 *     creating a container and starting it removes nothing, which is how an
 *     earlier revision of this file leaked twelve containers in state `created`.
 *   - The long-lived containers (Postgres and the app) start DETACHED
 *     (`docker run -d`), so nothing long-lived is ever a child of this process,
 *     and their logs are read with ONE-SHOT `docker logs`, never `-f` — a
 *     `docker logs -f` is precisely the long-lived child holding pipes that caused
 *     the incident below. IN FORCE NOW; it was a rule for later commits when this
 *     file created only probe containers.
 *   - Every resource is registered in a `Set` the moment it is created and torn
 *     down by an idempotent cleanup that is safe to call twice.
 *   - Teardown is wired to `finally`, `process.on('exit')`, SIGINT and SIGTERM.
 *     The exit path uses `spawnSync`: an exit handler cannot await, so async
 *     teardown there silently does nothing.
 *   - DO NOT COPY THE SIBLING'S SIGNAL HANDLING. It wires
 *     `process.on('exit', ...)` and NOTHING else, so Ctrl-C terminates it under
 *     Node's default disposition and its teardown never runs (harmless there —
 *     the leak is a local process, not a container and a network). Here both
 *     signal listeners are installed explicitly, and each calls `process.exit(1)`
 *     AFTER cleanup: installing a listener SUPPRESSES Node's default exit, so a
 *     handler that only cleans up leaves the process alive on Ctrl-C, which is
 *     the 18-minute bug wearing a different hat.
 *   - Containers are removed before networks (`network rm` fails while an
 *     endpoint is attached), with a brief retry, and a teardown failure never
 *     masks the real check failure.
 *   - The watchdog timer is `.unref()`ed: `main()` is always awaiting
 *     something so the ceiling still fires, and an unref'd timer cannot itself
 *     be the handle that pins a loop which would otherwise drain.
 *   - The BUILD has its own timeout, separate from the post-build ceiling, so
 *     "the build hung" and "a check hung" are distinguishable — an arm64 build
 *     under QEMU legitimately takes far longer than any check.
 *   - Nothing is ever written INSIDE the container. The image runs as uid 999
 *     and `/app` is root-owned; every observation comes back on stdout. That
 *     removes the write-permission question entirely.
 *
 * Usage:
 *   node scripts/verify-image.mjs [options]
 *     --platform <os/arch>   one platform per invocation (default: host)
 *     --tag <tag>            image tag to build/use
 *     --no-build             reuse an existing local tag
 *     --keep                 skip teardown (prints the cleanup commands)
 *     --prune                sweep leaked resources from an earlier crashed run
 *     --update-baseline      rewrite scripts/image-artifact-baseline.json
 *     --allow-removals       with --update-baseline: consent to a shrinking set
 *     --help
 *
 * Requires the repo's dev dependencies on the host (`npm ci`): migrations run
 * through the repo's own `npm run db:migrate`, and the runtime image bundles no
 * drizzle-kit.
 *
 * Testability hooks: AITP_VERIFY_IMAGE_WATCHDOG_MS overrides the post-build
 * ceiling and AITP_VERIFY_IMAGE_BUILD_MS the build ceiling, so both timeout paths
 * can be exercised deliberately (set one to 1000) without editing this file.
 * AITP_VERIFY_IMAGE_PAUSE_MS holds the live substrate up once it is ready, so the
 * teardown-on-SIGINT path can be exercised with a network and two containers all
 * live — a window under a second wide otherwise. There is no test runner wired to
 * a .mjs script in this repo, so a negative path with no hook is not falsifiable
 * from a diff plus output.
 *
 * NOT torn down: the IMAGE. Teardown covers containers and networks; the built
 * image is deliberately left in the local daemon under a deterministic tag, so a
 * failure can be re-probed with `--no-build`. Remove it by hand
 * (`docker image rm <tag>`) — `--prune` does not touch images. One consequence:
 * the tag is NOT run-unique, so two concurrent runs on different platforms would
 * clobber each other's image. It fails loudly (the arch-token check catches it)
 * but the message is misleading — pass `--tag` when running concurrently.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'image-artifact-baseline.json');

/** Label on every resource, so `--prune` can sweep orphans from a crashed run. */
const LABEL = 'aitp-verify-image';
const RUN_LABEL = 'aitp-verify-image-run';

/**
 * Run-unique id. Names derived from it mean two concurrent runs — locally, or a
 * CI matrix — share the Docker daemon without colliding.
 */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ── in-container paths ──────────────────────────────────────────────────────
const APP_DIR = '/app';
const TRACED_DIR = '/app/.next/node_modules';
const REAL_MODULES = '/app/node_modules';
// The server chunks are what actually `require()` the hashed specifiers, so
// resolution is probed from where they live.
const RESOLVE_FROM = '/app/.next/server/chunks';

// ── timeouts ────────────────────────────────────────────────────────────────
const DEFAULT_DOCKER_MS = 60_000;
const PROBE_MS = 120_000;
/**
 * Post-build ceiling. A hang must fail loudly and fast, never burn a CI slot.
 *
 * It must comfortably exceed the worst realistic post-build case, or it fires
 * first and reports "something hung" in place of the specific, actionable
 * "Postgres never became healthy, here are its logs". Budget: four probes at
 * PROBE_MS (8 min) — and the file notes probe timeouts are realistic under QEMU —
 * plus PG_READY_MS (3 min) plus APP_READY_MS (4 min) plus MIGRATE_MS (3 min) is
 * about 18 minutes, so 25 leaves genuine headroom rather than the 2-4 minutes a
 * 20-minute ceiling left. Keep BUILD_MS_NATIVE + this BELOW the `verify-image`
 * job's `timeout-minutes` in ci.yml.
 */
const WATCHDOG_MS = Number(process.env.AITP_VERIFY_IMAGE_WATCHDOG_MS) || 25 * 60_000;
/**
 * Build ceilings, deliberately separate from the watchdog so "the build hung"
 * and "a check hung" are distinguishable. Keep BUILD_MS_NATIVE + WATCHDOG_MS
 * BELOW the `verify-image` job's `timeout-minutes` in ci.yml, or GitHub kills
 * the job before the harness can print which of the two it was.
 * AITP_VERIFY_IMAGE_BUILD_MS is a testability hook, like the watchdog's.
 */
const BUILD_MS_NATIVE = Number(process.env.AITP_VERIFY_IMAGE_BUILD_MS) || 25 * 60_000;
const BUILD_MS_EMULATED =
  Number(process.env.AITP_VERIFY_IMAGE_BUILD_MS) || 60 * 60_000;

// ── live-substrate settings ─────────────────────────────────────────────────
/**
 * Readiness deadlines, deliberately SEPARATE from the watchdog and generous
 * enough for an emulated boot. Elapsed time is printed on success so a slow boot
 * is visible rather than mysterious.
 */
const PG_READY_MS = 180_000;
const APP_READY_MS = 240_000;
/** Per-request deadline, so one wedged route cannot consume the watchdog. */
const HTTP_MS = 20_000;
/** Deadline for the migration child — the one long-running process that is not a
 *  `docker` call, and so the one place a wedge could otherwise eat the watchdog. */
const MIGRATE_MS = 180_000;

/**
 * The CORS origin the CONTAINER is run with.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, so this can never
 * collide with a real origin. It also differs from the value the Dockerfile bakes
 * in at build time; no check compares the two yet, and when the CORS build-freeze
 * check lands that difference is what will make it falsifiable.
 */
const RUNTIME_ORIGIN = 'https://runtime-probe.invalid';
/** A fixed NON-PRODUCTION seed, so the derived AID is deterministic and can be
 *  asserted. Not a secret, and never used anywhere but this harness. */
const SEED_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
/**
 * Must be NON-EMPTY. With `API_KEYS` empty under `NODE_ENV=production` the gate
 * answers 503 SERVER_MISCONFIGURED rather than 401, so an empty value here would
 * silently exercise a different code path than the one being asserted.
 */
const API_KEY = 'verify-image-harness-key-0000';
/** >= 32 chars, or EnrollmentService throws when first constructed. */
const ENROLLMENT_SECRET = 'verify-image-harness-secret-min-thirty-two-chars';
/** Matches ci.yml and docker-compose.yml rather than introducing a third pin. */
const PG_IMAGE = 'postgres:16-alpine';
const PG_DB = 'aitp_verify_image';
const PG_USER = 'postgres';
const PG_PASS = 'postgres';

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    platform: null,
    tag: 'aitp-control-plane:verify-image',
    build: true,
    keep: false,
    prune: false,
    updateBaseline: false,
    allowRemovals: false,
    help: false,
  };
  /** A value-taking flag must actually be followed by a value, not by nothing
   *  and not by the next flag — otherwise `--platform` as the last token would
   *  silently fall back to the host platform and the run would quietly verify
   *  something other than what was asked for. */
  const value = (flag, i) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
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
      case '--update-baseline':
        opts.updateBaseline = true;
        break;
      case '--allow-removals':
        opts.allowRemovals = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${a} (try --help)`);
    }
  }
  // Reject rather than ignore: a typo'd `--allow-removals` on a verification run
  // would otherwise look like it had done something.
  if (opts.allowRemovals && !opts.updateBaseline) {
    throw new Error('--allow-removals only means anything together with --update-baseline');
  }
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  // Parsing happens before main(), so without this an unknown flag prints a raw
  // Node stack trace and the version banner instead of one actionable line.
  console.error(`verify-image: ${err.message}`);
  process.exit(1);
}

const HELP = `verify-image — prove the request gate and the native/OTel paths attach in the
shipped standalone Docker image.

  node scripts/verify-image.mjs [options]

  --platform <os/arch>   one platform per invocation (default: the host's).
                         A comma-separated list is rejected: "docker buildx
                         build --load" cannot load a multi-platform manifest.
  --tag <tag>            image tag to build and probe
                         (default aitp-control-plane:verify-image)
  --no-build             reuse an existing local tag instead of building
  --keep                 skip teardown and print the cleanup commands
  --prune                remove resources left by an earlier crashed run, then exit
  --update-baseline      rewrite scripts/image-artifact-baseline.json from the image.
                         Prints the diff against the existing baseline first, and
                         refuses if any entry would DISAPPEAR (see --allow-removals).
  --allow-removals       with --update-baseline: consent to recording a baseline
                         from which entries have vanished. Needed only for an
                         intentional removal — otherwise it blesses a regression.
  --help                 this text
`;

// ── resource registry ───────────────────────────────────────────────────────
/** Containers created this run. Registered BEFORE creation, never after. */
const containers = new Set();
/** Networks created this run. */
const networks = new Set();
/** Live `docker` CLI children, so no pipe can outlive a signal. */
const liveChildren = new Set();

function nameFor(kind) {
  return `${LABEL}-${RUN_ID}-${kind}`;
}

function labelArgs() {
  return ['--label', `${LABEL}=1`, '--label', `${RUN_LABEL}=${RUN_ID}`];
}

// ── docker plumbing ─────────────────────────────────────────────────────────
/** Keep an error message readable: a probe's `-e <script>` argument is huge. */
function summariseArgs(args) {
  return args.map((a) => (a.length > 80 ? '<script>' : a)).join(' ');
}

/**
 * Run a `docker` command and capture its output.
 *
 * The child is tracked so a signal or the watchdog can kill it and destroy its
 * pipes; the per-call timeout means one wedged docker invocation cannot consume
 * the whole ceiling.
 */
function docker(args, { timeoutMs = DEFAULT_DOCKER_MS, allowFail = false, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
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
        // summariseArgs, not args.join: a probe timeout would otherwise echo the
        // whole embedded probe script into the failure text — the same unreadable
        // output the non-zero-exit path below was already fixed to avoid. Probe
        // timeouts are realistic under QEMU emulation in CI, so this path is hot.
        reject(new Error(`\`docker ${summariseArgs(args)}\` timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0 && !allowFail) {
        reject(
          new Error(
            `\`docker ${summariseArgs(args)}\` exited ${code}\n${(err.trim() || out.trim()).slice(0, 4000)}`,
          ),
        );
        return;
      }
      resolve({ code, stdout: out, stderr: err });
    });
    if (input !== null) child.stdin.end(input);
  });
}

/**
 * Run a `docker` command with its output inherited (live progress, no pipes).
 *
 * Used for the build: it is the one long-running invocation, and inheriting
 * stdio means there is no pipe to leak in the first place. Docker prints its
 * own diagnostics to the inherited stderr, which is what CI shows anyway.
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
              'timeout (separate from the post-build watchdog, so this is "the build ' +
              'hung", not "a check hung")',
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

/**
 * Spawn a child that LEADS ITS OWN PROCESS GROUP, so teardown can signal the group
 * and reach grandchildren.
 *
 * `npm run <script>` is `npm` with the real work as a grandchild, and `child.kill()`
 * reaches only `npm` — leaving the process that holds the database connection alive.
 *
 * This exists as a helper rather than two lines at the call site because the two
 * halves MUST NOT drift apart: `detached: true` is what makes the pid a group
 * leader, and the marker is what tells teardown to use a negative pid. Set the
 * marker without detaching and the group kill fails with ESRCH, which teardown can
 * only answer by killing the child alone — the grandchild then orphans while
 * teardown reports success. Verified: that is exactly what happens. Binding them
 * together in one function makes the mismatch unrepresentable.
 */
function spawnOwnGroup(cmd, args, opts2) {
  const child = spawn(cmd, args, { ...opts2, detached: true });
  child.__ownsProcessGroup = true;
  return child;
}

// ── teardown ────────────────────────────────────────────────────────────────
function killLiveChildren() {
  for (const child of liveChildren) {
    // Kill the child's whole PROCESS GROUP where it has one, not just the child.
    // `npm run db:migrate` is `npm` with drizzle-kit as a grandchild, and
    // `child.kill()` reaches only `npm` — leaving drizzle-kit orphaned. Children
    // that need this are spawned `detached: true` so they lead their own group and
    // the negative pid cannot possibly signal this process. Falls back to the plain
    // kill for the `docker` children, which have no group of their own.
    try {
      if (child.__ownsProcessGroup && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // A group kill can legitimately fail with ESRCH — the group is already gone,
      // or the flag was set on a child that was NOT spawned `detached`, in which case
      // its pid leads no group. Swallowing that would leave the child alive while
      // teardown reported success: green while false, which is the failure shape this
      // file keeps finding. Always fall back to killing the child directly.
      try {
        child.kill('SIGKILL');
      } catch {
        /* genuinely gone */
      }
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  liveChildren.clear();
}

function printKeepInstructions() {
  const cs = [...containers];
  const ns = [...networks];
  if (!cs.length && !ns.length) return;
  console.log('\n--keep: resources left running. Remove them with:');
  if (cs.length) console.log(`  docker rm -f -v ${cs.join(' ')}`);
  if (ns.length) console.log(`  docker network rm ${ns.join(' ')}`);
  console.log(`  # or sweep every orphan of this harness: node scripts/verify-image.mjs --prune`);
}

/** Block the thread. Only ever called from teardown, where nothing else may run. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function dockerSyncLines(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 20_000 });
  return String(r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * THE ONLY TEARDOWN. Synchronous, and used by every exit path: the end of
 * `main()`, the error path, `process.on('exit')`, SIGINT and SIGTERM.
 *
 * Synchronous because an exit handler cannot await, so async teardown there
 * silently does nothing — and having ONE implementation means the path that is
 * hardest to test cannot drift from the path that is easy to test. Blocking the
 * event loop here is not a cost: at teardown nothing else may proceed.
 *
 * It VERIFIES rather than fires and forgets, and it sweeps by LABEL rather than
 * only by name. Both were bought with a real bug: killing the `docker run` CLI
 * can land in the window between the daemon creating a container and starting
 * it, and a `docker rm -f <name>` issued in that window removes nothing — the
 * container then sits in state `created` with its `--rm` autoremove pending
 * forever. Observed: 12 leaked containers across a SIGINT sweep, all in state
 * `created`, all with `AutoRemove=true`. Name-based removal is the fast path;
 * the label-filtered re-check is what makes teardown actually true. Two
 * consecutive empty listings are required, so a container that materialises a
 * few milliseconds after the first attempt is still caught.
 *
 * Idempotent: the registries are emptied on the first call.
 */
let sweepDone = false;
let keepPrinted = false;

function cleanupSync() {
  killLiveChildren();
  if (opts.keep) {
    if (!keepPrinted) {
      keepPrinted = true;
      printKeepInstructions();
    }
    return;
  }
  // A signal handler runs cleanup and then `process.exit(1)`, which fires the
  // 'exit' handler, which would otherwise repeat the whole label sweep — two
  // more `docker ps`/`network ls` round-trips for nothing. Idempotence is kept
  // (the registries are emptied on the first call); this only skips the redo.
  if (sweepDone && !containers.size && !networks.size) return;
  const cs = [...containers];
  containers.clear();
  const ns = [...networks];
  networks.clear();

  // Fast path: remove what we know we created, by name.
  //
  // `-v` everywhere a container is removed. An image that declares a VOLUME makes
  // an anonymous volume on `docker run`, and `docker rm -f` without `-v` strands
  // it — a leak the container/network registries cannot see, so the harness would
  // report clean while leaking. Postgres is additionally run on a tmpfs so no such
  // volume exists in the first place; this is the backstop, not the fix.
  for (const c of cs) {
    spawnSync('docker', ['rm', '-f', '-v', c], { stdio: 'ignore', timeout: 30_000 });
  }

  // Correctness path: containers FIRST — `network rm` fails while an endpoint is
  // still attached.
  sweepByLabelSync('container', () =>
    dockerSyncLines(['ps', '-aq', '--filter', `label=${RUN_LABEL}=${RUN_ID}`]),
  (ids) => spawnSync('docker', ['rm', '-f', '-v', ...ids], { stdio: 'ignore', timeout: 30_000 }));

  for (const n of ns) {
    spawnSync('docker', ['network', 'rm', n], { stdio: 'ignore', timeout: 20_000 });
  }
  sweepByLabelSync('network', () =>
    dockerSyncLines(['network', 'ls', '-q', '--filter', `label=${RUN_LABEL}=${RUN_ID}`]),
  (ids) => spawnSync('docker', ['network', 'rm', ...ids], { stdio: 'ignore', timeout: 20_000 }));

  sweepDone = true;
}

/** Remove everything this run labelled, until two consecutive listings are empty. */
function sweepByLabelSync(kind, list, remove) {
  let consecutiveEmpty = 0;
  for (let attempt = 0; attempt < 12 && consecutiveEmpty < 2; attempt++) {
    let ids;
    try {
      ids = list();
    } catch {
      return;
    }
    if (!ids.length) {
      consecutiveEmpty++;
      if (consecutiveEmpty < 2) sleepSync(150);
      continue;
    }
    consecutiveEmpty = 0;
    try {
      remove(ids);
    } catch (err) {
      // A throw here would abort teardown for everything after it.
      console.error(`  (teardown) removing ${kind}(s) threw: ${err.message}`);
    }
    sleepSync(150);
  }
  // Never let a teardown failure mask the real check failure: report and move on.
  let leftover = [];
  try {
    leftover = list();
  } catch {
    /* docker gone; nothing useful to say */
  }
  if (leftover.length) {
    console.error(
      `  (teardown) ${leftover.length} ${kind}(s) survived: ${leftover.join(', ')} — ` +
        'sweep them with `node scripts/verify-image.mjs --prune`',
    );
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
  // An unref'd timer still fires while main() is awaiting, and cannot itself be
  // the handle that pins a loop which would otherwise drain.
  watchdog.unref();
}

// ── platform helpers ────────────────────────────────────────────────────────
const DOCKER_ARCH = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'amd64', amd64: 'amd64' };
/** npm/NAPI arch token for a docker platform arch. */
const NAPI_ARCH = { amd64: 'x64', arm64: 'arm64' };

function platformArch(platform) {
  const parts = platform.split('/');
  return parts[1] ?? '';
}

async function assertDockerAvailable() {
  try {
    const { stdout } = await docker(['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(
      'docker is unavailable — install the CLI and start the daemon. This harness ' +
        `cannot run without it.\n  underlying error: ${err.message}`,
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

// ── build / image checks ────────────────────────────────────────────────────
async function buildImage(platform, tag, emulated) {
  const timeoutMs = emulated ? BUILD_MS_EMULATED : BUILD_MS_NATIVE;
  console.log(
    `building ${tag} for ${platform} (no layer cache configured — see the ` +
      'verify-image job comment in ci.yml for why; budget for a cold build)',
  );
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
    { timeoutMs },
  );
}

async function assertImageMatchesPlatform(tag, platform) {
  let inspected;
  try {
    const { stdout } = await docker(['image', 'inspect', tag, '--format', '{{.Architecture}}'], {
      timeoutMs: 30_000,
    });
    inspected = stdout.trim();
  } catch {
    throw new Error(
      `no local image tagged \`${tag}\`. Drop --no-build to build it, or pass ` +
        '--tag with a tag that exists.',
    );
  }
  const want = platformArch(platform);
  if (inspected !== want) {
    throw new Error(
      `image \`${tag}\` is ${inspected} but --platform asked for ${want}. Running it ` +
        'would fail with an opaque `exec format error`; rebuild without --no-build.',
    );
  }
}

// ── static probes ───────────────────────────────────────────────────────────
//
// Each probe is a small script whose ONLY output is one JSON line, so a parse
// failure is attributable to a single probe rather than to "the harness".

const PROBE_NAPI = `
const m = require('aitp');
process.stdout.write(JSON.stringify({ aitpAgent: typeof m.AitpAgent }));
`;

/**
 * Prove the OpenTelemetry tree was TRACED, not merely installed.
 *
 * A bare `require.resolve('@opentelemetry/sdk-node')` — which is what this probe
 * used to be — runs from the image's WORKDIR `/app` and therefore resolves
 * through `/app/node_modules`. That answers "is the package installed and
 * loadable", which is a different and much weaker question: an image with
 * `.next/node_modules/@opentelemetry` deleted outright still passed. Verified,
 * not theorised — five of the eight traced externals can vanish while the check
 * that names them stays green.
 *
 * So look where tracing actually puts things: the `@opentelemetry` scope
 * directory under `.next/node_modules`, and `sdk-node` resolved THROUGH that
 * traced path rather than through the flat install.
 */
const PROBE_OTEL = `
const fs = require('fs');
const SCOPE = ${JSON.stringify(`${TRACED_DIR}/@opentelemetry`)};
// The entries INSIDE the scope directory carry the 16-hex Turbopack suffix too
// (e.g. sdk-node-2cf9b989c3033bc0), so look the package up by its stripped name.
// Hardcoding a hash here would break on the next dependency bump.
function strip(n) { return n.replace(/-[0-9a-f]{16}$/, ''); }
let scopeEntries = null, scopeError = null;
try { scopeEntries = fs.readdirSync(SCOPE).sort(); }
catch (e) { scopeError = e.message; }
const entry = (scopeEntries || []).filter(function (n) { return strip(n) === 'sdk-node'; })[0] || null;
let tracedRealpath = null, tracedResolved = null, tracedError = null;
if (entry) {
  try { tracedRealpath = fs.realpathSync(SCOPE + '/' + entry); }
  catch (e) { tracedError = 'realpath: ' + e.message; }
  try { tracedResolved = require.resolve(SCOPE + '/' + entry); }
  catch (e) { tracedError = (tracedError ? tracedError + '; ' : '') + 'require.resolve: ' + e.message; }
}
process.stdout.write(JSON.stringify({
  scopeEntries: scopeEntries, scopeError: scopeError, entry: entry,
  stripped: (scopeEntries || []).map(strip).sort(),
  tracedRealpath: tracedRealpath, tracedResolved: tracedResolved, tracedError: tracedError,
}));
`;

/**
 * Walk the traced-externals tree and report every leaf.
 *
 * Recurses THROUGH scope directories: `.next/node_modules/@opentelemetry` is a
 * real directory holding five symlinks, not a symlink itself, so a sweep that
 * asserts "every entry is a symlink" fails on a healthy image.
 */
const PROBE_SWEEP = `
const fs = require('fs');
const path = require('path');
const ROOT = ${JSON.stringify(TRACED_DIR)};
const RESOLVE_FROM = ${JSON.stringify(RESOLVE_FROM)};
const leaves = [];
const anomalies = [];
function walk(dir, prefix, depth) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const spec = prefix ? prefix + '/' + ent.name : ent.name;
    if (ent.isSymbolicLink()) {
      const leaf = { spec: spec, realpath: null, resolved: null, error: null };
      try { leaf.realpath = fs.realpathSync(full); }
      catch (e) { leaf.error = 'realpath: ' + e.message; }
      try { leaf.resolved = require.resolve(spec, { paths: [RESOLVE_FROM] }); }
      catch (e) { leaf.error = (leaf.error ? leaf.error + '; ' : '') + 'require.resolve: ' + e.message; }
      leaves.push(leaf);
    } else if (ent.isDirectory() && ent.name.charAt(0) === '@' && depth === 0) {
      walk(full, spec, depth + 1);
    } else {
      anomalies.push({ spec: spec, kind: ent.isDirectory() ? 'directory' : 'file' });
    }
  }
}
let exists = true;
try { fs.statSync(ROOT); } catch (e) { exists = false; }
// require.resolve() walks up from its start path and SUCCEEDS even when that
// path does not exist, so resolution alone would not prove the server chunks
// are really there. Assert it separately.
let resolveFromExists = true;
try { fs.statSync(RESOLVE_FROM); } catch (e) { resolveFromExists = false; }
let error = null;
if (exists) { try { walk(ROOT, '', 0); } catch (e) { error = e.message; } }
leaves.sort(function (a, b) { return a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0; });
process.stdout.write(JSON.stringify({ exists: exists, resolveFromExists: resolveFromExists, error: error, leaves: leaves, anomalies: anomalies }));
`;

/**
 * Inventory every `.node` in the image.
 *
 * `fs.readdirSync(dir, {recursive:true})` rather than `find`: it depends on
 * nothing beyond `node`, comes back structured, and does not follow symlinks
 * (so the hashed traced entries are not counted twice).
 */
const PROBE_NATIVE = `
const fs = require('fs');
let files = [];
let error = null;
try {
  files = fs.readdirSync(${JSON.stringify(APP_DIR)}, { recursive: true })
    .filter(function (p) { return String(p).slice(-5) === '.node'; })
    .map(function (p) { return String(p).split('\\\\').join('/'); })
    .sort();
} catch (e) { error = e.message; }
process.stdout.write(JSON.stringify({ error: error, files: files }));
`;

/**
 * Read the middleware matchers and the full built-route list out of the image.
 *
 * WHY STATIC RATHER THAN MORE HTTP PROBES. Any FINITE set of probed paths can be
 * satisfied by a matcher that enumerates exactly those paths. Measured, twice: a
 * matcher of `['/api/audit']` defeats a one-path probe set, and
 * `['/api/audit', '/api/webhooks', '/api/health']` defeats the three-path set that
 * replaced it — 11/11 green while /api/sessions, /api/tcts, /api/delegations,
 * /api/trust-anchors and /api/pinned-keys all answered anonymously, and an
 * anonymous POST reached a handler's body validation. Adding a fourth probe just
 * moves the goalposts one token. The artifact RECORDS the matcher, so the whole
 * tree can be checked instead of sampled.
 *
 * The regexps are evaluated INSIDE the container by the same Node that serves the
 * app, so this borrows Next's own compiled semantics rather than reimplementing
 * path-to-regexp on the host and hoping the two agree.
 *
 * NOT `middleware-manifest.json`: it is `{"middleware":{},"sortedMiddleware":[]}`
 * in this image — and, verified, also in an image whose gate IS attached — so a
 * check written against it would be vacuously green forever.
 */
const PROBE_MIDDLEWARE = `
const P = '/app/.next/server/functions-config-manifest.json';
let error = null, routes = [], matchers = [], uncovered = [];
try {
  const f = require(P).functions || {};
  const mw = f['/_middleware'];
  // Carry the matcher objects WHOLE. Keeping only regexp/originalSource dropped
  // \`has\`/\`missing\` conditions, which Next enforces at runtime — so a matcher of
  // { source: '/api/:path*', missing: [{type:'header',key:'cookie'}] } looked
  // IDENTICAL to the correct one while any request carrying a cookie (i.e. every
  // browser request) bypassed the gate entirely. Measured: GET /api/audit with a
  // cookie returned the admin audit log. Unknown keys are the danger, so report
  // them all and let the host decide.
  matchers = ((mw && mw.matchers) || []).map(function (m) {
    const out = {};
    Object.keys(m).sort().forEach(function (k) { out[k] = m[k]; });
    return out;
  });
  const res = matchers.map(function (m) { return new RegExp(m.regexp); });
  routes = Object.keys(f)
    .filter(function (k) { return k === '/api' || k.indexOf('/api/') === 0; })
    .sort();
  // Dynamic segments must become something concrete before they can be tested.
  // Catch-alls first, so [...slug] is not eaten by the single-segment pattern.
  uncovered = routes.filter(function (r) {
    const c = r
      .replace(/\\[\\[\\.\\.\\.[^\\]]+\\]\\]/g, 'a/b')
      .replace(/\\[\\.\\.\\.[^\\]]+\\]/g, 'a/b')
      .replace(/\\[[^\\]]+\\]/g, 'a');
    return !res.some(function (re) { return re.test(c); });
  });
} catch (e) { error = String((e && e.message) || e); }
process.stdout.write(JSON.stringify({
  error: error, routes: routes, matchers: matchers, uncovered: uncovered,
}));
`;

/**
 * Run one probe script inside the image and parse its single JSON line.
 *
 * The container is named and registered for teardown BEFORE it is started, so a
 * signal mid-probe sweeps it even if `--rm` never fires.
 */
async function probe(tag, platform, label, script) {
  try {
    return await runProbe(tag, platform, label, script);
  } catch (err) {
    // NEVER throw out of a probe. A probe that fails — including one whose script
    // throws INSIDE the container, e.g. `require('aitp')` when the native binary
    // is missing — must surface as a NAMED check failure carrying the container's
    // own stderr, not abort the run with an unattributable `docker run ... exited 1`.
    // Aborting also skipped the structural-check gate that makes `--update-baseline`
    // refuse a broken image, so the refusal was never reached.
    // Wrapped in a Proxy so that FORGETTING `requireProbe` is loud rather than
    // silent. Without it, a new check reading `napi.aitpAgent` off a failed probe
    // gets `undefined` and reports a confident, wrong diagnosis ("expected
    // function, got undefined") instead of the container's real error. Every
    // property but `__error` throws.
    return failedProbe(label, err.message);
  }
}

/**
 * A failed probe's result: carries `__error`, throws on everything else.
 *
 * `then` must stay readable and undefined — `await`ing this object would
 * otherwise throw inside the microtask queue rather than at the access site.
 */
function failedProbe(label, message) {
  return new Proxy(
    { __error: message },
    {
      get(target, prop) {
        if (prop === '__error' || prop === 'then' || typeof prop === 'symbol') {
          return target[prop];
        }
        throw new Error(
          `probe \`${label}\` failed and its result was read (.${String(prop)}) without ` +
            `going through requireProbe(). The underlying failure was:\n${message}`,
        );
      },
    },
  );
}

/** Fail the current check with the probe's recorded error, if it had one. */
function requireProbe(result, label) {
  if (result?.__error) {
    fail(`probe \`${label}\` failed:\n${result.__error}`);
  }
  return result;
}

async function runProbe(tag, platform, label, script) {
  const name = nameFor(`probe-${label}`);
  containers.add(name);
  try {
    const { stdout, stderr } = await docker(
      [
        'run',
        '--rm',
        '--name',
        name,
        '--platform',
        platform,
        ...labelArgs(),
        '--entrypoint',
        'node',
        tag,
        '-e',
        script,
      ],
      { timeoutMs: PROBE_MS },
    );
    const line = stdout.trim();
    if (!line) {
      throw new Error(`probe \`${label}\` produced no output.\nstderr: ${stderr.trim()}`);
    }
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(
        `probe \`${label}\` did not emit parseable JSON:\n${line.slice(0, 2000)}`,
      );
    }
  } finally {
    containers.delete(name);
  }
}

// ── normalisation, so ONE baseline serves both arches ───────────────────────
/** Strip the 16-hex Turbopack suffix. The hash is Next's internal detail and
 *  must never be hardcoded; deriving the name from the artifact cannot rot. */
function stripHash(spec) {
  return spec.replace(/-[0-9a-f]{16}$/, '');
}

/** Replace the arch token and drop a trailing `-<semver>` before `.node`. */
function normaliseNativePath(p) {
  return p
    .replace(/(^|[-/.])(arm64|aarch64|x64|amd64|x86_64)(?=[-/.]|$)/g, '$1<ARCH>')
    .replace(/-\d+\.\d+\.\d+(?=\.node$)/, '');
}

// ── check runner ────────────────────────────────────────────────────────────
// ── live substrate ──────────────────────────────────────────────────────────
//
// Everything below stands up a REAL deployment of the image: its own bridge
// network, its own Postgres, the repo's own migrations, and the image itself run
// against them. The static probes above can only see the artifact's shape; these
// are what let later checks assert behaviour over HTTP.
//
// Every resource is registered for teardown BEFORE it is created. That ordering
// is not stylistic: `docker rm -f <name>` issued between the daemon creating a
// container and starting it removes nothing, which is how an earlier revision of
// this file leaked twelve containers in state `created` under a SIGINT sweep.

/**
 * Derive `aid:pubkey:<base64url(raw Ed25519 public key)>` from a 32-byte seed,
 * using `node:crypto` and NOTHING else.
 *
 * Deriving it with the SDK would compare the SDK against itself and prove
 * nothing. This is an independent implementation, so the health-check assertion
 * becomes a genuine cross-implementation equality — and it keeps the harness's
 * host side free of any native dependency, which matters because the host may be
 * a different arch from the image. Same discipline as the hand-rolled verifier in
 * src/e2e/revocation-flow.integration.test.ts.
 */
function deriveAid(seedHex) {
  const seed = Buffer.from(seedHex, 'hex');
  if (seed.length !== 32) {
    fail(`CP_AID_SEED_HEX must decode to 32 bytes, got ${seed.length}`);
  }
  // A PKCS#8 Ed25519 private key is a fixed 16-byte prefix followed by the seed.
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  // The last 32 bytes of an Ed25519 SPKI DER are the raw public key.
  return `aid:pubkey:${spki.subarray(spki.length - 32).toString('base64url')}`;
}

/** An HTTP request with its own deadline, so one wedged route cannot eat the
 *  watchdog. Returns the parsed body when it is JSON, the raw text otherwise. */
async function httpReq(base, pathname, opts2 = {}) {
  const { method = 'GET', key = null, origin = true, timeoutMs = HTTP_MS } = opts2;
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (origin) headers.origin = RUNTIME_ORIGIN;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${pathname}`, { method, headers, signal: ac.signal });
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, headers: res.headers, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/** One-shot `docker logs`. Never `-f`: a follower is a long-lived child holding
 *  pipes open, which is precisely the 18-minute-hang bug class. */
async function containerLogs(name) {
  const { stdout, stderr } = await docker(['logs', name], {
    allowFail: true,
    timeoutMs: 60_000,
  });
  return `${stdout}${stderr}`.trim() || '(no output)';
}

/** A run-unique private bridge network, so the app reaches Postgres by container
 *  name — identical locally and in CI. */
async function createNetwork() {
  const name = nameFor('net');
  networks.add(name);
  await docker(['network', 'create', ...labelArgs(), name], { timeoutMs: 60_000 });
  return name;
}

/**
 * Note what is NOT passed here: `--platform`. Postgres runs NATIVE even when the
 * image under test is emulated, so an amd64 run on an arm64 host has an emulated
 * app talking to a native Postgres. That is deliberate — only container-to-container
 * TCP crosses the boundary, and emulating the database would slow every run for no
 * assertion gained. The consequence to know: an emulated run does not exercise an
 * all-one-arch substrate. The image under test is always the requested platform,
 * which is the thing this harness is about.
 */
async function startPostgres(net) {
  const name = nameFor('pg');
  containers.add(name);
  await docker(
    [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      net,
      // Loopback-bound EPHEMERAL port. Never 0.0.0.0, and never a fixed 5432 or
      // 5433: those collide with docker-compose and with ci.yml's service.
      '-p',
      '127.0.0.1:0:5432',
      // Keep the data directory in RAM so NO anonymous volume is ever created.
      //
      // postgres:16-alpine declares `VOLUME /var/lib/postgresql/data`, so a plain
      // `docker run` makes an anonymous volume and `docker rm -f` without `-v`
      // leaves it behind — on success as much as on failure. Measured: ~46 MB per
      // run, surviving every exit path. Worse than the disk cost, it was INVISIBLE
      // to this harness's own leak check, which counts containers and networks; a
      // run could report "nothing leaked" while leaking. A volume that never
      // exists cannot be forgotten, and the database is throwaway, so tmpfs is
      // both the smaller surface and the faster one. `-v` on the removals below is
      // the backstop for anything that still manages to create one.
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=512m',
      '-e',
      `POSTGRES_USER=${PG_USER}`,
      '-e',
      `POSTGRES_PASSWORD=${PG_PASS}`,
      '-e',
      `POSTGRES_DB=${PG_DB}`,
      // The container's OWN healthcheck, same idiom as ci.yml and
      // docker-compose.yml, rather than inventing a third readiness convention.
      '--health-cmd',
      `pg_isready -U ${PG_USER} -d ${PG_DB}`,
      '--health-interval',
      '2s',
      '--health-timeout',
      '5s',
      '--health-retries',
      '30',
      ...labelArgs(),
      PG_IMAGE,
    ],
    { timeoutMs: 180_000 },
  );

  const started = Date.now();
  for (;;) {
    const { stdout } = await docker(['inspect', '-f', '{{.State.Health.Status}}', name], {
      allowFail: true,
      timeoutMs: 20_000,
    });
    if (stdout.trim() === 'healthy') break;
    if (Date.now() - started > PG_READY_MS) {
      fail(
        `Postgres never became healthy in ${Math.round(PG_READY_MS / 1000)}s ` +
          `(last status: ${stdout.trim() || 'unknown'}). Its logs:\n${await containerLogs(name)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const { stdout: portOut } = await docker(['port', name, '5432/tcp'], { timeoutMs: 20_000 });
  const hostPort = portOut.trim().split('\n')[0]?.split(':').pop();
  if (!hostPort) {
    fail(
      `could not read Postgres's published host port from \`docker port\`: ` +
        `${JSON.stringify(portOut)}. Migrations run from the host against that port, so ` +
        'there is nothing to fall back to.',
    );
  }
  console.log(
    `postgres healthy in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(127.0.0.1:${hostPort})`,
  );
  return { name, hostPort };
}

/**
 * Apply the repo's own migrations from the HOST.
 *
 * Mandatory, and the reason is empirical rather than tidy-minded: unmigrated,
 * src/lib/revocation/producer.ts catches the DB read failure and publishes an
 * EMPTY BUT VALIDLY SIGNED list, so a signature check would pass against an image
 * whose database access is completely broken; and /api/audit with a valid key
 * answers 500, so there would be no way to tell an attached gate from a rejecting
 * one. An unmigrated harness is a harness that lies.
 *
 * On the host because the runtime image bundles no drizzle-kit — see
 * docs/operations.md. That is why Postgres publishes an ephemeral host port at
 * all.
 */
async function migrate(hostPort) {
  const url = `postgres://${PG_USER}:${PG_PASS}@127.0.0.1:${hostPort}/${PG_DB}`;
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawnOwnGroup('npm', ['run', 'db:migrate'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    liveChildren.add(child);
    const out = [];
    // Every `docker` call carries its own deadline so no single wedged invocation
    // can consume the whole post-build ceiling. This child is the one long-running
    // process that is not a `docker` call, and it needs the same treatment:
    // drizzle-kit blocked on a Postgres advisory lock would otherwise burn the
    // entire watchdog and then report "something hung" instead of naming the step.
    //
    // Kill the GROUP, not the child. An earlier revision killed only `npm` and
    // reasoned that leaving the child inside this process group was safer, because
    // an interactive Ctrl-C signals the whole foreground group and would reach
    // drizzle-kit directly. That reasoning was measured only against
    // process-group signals, and it does not hold for a signal aimed at this
    // process's pid alone (a supervisor, `timeout`, `kill -INT <pid>`) or for this
    // timeout path — both of which orphaned drizzle-kit. Since teardown runs on
    // every one of those paths anyway, owning the group and killing it explicitly
    // covers all of them.
    //
    // ONE MEASURED TRADE-OFF, stated rather than glossed: under `kill -9` aimed at
    // this harness's process group, the OLD arrangement killed the grandchild as a
    // side effect (it shared our group) whereas now it survives, because our handler
    // never runs to kill its group. That path already leaked the container and the
    // network on both arrangements — SIGKILL is not a path any teardown can cover —
    // so it trades a process leak on one uncatchable path for correctness on the
    // three catchable ones. Worth the exchange, but it is an exchange.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Only signal a child that is still running. `clearTimeout` happens in the
      // `close` handler, so there is a narrow window where the child has exited, its
      // close event is still queued, and the OS has reused its pid as a new group
      // leader — a negative-pid SIGKILL would then hit an unrelated process group.
      // Sub-millisecond and needs pid wraparound, but this is a kill by negative pid,
      // where being wrong is expensive.
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, MIGRATE_MS);
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      reject(new Error(`could not run \`npm run db:migrate\`: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (timedOut) {
        reject(
          new Error(
            `migrations TIMED OUT after ${Math.round(MIGRATE_MS / 1000)}s — most likely ` +
              `drizzle-kit is blocked on a lock. Output so far:\n${out.join('').trim()}`,
          ),
        );
        return;
      }
      if (code !== 0) {
        // Never continue to checks against a half-migrated schema: they would
        // report application bugs that are really missing tables.
        reject(
          new Error(
            `migrations FAILED (drizzle-kit exit ${code}). Nothing is checked against a ` +
              `half-migrated schema.\n${out.join('').trim()}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
  console.log(`migrations applied in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/**
 * Prove the migrations actually built a schema, rather than trusting exit 0.
 *
 * This is load-bearing, and the reason is measured rather than theoretical: with
 * NO migrations applied at all, `/api/health` still answers
 * `{"ok":true,...,"db":"ok"}` with the correct AID and a 200, because its DB probe
 * is `SELECT 1` — which needs no schema. So check 7 is fully green against a
 * completely unmigrated database, and drizzle-kit's exit code was the only thing
 * standing between this harness and the "harness that lies" its own comments warn
 * about. Any exit-0 no-op — a drizzle-kit behaviour change, a journal pointing
 * somewhere empty, a DATABASE_URL resolved differently than intended — would print
 * "migrations applied" and sail through.
 *
 * Queried through `docker exec` on the Postgres container so this needs no psql on
 * the host.
 */
async function assertSchemaMigrated(pgName) {
  let expected;
  try {
    expected = JSON.parse(
      readFileSync(path.join(ROOT, 'drizzle', 'meta', '_journal.json'), 'utf8'),
    ).entries.length;
  } catch (err) {
    fail(`could not read drizzle/meta/_journal.json to learn the migration count: ${err.message}`);
  }
  if (!expected) {
    fail('drizzle/meta/_journal.json lists no migrations, so there is nothing to verify');
  }
  // Keep stderr: without it a psql that could not run at all (binary missing, exec
  // denied, container restarting) yields empty stdout, Number('') is 0, and the
  // failure below blames the migration for what is really a broken query. Fails
  // closed either way, but the diagnosis has to name the right thing.
  const problems = [];
  const q = async (sql) => {
    const { stdout, stderr } = await docker(
      ['exec', pgName, 'psql', '-U', PG_USER, '-d', PG_DB, '-tAc', sql],
      { timeoutMs: 60_000, allowFail: true },
    );
    if (stderr.trim()) problems.push(stderr.trim());
    return stdout.trim();
  };
  const why = () =>
    problems.length ? `\npsql also reported:\n  ${[...new Set(problems)].join('\n  ')}` : '';
  const tables = Number(
    await q("select count(*) from information_schema.tables where table_schema = 'public'"),
  );
  const applied = Number(await q('select count(*) from drizzle.__drizzle_migrations'));
  // Lead with the query failure when there was one. Otherwise this reports "the
  // schema holds 0 tables" — a count that was never actually measured, because
  // Number('') is 0 — and buries the real cause below the fold.
  if (problems.length) {
    fail(
      'could not read the schema back to confirm the migrations applied, so whether ' +
        'they did is unknown. psql reported:\n  ' +
        [...new Set(problems)].join('\n  '),
    );
  }
  if (!Number.isInteger(tables) || tables === 0) {
    fail(
      `migrations reported success but the public schema holds ${JSON.stringify(tables)} ` +
        'tables. Nothing downstream would notice: /api/health probes the database with ' +
        'SELECT 1, so it answers db:"ok" against an empty database.',
    );
  }
  // Compare against the EXPECTED count, not against zero. "At least one migration
  // ran" is a weaker claim than the spec asks for — it says never to proceed
  // against a half-migrated schema — and a partial apply that exits 0 (a truncated
  // journal, a future drizzle-kit that stops early) would satisfy a non-zero check
  // and print a number nobody compares. The expected count is free: it is the
  // journal this repo commits.
  if (applied !== expected) {
    fail(
      `drizzle.__drizzle_migrations holds ${JSON.stringify(applied)} row(s) but ` +
        `drizzle/meta/_journal.json lists ${expected} migration(s). The schema is ` +
        'partially applied, which the plan explicitly says never to run checks against — ' +
        'a half-migrated database produces failures that look like application bugs.' +
        why(),
    );
  }
  console.log(`schema verified: ${tables} tables, ${applied}/${expected} migrations applied`);
}

/**
 * Run the image under test against the substrate and wait until it answers.
 *
 * `label` distinguishes several app containers in one run; `extraEnv` is how a
 * later check varies one variable while holding the rest fixed.
 */
async function startApp(net, pgName, platform, label, extraEnv = {}) {
  const name = nameFor(label);
  containers.add(name);
  const env = {
    DATABASE_URL: `postgres://${PG_USER}:${PG_PASS}@${pgName}:5432/${PG_DB}`,
    CORS_ORIGIN: RUNTIME_ORIGIN,
    API_KEYS: API_KEY,
    CP_AID_SEED_HEX: SEED_HEX,
    ENROLLMENT_SECRET,
    // Explicit and generous: a future change to the defaults in src/lib/config.ts
    // must not be able to make these checks flaky through rate limiting.
    RATE_LIMIT_PUBLIC_PER_IP_MIN: '10000',
    RATE_LIMIT_API_KEY_PER_MIN: '10000',
    RATE_LIMIT_ENROLLMENT_PER_IP_MIN: '10000',
    ...extraEnv,
  };
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  await docker(
    [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      net,
      '--platform',
      platform,
      // Ephemeral and loopback-bound: a fixed 4000 would collide with a local
      // `npm run dev`.
      '-p',
      '127.0.0.1:0:4000',
      ...envArgs,
      ...labelArgs(),
      opts.tag,
    ],
    { timeoutMs: 180_000 },
  );

  const { stdout: portOut } = await docker(['port', name, '4000/tcp'], { timeoutMs: 20_000 });
  const hostPort = portOut.trim().split('\n')[0]?.split(':').pop();
  if (!hostPort) {
    fail(`could not read the app's published host port from \`docker port\`: ${JSON.stringify(portOut)}`);
  }
  const base = `http://127.0.0.1:${hostPort}`;

  const started = Date.now();
  for (;;) {
    // Poll liveness ALONGSIDE the HTTP probe. A container that dies from a
    // native-module failure is then reported in about a second with its logs,
    // instead of as a four-minute timeout with no explanation.
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
    // Neither `true` nor `false` means `docker inspect` could not answer — the
    // container was removed out of band, or the daemon is unwell. Without this the
    // loop would spin out the full readiness deadline and then blame a slow boot.
    if (state !== 'true') {
      fail(
        `\`docker inspect\` reported the app container's running state as ` +
          `${JSON.stringify(state)}, which is neither "true" nor "false" — the container ` +
          'has probably been removed from under this run, or the daemon is failing to ' +
          'answer. Not waiting out the readiness deadline for that.',
      );
    }
    try {
      // BREAK ON ANY HTTP RESPONSE — never on `res.ok`, never on a 200.
      // src/app/api/health/route.ts answers 503 whenever the DB ping fails, so a
      // status-gated loop would spin out the whole deadline on exactly the
      // misconfiguration this substrate exists to report, and the `db: "ok"`
      // assertion would be unreachable by construction. Readiness means "the
      // server answered"; what it answered is a separate, later check.
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
      break;
    } catch {
      if (Date.now() - started > APP_READY_MS) {
        fail(
          `the app never answered on ${base} within ${Math.round(APP_READY_MS / 1000)}s. ` +
            `Its logs:\n${await containerLogs(name)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(
    `app "${label}" answered in ${((Date.now() - started) / 1000).toFixed(1)}s (${base})`,
  );
  return { name, base };
}

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

// ── prune ───────────────────────────────────────────────────────────────────
/**
 * Sweep resources left by an EARLIER run.
 *
 * Only resources carrying this harness's label, and never THIS run's own —
 * Docker's `--filter label=` has no negation, so the run id is excluded
 * host-side. Note what that does NOT protect: every OTHER run's resources are
 * removed, live or not. `--prune` is for orphans left by a crash; running it
 * while another verify:image run is in flight will break that run.
 */
async function prune() {
  let removed = 0;
  const { stdout: cs } = await docker(
    [
      'ps',
      '-a',
      '--filter',
      `label=${LABEL}=1`,
      '--format',
      `{{.Names}}\t{{.Label "${RUN_LABEL}"}}`,
    ],
    { allowFail: true },
  );
  for (const line of cs.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [name, runId] = line.split('\t');
    if (runId === RUN_ID) continue;
    await docker(['rm', '-f', '-v', name], { allowFail: true, timeoutMs: 30_000 });
    console.log(`  pruned container ${name} (run ${runId || 'unlabelled'})`);
    removed++;
  }
  const { stdout: ns } = await docker(
    ['network', 'ls', '--filter', `label=${LABEL}=1`, '--format', '{{.Name}}'],
    { allowFail: true },
  );
  for (const name of ns.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (name.includes(RUN_ID)) continue;
    await docker(['network', 'rm', name], { allowFail: true, timeoutMs: 20_000 });
    console.log(`  pruned network ${name}`);
    removed++;
  }
  console.log(removed ? `\npruned ${removed} resource(s)` : '\nnothing to prune');
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const serverVersion = await assertDockerAvailable();

  if (opts.prune) {
    console.log(`docker ${serverVersion} — pruning orphans labelled ${LABEL}=1`);
    console.log(
      '  (this removes resources from EVERY other run of this harness, so do not ' +
        'run it while another verify:image run is in flight — it is for orphans ' +
        'left by a crashed run.)',
    );
    await prune();
    return;
  }

  if (opts.platform && opts.platform.includes(',')) {
    fail(
      `--platform ${opts.platform} names more than one platform. \`docker buildx ` +
        'build --load\` cannot load a multi-platform manifest into the daemon, so ' +
        'this harness takes ONE platform per invocation. Run it twice.',
    );
  }
  if (opts.platform && !/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/.test(opts.platform)) {
    fail(
      `--platform ${opts.platform} is not an <os>/<arch> pair (e.g. linux/amd64). ` +
        'A bare arch would otherwise produce a confusing "no known NAPI arch token" ' +
        'failure several steps later.',
    );
  }
  const host = await hostPlatform();
  const platform = opts.platform ?? host;
  const emulated = platformArch(platform) !== platformArch(host);

  console.log(`docker ${serverVersion}`);
  console.log(`run id ${RUN_ID} · platform ${platform} · host ${host} · tag ${opts.tag}`);
  if (emulated) {
    console.log(
      `NOTE: ${platform} is emulated on a ${host} host (QEMU). Everything is slow, ` +
        'and `docker run` prints a platform-mismatch WARNING on stderr that is not ' +
        'a failure.',
    );
  }

  if (opts.build) {
    await buildImage(platform, opts.tag, emulated);
  } else {
    console.log('--no-build: reusing the existing local tag');
  }
  // The build has its own timeout above; the ceiling below covers the checks, so
  // "the build hung" and "a check hung" are distinguishable.
  armWatchdog(WATCHDOG_MS);
  await assertImageMatchesPlatform(opts.tag, platform);

  // ── gather the artifact facts ─────────────────────────────────────────────
  const napi = await probe(opts.tag, platform, 'napi', PROBE_NAPI);
  const otel = await probe(opts.tag, platform, 'otel', PROBE_OTEL);
  const sweep = await probe(opts.tag, platform, 'sweep', PROBE_SWEEP);
  const native = await probe(opts.tag, platform, 'native', PROBE_NATIVE);
  const middleware = await probe(opts.tag, platform, 'middleware', PROBE_MIDDLEWARE);

  // These two run BEFORE any check, so they must tolerate a failed probe without
  // throwing — the whole point of the named-check machinery is that a probe
  // failure becomes checks 3/5/6 reporting it, not an abort that also skips the
  // --update-baseline gate. A failed probe is a Proxy that throws on any access
  // but `__error`, so ask that first rather than relying on `?? []`.
  const probeList = (result, prop) => (result?.__error ? [] : (result[prop] ?? []));
  const tracedExternals = [
    ...new Set(probeList(sweep, 'leaves').map((l) => stripHash(l.spec))),
  ].sort();
  const nativeModules = [
    ...new Set(probeList(native, 'files').map(normaliseNativePath)),
  ].sort();
  // The gate's matcher set and the built-route count are pinned rather than
  // recomputed, because every satisfaction-test of the matcher has been defeated by
  // a one-line edit. See check 11.
  const middlewareMatchers = probeList(middleware, 'matchers')
    .map((m) => m.originalSource ?? '(no originalSource)')
    .sort();
  const apiRouteCount = probeList(middleware, 'routes').length;

  // ── structural checks ────────────────────────────────────────────────────
  //
  // These run BEFORE the --update-baseline branch, and --update-baseline refuses
  // to write if any of them failed. Otherwise regenerating the baseline could
  // BLESS a broken image: `--update-baseline` would happily record the names of
  // dangling symlinks, or of an aitp binary built for the wrong architecture —
  // exactly the states checks 3 and 4 exist to catch. A baseline is only
  // meaningful if the artifact it was taken from was structurally sound.
  await runCheck(1, 'the NAPI binary loads under the image arch and libc', async () => {
    requireProbe(napi, 'napi');
    if (napi.aitpAgent !== 'function') {
      fail(
        `typeof require('aitp').AitpAgent is ${JSON.stringify(napi.aitpAgent)}, expected ` +
          '"function" — the native module did not load in the image',
      );
    }
    return `typeof require('aitp').AitpAgent === 'function'`;
  });

  await runCheck(2, 'the OpenTelemetry SDK was traced into the image', async () => {
    requireProbe(otel, 'otel');
    if (otel.scopeError) {
      fail(
        `${TRACED_DIR}/@opentelemetry is not readable: ${otel.scopeError}\n` +
          'The OpenTelemetry tree was not traced into the standalone output. Note that ' +
          '`require("@opentelemetry/sdk-node")` may still succeed from /app/node_modules ' +
          '— being INSTALLED is not being TRACED, and only the traced copy is what the ' +
          'server chunks load.',
      );
    }
    if (!otel.entry) {
      fail(
        `${TRACED_DIR}/@opentelemetry exists but holds no sdk-node entry. Present ` +
          `(hashes stripped): ${JSON.stringify(otel.stripped)}`,
      );
    }
    if (otel.tracedError) {
      fail(
        `${TRACED_DIR}/@opentelemetry/${otel.entry} does not resolve: ${otel.tracedError}\n` +
          'The traced entry is present but broken — a dangling symlink, or a hashed COPY ' +
          'that lost its dependencies.',
      );
    }
    return (
      `${otel.stripped.length} traced @opentelemetry entries ` +
      `(${otel.stripped.join(', ')}); ${otel.entry} -> ${otel.tracedRealpath}`
    );
  });

  await runCheck(
    3,
    // "present": this check ranges over the leaves that ARE there and says
    // nothing about ones that should be — an image missing an entire traced
    // scope satisfies it vacuously. Completeness is check 5's job, against the
    // baseline. The title says so rather than implying a guarantee it does not
    // give.
    'every traced external present is a symlink into /app/node_modules and resolves',
    async () => {
      requireProbe(sweep, 'sweep');
      if (!sweep.exists) fail(`${TRACED_DIR} does not exist in the image`);
      if (!sweep.resolveFromExists) {
        fail(
          `${RESOLVE_FROM} does not exist in the image. Resolution is probed FROM the ` +
            'server chunks because they are what require the hashed specifiers; if that ' +
            'directory is gone the image is not the standalone output we think it is. ' +
            '(require.resolve walks up and would have succeeded anyway, which is why ' +
            'this is asserted separately.)',
        );
      }
      if (sweep.error) fail(`walking ${TRACED_DIR} failed: ${sweep.error}`);
      if (sweep.anomalies?.length) {
        fail(
          'unexpected non-symlink leaves (a hashed COPY instead of a symlink loses the ' +
            'sibling native binary — vercel/next.js#88844):\n' +
            sweep.anomalies.map((a) => `  ${a.spec} (${a.kind})`).join('\n'),
        );
      }
      if (!sweep.leaves?.length) fail(`${TRACED_DIR} contains no traced externals at all`);
      const broken = sweep.leaves.filter((l) => l.error);
      if (broken.length) {
        fail(
          'traced specifiers that do not resolve from the server chunks:\n' +
            broken.map((l) => `  ${l.spec}: ${l.error}`).join('\n'),
        );
      }
      const outside = sweep.leaves.filter((l) => !l.realpath?.startsWith(`${REAL_MODULES}/`));
      if (outside.length) {
        fail(
          `traced specifiers whose realpath is not under ${REAL_MODULES}:\n` +
            outside.map((l) => `  ${l.spec} -> ${l.realpath}`).join('\n'),
        );
      }
      // ...and it must point at the RIGHT package. "Somewhere under
      // /app/node_modules" is not enough: `aitp-<hash> -> node_modules/pg`
      // satisfies every assertion above while handing the server the wrong
      // module, and `aitp` is the one whose wrong answer ships a missing native
      // binary.
      const mispointed = sweep.leaves.filter(
        (l) => l.realpath !== `${REAL_MODULES}/${stripHash(l.spec)}`,
      );
      if (mispointed.length) {
        fail(
          'traced specifiers whose symlink does not point at the package of the same ' +
            'name:\n' +
            mispointed
              .map(
                (l) =>
                  `  ${l.spec} -> ${l.realpath} (expected ${REAL_MODULES}/${stripHash(l.spec)})`,
              )
              .join('\n'),
        );
      }
      return sweep.leaves.map((l) => `${l.spec} -> ${l.realpath}`).join('\n');
    },
  );

  await runCheck(
    4,
    'the aitp native binary carries the arch token this platform asked for',
    async () => {
      requireProbe(native, 'native');
      if (native.error) fail(`inventorying ${APP_DIR} failed: ${native.error}`);
      const arch = platformArch(platform);
      const napiArch = NAPI_ARCH[arch];
      if (!napiArch) fail(`no known NAPI arch token for platform arch \`${arch}\``);
      const token = `linux-${napiArch}-gnu`;
      const aitpBinaries = (native.files ?? []).filter((p) => /(^|\/)aitp[-.]/.test(p));
      if (!aitpBinaries.length) {
        fail(
          `no aitp .node found in the image at all. Observed: ${
            (native.files ?? []).join(', ') || '(none)'
          }`,
        );
      }
      const wrongArch = aitpBinaries.filter((p) => !p.includes(token));
      if (wrongArch.length) {
        fail(
          `the image was built for ${platform} but its aitp binary does not carry ` +
            `\`${token}\`:\n${wrongArch.map((p) => `  ${p}`).join('\n')}\n` +
            'An image shipping the wrong arch binary (or none) is the #54-class failure ' +
            'this check exists for.',
        );
      }
      return aitpBinaries.join('\n');
    },
  );

  const structuralFailures = results.filter((r) => !r.ok).length;

  if (opts.updateBaseline) {
    if (structuralFailures) {
      fail(
        `refusing to write a baseline: ${structuralFailures} structural check(s) failed ` +
          'above, so this image is not sound enough to be a reference. Writing anyway ' +
          'would bless the defect — the next run would compare a broken image against a ' +
          'baseline taken FROM a broken image and report green. Fix the image first.',
      );
    }
    // The structural gate above is necessary but NOT sufficient, and the hole is
    // demonstrable: an image with the whole `.next/node_modules/@opentelemetry`
    // scope deleted passes checks 1-4 (check 2 used to be vacuous; check 3 only
    // ranges over leaves that are present), so `--update-baseline` would quietly
    // record a SHRUNKEN traced set and bless the regression. Checks 5-6 cannot be
    // part of the gate — a legitimate set change is exactly when you regenerate,
    // and gating on them would make the flag unusable for its actual purpose.
    //
    // So the gate on REMOVALS is explicit consent instead. Additions are printed
    // and allowed: a new external appearing is the benign direction. Entries
    // DISAPPEARING is the direction that turns a regression into a new normal.
    const prev = existsSync(BASELINE_PATH)
      ? (() => {
          try {
            return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
          } catch {
            return null;
          }
        })()
      : null;

    if (prev) {
      const diff = (before, after) => ({
        added: after.filter((x) => !before.includes(x)),
        removed: before.filter((x) => !after.includes(x)),
      });
      const t = diff(prev.tracedExternals ?? [], tracedExternals);
      const n = diff(prev.nativeModules ?? [], nativeModules);
      const mw = diff(prev.middlewareMatchers ?? [], middlewareMatchers);
      const show = (title, d) => {
        if (!d.added.length && !d.removed.length) {
          console.log(`  ${title}: unchanged`);
          return;
        }
        console.log(`  ${title}:`);
        for (const s of d.removed) console.log(`    - ${s}`);
        for (const s of d.added) console.log(`    + ${s}`);
      };
      console.log('\nbaseline diff (existing -> this image):');
      show('tracedExternals', t);
      show('nativeModules', n);
      show('middlewareMatchers', mw);
      if (prev.apiRouteCount !== apiRouteCount) {
        console.log(`  apiRouteCount: ${prev.apiRouteCount} -> ${apiRouteCount}`);
      } else {
        console.log('  apiRouteCount: unchanged');
      }

      const removed = [
        ...t.removed.map((s) => `tracedExternals: ${s}`),
        ...n.removed.map((s) => `nativeModules: ${s}`),
        // A matcher disappearing means the gate stopped covering routes. That is the
        // most consequential removal this baseline can record, so it needs the same
        // explicit consent as the others.
        ...mw.removed.map((s) => `middlewareMatchers: ${s}`),
      ];
      if (removed.length && !opts.allowRemovals) {
        fail(
          `refusing to write a baseline: ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} ` +
            'would be REMOVED:\n' +
            removed.map((s) => `  - ${s}`).join('\n') +
            '\n\nSomething that used to ship no longer does. That is the shape of the ' +
            'regression this baseline exists to catch, and recording it would make the ' +
            'regression the new normal — silently, because every later run would then ' +
            'agree with the shrunken set. The structural checks above cannot see this: ' +
            'an image missing an entire traced scope still passes them.\n' +
            'If the removal is intended, re-run with --allow-removals.',
        );
      }
    }

    const baseline = {
      _comment:
        'Normalised inventory of the shipped standalone image, derived from a BUILT ' +
        'IMAGE (never from next.config.ts). `tracedExternals` is the set of ' +
        '.next/node_modules leaves with the 16-hex Turbopack suffix stripped — it is ' +
        'NOT serverExternalPackages: pg and pino are traced without being listed, and ' +
        '@grpc/grpc-js is listed without ever being traced. `nativeModules` is every ' +
        '.node under /app with the arch token replaced by <ARCH> and a trailing ' +
        '-<semver> dropped, so one baseline serves linux/amd64 and linux/arm64. ' +
        '`middlewareMatchers` is the request gate\'s matcher set and `apiRouteCount` the ' +
        'number of built /api/* routes; both are PINNED rather than recomputed, because ' +
        'every attempt to verify the matcher by testing what it satisfies was defeated ' +
        'by a one-line edit (see check 11). ' +
        'Review every line by hand: a new entry means a new external or a new native ' +
        'binary shipped, a missing entry means one stopped shipping, and any change to ' +
        'middlewareMatchers or apiRouteCount is a security review — the first changes ' +
        'what the gate covers, the second means a route appeared or vanished.',
      _regenerate: 'node scripts/verify-image.mjs --update-baseline',
      tracedExternals,
      nativeModules,
      middlewareMatchers,
      apiRouteCount,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`\nbaseline written: ${BASELINE_PATH}`);
    console.log(`  tracedExternals (${tracedExternals.length}):`);
    for (const s of tracedExternals) console.log(`    ${s}`);
    console.log(`  nativeModules (${nativeModules.length}):`);
    for (const s of nativeModules) console.log(`    ${s}`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    fail(`no baseline at ${BASELINE_PATH} — generate it with --update-baseline`);
  }
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    fail(`could not read ${BASELINE_PATH}: ${err.message}`);
  }


  await runCheck(5, 'the traced external set matches the committed baseline', async () => {
    requireProbe(sweep, 'sweep');
    const want = [...(baseline.tracedExternals ?? [])].sort();
    const diffs = [];
    for (const spec of new Set([...want, ...tracedExternals])) {
      const inBaseline = want.includes(spec);
      const inImage = tracedExternals.includes(spec);
      if (inBaseline && !inImage) diffs.push(`  MISSING from the image: ${spec}`);
      if (!inBaseline && inImage) diffs.push(`  NEW in the image:       ${spec}`);
    }
    if (diffs.length) {
      fail(
        'the traced-externals set drifted from scripts/image-artifact-baseline.json:\n' +
          diffs.join('\n') +
          '\n\nA MISSING entry means a package stopped being traced — most likely it was ' +
          'dropped from serverExternalPackages in next.config.ts. Measured: dropping one ' +
          'of the `@opentelemetry/*` entries lands here, as MISSING; dropping `aitp` never ' +
          'reaches this check at all, because Turbopack cannot bundle the native module ' +
          'and `next build` fails outright inside the image build. Both are caught, at ' +
          'different steps. If the change is intended, review every line above, then ' +
          'regenerate with `node scripts/verify-image.mjs --update-baseline`.',
      );
    }
    return `${tracedExternals.length} traced externals: ${tracedExternals.join(', ')}`;
  });

  await runCheck(6, 'the native-module inventory matches the committed baseline', async () => {
    requireProbe(native, 'native');
    if (native.error) fail(`inventorying ${APP_DIR} failed: ${native.error}`);
    // Normalisation replaces the arch token, so two binaries for DIFFERENT arches
    // collapse to one entry and the diff below would not notice. That is
    // reachable: next.config.ts force-includes BOTH Linux globs, so an image that
    // somehow shipped x64 *and* arm64 would look identical to a correct one.
    // Catch the collapse itself rather than trusting it cannot happen.
    const collapsed = new Map();
    for (const raw of native.files ?? []) {
      const key = normaliseNativePath(raw);
      if (!collapsed.has(key)) collapsed.set(key, []);
      collapsed.get(key).push(raw);
    }
    const multi = [...collapsed.entries()].filter(([, raws]) => raws.length > 1);
    if (multi.length) {
      fail(
        'two or more distinct native binaries normalise to the same inventory entry, ' +
          'so the baseline diff below cannot see the difference — most likely the image ' +
          'ships more than one architecture:\n' +
          multi.map(([k, raws]) => `  ${k}\n${raws.map((r) => `    <- ${r}`).join('\n')}`).join('\n'),
      );
    }
    const want = [...(baseline.nativeModules ?? [])].sort();
    const diffs = [];
    for (const p of new Set([...want, ...nativeModules])) {
      const inBaseline = want.includes(p);
      const inImage = nativeModules.includes(p);
      if (inBaseline && !inImage) diffs.push(`  MISSING from the image: ${p}`);
      if (!inBaseline && inImage) diffs.push(`  NEW in the image:       ${p}`);
    }
    if (diffs.length) {
      fail(
        'the native-module inventory drifted from scripts/image-artifact-baseline.json:\n' +
          diffs.join('\n') +
          '\n\nPaths are normalised (<ARCH> for the arch token, trailing -<semver> ' +
          'dropped) so one baseline serves both arches and a sharp bump is absorbed. A ' +
          'genuinely new or missing binary is a review point, not noise. Regenerate with ' +
          '`node scripts/verify-image.mjs --update-baseline` once reviewed.\n' +
          `observed (raw): ${(native.files ?? []).join(', ')}`,
      );
    }
    return `${nativeModules.length} native module(s): ${nativeModules.join(', ')}`;
  });

  // ── live substrate ───────────────────────────────────────────────────────
  //
  // Deliberately AFTER the --update-baseline branch returns: regenerating the
  // baseline is a static operation and must not pay for a Postgres boot and a
  // migration run.
  //
  // Not gated on the structural checks above, on purpose. If the native binary is
  // missing the app container dies, and the readiness loop reports that in about
  // a second with the container's own logs — which is a better diagnosis than
  // skipping the live half and saying nothing about it.
  console.log('\nstanding up the live substrate');
  const net = await createNetwork();
  const pg = await startPostgres(net);
  await migrate(pg.hostPort);
  await assertSchemaMigrated(pg.name);
  const app = await startApp(net, pg.name, platform, 'app');

  // Testability hook, same rationale as the two timeout hooks. The whole run
  // takes about five seconds locally, so the window in which a network, a
  // Postgres and an app container are ALL live is well under a second — too
  // narrow to aim a signal at reliably. Teardown across every exit path is the
  // property this harness most needs to keep (an earlier revision leaked twelve
  // containers here), and a property that cannot be tested on demand is one that
  // rots. Set AITP_VERIFY_IMAGE_PAUSE_MS to hold the substrate up and Ctrl-C into
  // it. Unset in normal runs, including CI.
  const pauseMs = Number(process.env.AITP_VERIFY_IMAGE_PAUSE_MS) || 0;
  if (pauseMs) {
    console.log(
      `AITP_VERIFY_IMAGE_PAUSE_MS=${pauseMs}: holding 1 network and 2 containers up. ` +
        'Ctrl-C now to exercise teardown.',
    );
    await new Promise((r) => setTimeout(r, pauseMs));
  }

  const expectedAid = deriveAid(SEED_HEX);

  await runCheck(7, '/api/health reports db ok and the seed-derived AID', async () => {
    const r = await httpReq(app.base, '/api/health');
    // ORDER MATTERS. `db` is asserted BEFORE the status, because route.ts answers
    // 503 whenever the DB ping fails: a status-first assertion reports "status
    // 503" for an unreachable database, which is the symptom rather than the
    // cause, and buries the actual finding in a JSON blob. Checking `db` first
    // means the most specific available message is the one that fires. All three
    // properties are still asserted.
    if (r.body?.db !== 'ok') {
      fail(
        `db is ${JSON.stringify(r.body?.db)}, expected "ok" — the container cannot reach ` +
          `Postgres at ${pg.name}:5432 (HTTP status was ${r.status}; route.ts answers 503 ` +
          `when the DB ping fails). The app's logs:\n${await containerLogs(app.name)}`,
      );
    }
    if (r.body?.aid !== expectedAid) {
      fail(
        'the served AID is not the one CP_AID_SEED_HEX derives to:\n' +
          `  expected (host, node:crypto): ${expectedAid}\n` +
          `  served   (image, aitp SDK):   ${r.body?.aid}`,
      );
    }
    // Reached only when the DB is healthy and the AID is right, so a non-200 here
    // is a genuinely different problem and deserves its own message.
    if (r.status !== 200) {
      fail(
        `db and aid are both correct but the status is ${r.status}, not 200 ` +
          `(body: ${JSON.stringify(r.body)})`,
      );
    }
    // Print expectedAid, not r.body.aid: they are asserted equal just above, but the
    // label says "derived on the host", so the host's value is the honest one to show.
    return `db=ok  aid=${expectedAid}\n(derived independently on the host from CP_AID_SEED_HEX)`;
  });

  // ── gate attachment in the image (the gap #68 is named for) ──────────────
  //
  // ASSERT THE WIRE CONTRACT, NOT THE STATUS CODE. A 401 without
  // `code: INVALID_API_KEY` is a different failure wearing the right status.
  //
  // `/api/audit` is the right probe: it is absent from PUBLIC_PATHS in src/proxy.ts
  // and matches none of the public GET patterns, so it is genuinely gated. It also
  // exercises a different handler from the one the sibling harness probes, so a
  // shared-fixture mistake cannot make both harnesses agree wrongly.
  //
  // SCOPE LINE. This proves ATTACHMENT in the standalone artifact. It deliberately
  // does NOT re-prove the gate's logic: the rate-limit bucket checks need isolated
  // per-IP buckets via CLIENT_IP_HEADER and are already covered against a running
  // server by scripts/verify-request-gate.mjs. Duplicated assertions rot at
  // different rates. Do not "complete" this by copying that harness's 15 checks.
  await runCheck(8, 'the gate rejects an unauthenticated /api/audit', async () => {
    const r = await httpReq(app.base, '/api/audit');
    // Distinguish this case explicitly: it means API_KEYS never reached the
    // container, so the run was not exercising the auth path at all. Reported as
    // "wrong status" it would send a reader looking at the gate instead of the env.
    if (r.status === 503 && r.body?.code === 'SERVER_MISCONFIGURED') {
      fail(
        'got 503 SERVER_MISCONFIGURED rather than 401 — API_KEYS did not reach the ' +
          'container, so this run never exercised the auth path. Empty API_KEYS under ' +
          'NODE_ENV=production makes the gate fail closed with this code instead of ' +
          'checking the key.',
      );
    }
    if (r.status !== 401) {
      fail(`status ${r.status}, expected 401 (body: ${JSON.stringify(r.body)})`);
    }
    if (r.body?.code !== 'INVALID_API_KEY') {
      fail(
        `body.code is ${JSON.stringify(r.body?.code)}, expected "INVALID_API_KEY". The ` +
          'status alone is not the contract — a 401 from somewhere else wears it too.',
      );
    }
    // The gate injects x-request-id, so its presence is evidence the gate RAN,
    // rather than that some handler happened to answer 401.
    if (!r.headers.get('x-request-id')) {
      fail('no x-request-id on the response, so the gate did not run');
    }
    return `401 INVALID_API_KEY, x-request-id=${r.headers.get('x-request-id')}`;
  });

  await runCheck(9, 'a valid API key reaches the handler', async () => {
    // The non-vacuity half. Without it, a gate that rejected EVERYTHING
    // unconditionally — or an image serving a stub that always 401s — would satisfy
    // check 8 completely.
    const r = await httpReq(app.base, '/api/audit', { key: API_KEY });
    if (r.status === 401 || r.status === 503) {
      fail(
        `status ${r.status} WITH a valid key — the handler was not reached, so check 8's ` +
          'rejection proves nothing about the key actually being checked.',
      );
    }
    if (r.status === 500) {
      fail(
        'status 500 with a valid key. The gate let the request through but the handler ' +
          'failed — against this substrate that almost always means the migrations did ' +
          'not apply, so admin_audit_log does not exist.',
      );
    }
    if (r.status !== 200) fail(`status ${r.status} (body: ${JSON.stringify(r.body)})`);
    if (!r.headers.get('x-request-id')) {
      fail('no x-request-id on the authenticated response');
    }
    return `200 with a valid key, x-request-id present`;
  });

  await runCheck(10, 'the gate answers the CORS preflight itself', async () => {
    // NOTE, and do not "simplify" this away: the 204 and the empty body are NOT
    // attributable to the gate. Next answers OPTIONS 204/empty by itself — measured
    // on a gate-less image, where this check failed ONLY on the missing header. The
    // x-request-id assertion is the entire load-bearing part; the status and body
    // assertions are there to catch a handler answering the preflight instead.
    const r = await httpReq(app.base, '/api/audit', { method: 'OPTIONS' });
    if (r.status !== 204) fail(`status ${r.status}, expected 204`);
    if (r.text !== '') {
      fail(`expected an empty body, got ${JSON.stringify(r.text.slice(0, 200))}`);
    }
    if (!r.headers.get('x-request-id')) fail('no x-request-id on the preflight response');
    return '204, empty body, x-request-id present';
  });

  await runCheck(11, 'the middleware matcher set is exactly the pinned one', async () => {
    // WHY THIS IS PINNED AND NOT COMPUTED.
    //
    // Two earlier versions of this check tested whether the matcher SATISFIED a set
    // of paths — first by probing over HTTP, then by testing the built route list
    // against the matcher regexp. Both were defeated by one-line matcher edits,
    // because satisfaction-testing always samples:
    //
    //   ['/api/audit']                       defeated the 1-path HTTP probe
    //   ['/api/audit','/api/webhooks','/api/health']  defeated the 3-path probe
    //   ['/api/:path([^0-9]+)']              defeated route-list testing — the
    //       probe substitutes a literal 'a' for each [param], and 'a' has no digit,
    //       so all 30 routes "matched" while every real id (digits, uuids) did not.
    //       Anonymous POST /api/webhooks/1/circuit-breaker/reset returned 200.
    //   [{source:'/api/:path*', missing:[{type:'header',key:'cookie'}]}]
    //       defeated it again with the source UNCHANGED: Next enforces `missing` at
    //       runtime, so every request carrying a cookie skipped the gate, and
    //       GET /api/audit with a cookie returned the admin audit log.
    //
    // A sampled predicate can always be satisfied by something narrower than it
    // looks. So this asserts the matcher set ITSELF against a committed value —
    // rule 2 of this file's contract — and rejects ANY key beyond the two we have
    // reasoned about, because the second break above lived entirely in an extra
    // key. That makes unknown future matcher options fail closed instead of
    // silently widening what the gate lets past.
    requireProbe(middleware, 'middleware');
    if (middleware.error) {
      fail(`could not read the middleware config out of the image: ${middleware.error}`);
    }
    const expected = baseline.middlewareMatchers;
    if (!Array.isArray(expected) || !expected.length) {
      fail(
        'scripts/image-artifact-baseline.json has no `middlewareMatchers`. That is the ' +
          'pinned expectation this check compares against; without it the check would be ' +
          'vacuous. Regenerate the baseline.',
      );
    }
    const got = middleware.matchers ?? [];
    if (!got.length) {
      fail(
        'the image records NO middleware matchers, so the gate is attached to nothing ' +
          'and every /api/* route is served with no auth, no rate limiting and no CORS.',
      );
    }
    // Only these two keys have been reasoned about. `has`, `missing`, `locale`,
    // `regexp`-adjacent additions and anything Next adds later all land here.
    const ALLOWED = new Set(['regexp', 'originalSource']);
    const offenders = got.flatMap((m) =>
      Object.keys(m)
        .filter((k) => !ALLOWED.has(k))
        .map((k) => `  matcher ${JSON.stringify(m.originalSource ?? '?')} carries \`${k}\`: ${JSON.stringify(m[k])}`),
    );
    if (offenders.length) {
      fail(
        'a middleware matcher carries a condition this harness has not reasoned about:\n' +
          offenders.join('\n') +
          '\n\nNext enforces `has`/`missing` at RUNTIME while leaving the source unchanged, ' +
          'so such a matcher looks correct in every other check while letting requests ' +
          'past the gate. Measured: `missing: [{type:"header",key:"cookie"}]` lets any ' +
          'request with a cookie — i.e. any browser request — read /api/audit ' +
          'anonymously. If the condition is intended, reason about it here and add the ' +
          'key to ALLOWED deliberately.',
      );
    }
    const gotSources = got.map((m) => m.originalSource ?? '(no originalSource)').sort();
    const wantSources = [...expected].sort();
    if (JSON.stringify(gotSources) !== JSON.stringify(wantSources)) {
      fail(
        'the middleware matcher set does not match the pinned one:\n' +
          `  pinned: ${JSON.stringify(wantSources)}\n` +
          `  image:  ${JSON.stringify(gotSources)}\n\n` +
          'Every route the matcher no longer covers is served with no auth, no rate ' +
          'limiting and no CORS. If the change is intended, review it as a security ' +
          'change and then regenerate with --update-baseline.',
      );
    }
    // Defence in depth, and a useful diagnostic: the pinned source should also, in
    // fact, cover every built route. This cannot be the primary assertion (see
    // above) but a disagreement between the two means something unmodelled.
    if (middleware.uncovered?.length) {
      fail(
        `the matcher set matches the pinned value, yet ${middleware.uncovered.length} of ` +
          `${middleware.routes.length} built /api/* routes are not matched by its regexp:\n` +
          middleware.uncovered.map((r) => `  ${r}`).join('\n') +
          '\n\nThat disagreement should be impossible; treat it as the regexp semantics ' +
          'having changed under us rather than as a routing problem.',
      );
    }
    // A route list that under-reports would make the coverage half vacuous — a
    // trimmed manifest passed with 3 routes. Pin the count too.
    const wantCount = baseline.apiRouteCount;
    if (!Number.isInteger(wantCount)) {
      fail('scripts/image-artifact-baseline.json has no integer `apiRouteCount`');
    }
    if (middleware.routes.length !== wantCount) {
      fail(
        `the image reports ${middleware.routes.length} built /api/* routes, but the ` +
          `baseline pins ${wantCount}. A NEW route is a review point — is it gated, or ` +
          'does it belong in PUBLIC_PATHS? A MISSING one means a route stopped building, ' +
          'or the manifest is under-reporting and the coverage check above went vacuous.',
      );
    }
    return (
      `matchers: ${gotSources.join(', ')} (pinned, no unexpected conditions); ` +
      `${middleware.routes.length} built /api/* routes, all covered`
    );
  });

  await runCheck(12, 'the gate really runs on a second gated route and a public one', async () => {
    // The BEHAVIOURAL half, kept alongside check 11's structural one because they
    // fail on different things. Check 11 proves the matcher covers the tree as
    // BUILT; this proves the gate actually executes for more than the one path the
    // earlier checks probe — catching a gate that is matched but inert, which no
    // manifest can show.
    //
    // Two probes, because they fail on different halves of the problem:
    //
    // 1. A SECOND genuinely gated route, under a different top-level segment.
    //    /api/webhooks is gated and is not probed by scripts/verify-request-gate.mjs
    //    (which uses /api/sessions), so the two harnesses stay independent.
    // 2. A PUBLIC route. The gate runs for every /api/* path, injecting
    //    x-request-id even where it does not reject — so a matcher that no longer
    //    covers a path loses the header there. This is the broad signal: it fails
    //    for any narrowing that excludes /api/health, whatever the gated routes do.
    //
    // Still ATTACHMENT, not gate logic: no rate-limit buckets, no per-route policy.
    const gated = await httpReq(app.base, '/api/webhooks');
    if (gated.status !== 401 || gated.body?.code !== 'INVALID_API_KEY') {
      fail(
        `unauthenticated GET /api/webhooks answered ${gated.status} ` +
          `${JSON.stringify(gated.body?.code)}, expected 401 INVALID_API_KEY. ` +
          'If check 8 passed, the gate is attached to some paths and not this one — a ' +
          'narrowed matcher in src/proxy.ts. If check 8 failed too, the gate is not ' +
          'running at all. Either way every /api/* route it does not cover is served ' +
          'with no auth, no rate limiting and no CORS.',
      );
    }
    // Public and rate-limit exempt, so this asserts only that the gate ran.
    const pub = await httpReq(app.base, '/api/health');
    if (!pub.headers.get('x-request-id')) {
      fail(
        'GET /api/health carries no x-request-id. That header is injected by the gate ' +
          'on its pass-through path, so its absence means the gate does not run for ' +
          '/api/health at all — the matcher no longer covers the whole /api/* tree.',
      );
    }
    return (
      '/api/webhooks -> 401 INVALID_API_KEY (a second gated route); ' +
      '/api/health carries x-request-id (the gate runs on public paths too)'
    );
  });

  const failures = results.filter((r) => !r.ok).length;
  if (failures) throw new Error(`${failures}/${results.length} image checks FAILED`);
  console.log(`\nall ${results.length} image checks passed`);
}

// ── lifecycle wiring ────────────────────────────────────────────────────────
//
// Both halves are required. `cleanupSync()` alone would leave the process ALIVE
// on Ctrl-C, because installing a signal listener suppresses Node's default
// disposition — the 18-minute bug wearing a different hat.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(
      `\n${sig} — tearing down ${containers.size} container(s) and ${networks.size} network(s)`,
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
    // Exit explicitly: a lingering handle must not turn a passing run into a
    // silent hang.
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\nharness error: ${err.message}`);
    clearTimeout(watchdog);
    cleanupSync();
    process.exit(1);
  });
