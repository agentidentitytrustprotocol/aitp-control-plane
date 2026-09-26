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
 * Static assertions against a BUILT IMAGE, needing no server and no database:
 * the NAPI binary loads, the OpenTelemetry tree was traced in, every traced
 * external is a symlink that resolves, and the `.node` inventory matches a
 * committed baseline including the arch token. That is the whole of it. The
 * HTTP-level work — booting the image against an ephemeral Postgres and
 * asserting gate attachment, the revocation signing path and the CORS
 * build-freeze — lands in later commits of this series. Nothing below should be
 * read as already proving any of that.
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
 * SCOPE LINE, for when the HTTP checks do land. This harness proves ATTACHMENT
 * AND LOADING IN THE STANDALONE ARTIFACT. It must never re-prove the gate's
 * logic: the rate-limit bucket checks need isolated per-IP buckets via
 * CLIENT_IP_HEADER and are already covered against a running server by the
 * sibling harness.
 *
 * ── THE CONTRACT THIS FILE IS HELD TO ─────────────────────────────────────
 * Rules 1 and 3 bind the HTTP checks that are still to come; they are written
 * here, ahead of the code, because they are the reason those checks will be
 * worth having. Rule 2 is in force now.
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
 *
 * RESOURCE LIFECYCLE — the part a past incident dictates.
 * `verify-request-gate.mjs` records a CI job that passed every check and then
 * hung for 18 minutes because a killed child's stdio pipes stayed open and
 * pinned the event loop. The Docker analogue is a foreground `docker run` or a
 * `docker logs -f`: a long-lived child holding pipes. The design that cannot
 * reproduce it:
 *   - One-shot probe containers — all this file creates today — run to completion
 *     under a per-call timeout and are registered for teardown BEFORE they are
 *     started, so a signal mid-probe still sweeps them even if `--rm` never
 *     fires.
 *   - RULE for the long-lived containers the later commits add: they must start
 *     DETACHED (`docker run -d`), so nothing long-lived is ever a child of this
 *     process, and their logs must be read with ONE-SHOT `docker logs`, never
 *     `-f` — a `docker logs -f` is precisely the long-lived child holding pipes
 *     that caused the incident below.
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
 *     --help
 *
 * Testability hooks: AITP_VERIFY_IMAGE_WATCHDOG_MS overrides the post-build
 * ceiling and AITP_VERIFY_IMAGE_BUILD_MS the build ceiling, so both timeout paths
 * can be exercised deliberately (set one to 1000) without editing this file.
 * There is no test runner wired to a .mjs script in this repo, so a negative path
 * with no hook is not falsifiable from a diff plus output.
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
/** Post-build ceiling. A hang must fail loudly and fast, never burn a CI slot. */
const WATCHDOG_MS = Number(process.env.AITP_VERIFY_IMAGE_WATCHDOG_MS) || 12 * 60_000;
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

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    platform: null,
    tag: 'aitp-control-plane:verify-image',
    build: true,
    keep: false,
    prune: false,
    updateBaseline: false,
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
  --update-baseline      rewrite scripts/image-artifact-baseline.json from the image
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
        reject(new Error(`\`docker ${args.join(' ')}\` timed out after ${timeoutMs}ms`));
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

// ── teardown ────────────────────────────────────────────────────────────────
function killLiveChildren() {
  for (const child of liveChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
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
  if (cs.length) console.log(`  docker rm -f ${cs.join(' ')}`);
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
  for (const c of cs) {
    spawnSync('docker', ['rm', '-f', c], { stdio: 'ignore', timeout: 30_000 });
  }

  // Correctness path: containers FIRST — `network rm` fails while an endpoint is
  // still attached.
  sweepByLabelSync('container', () =>
    dockerSyncLines(['ps', '-aq', '--filter', `label=${RUN_LABEL}=${RUN_ID}`]),
  (ids) => spawnSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore', timeout: 30_000 }));

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
      `\nharness watchdog: exceeded ${human} after the build. Failing rather than ` +
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

const PROBE_OTEL = `
process.stdout.write(JSON.stringify({ resolved: require.resolve('@opentelemetry/sdk-node') }));
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
    return { __error: err.message };
  }
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
    await docker(['rm', '-f', name], { allowFail: true, timeoutMs: 30_000 });
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

  const tracedExternals = [...new Set((sweep.leaves ?? []).map((l) => stripHash(l.spec)))].sort();
  const nativeModules = [...new Set((native.files ?? []).map(normaliseNativePath))].sort();

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
    if (!otel.resolved) fail('require.resolve("@opentelemetry/sdk-node") did not resolve');
    return `@opentelemetry/sdk-node -> ${otel.resolved}`;
  });

  await runCheck(
    3,
    'every traced external is a symlink into /app/node_modules and resolves',
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
    const baseline = {
      _comment:
        'Normalised inventory of the shipped standalone image, derived from a BUILT ' +
        'IMAGE (never from next.config.ts). `tracedExternals` is the set of ' +
        '.next/node_modules leaves with the 16-hex Turbopack suffix stripped — it is ' +
        'NOT serverExternalPackages: pg and pino are traced without being listed, and ' +
        '@grpc/grpc-js is listed without ever being traced. `nativeModules` is every ' +
        '.node under /app with the arch token replaced by <ARCH> and a trailing ' +
        '-<semver> dropped, so one baseline serves linux/amd64 and linux/arm64. ' +
        'Review every line by hand: a new entry means a new external or a new native ' +
        'binary shipped, and a missing entry means one stopped shipping.',
      _regenerate: 'node scripts/verify-image.mjs --update-baseline',
      tracedExternals,
      nativeModules,
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
