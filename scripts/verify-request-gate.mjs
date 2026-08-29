#!/usr/bin/env node
/**
 * Request-gate conformance harness.
 *
 * `src/proxy.ts` (formerly `src/middleware.ts`) is the API-key auth gate, the
 * rate limiter, the CORS layer and the `x-request-id` injector for every
 * `/api/*` request. Nothing else in this repo tests that gate against a
 * RUNNING server — unit tests call the exported function directly, which
 * cannot tell you whether Next actually attached it.
 *
 * This script boots a built server and asserts the whole contract over HTTP.
 *
 * Three design rules make it worth having. Do not relax them:
 *
 *   1. THE RUNTIME ENVIRONMENT DIFFERS FROM THE BUILD ENVIRONMENT.
 *      Build with CORS_ORIGIN=BUILD_SENTINEL, run with RUNTIME_SENTINEL, and
 *      assert the served header equals the runtime value AND differs from the
 *      build value. Asserting mere presence would pass on a build-frozen
 *      artifact, which is the exact failure being guarded against.
 *
 *   2. THE PUBLIC ROUTE SET IS ENUMERATED FROM THE BUILT ARTIFACT, NEVER FROM
 *      THE SOURCE. Re-deriving the expectation by importing `isPublicRequest`
 *      from the code under test is a tautology: it reports green while the gate
 *      is wide open. The baseline is a committed, human-readable snapshot that
 *      a reviewer can audit line by line.
 *
 *   3. ASSERT THE WIRE CONTRACT, NOT THE STATUS CODE. A 401 without
 *      `code: INVALID_API_KEY`, or a 429 without `Retry-After`, is a regression
 *      even though the status is right.
 *
 * Usage:  node scripts/verify-request-gate.mjs [--update-baseline]
 * Requires a prior production build (see `npm run verify:gate`).
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'request-gate-baseline.json');
const UPDATE = process.argv.includes('--update-baseline');
const DO_BUILD = process.argv.includes('--build');

// The build was made with this; the server is run with the other. Any code
// path that freezes CORS_ORIGIN at build time surfaces as the build sentinel
// leaking into a response header.
const BUILD_ORIGIN = 'https://build-frozen.invalid';
const RUNTIME_ORIGIN = 'https://runtime-probe.invalid';

// Two keys so the per-API-key rate-limit burst (check 8) cannot poison the
// bucket used by the plain authenticated check (check 2). The limiter keys on
// token.slice(0, 24), so the first 24 characters must differ.
const KEY_PRIMARY = 'harness-primary-000000000000';
const KEY_BURST = 'harness-ratelimit-1111111111';

const LIMIT_PUBLIC = 3;
const LIMIT_ENROLL = 5;
const LIMIT_APIKEY = 3;

// Rate-limit buckets are keyed on the resolved client IP. Every local request
// would otherwise resolve to the same 'unknown' bucket and the checks would
// poison each other's counters — a real trap, not a hypothetical. Setting a
// trusted client-IP header lets each check family use an isolated bucket, and
// exercises the CLIENT_IP_HEADER path while we are here.
const IP_HEADER = 'x-harness-client-ip';

let ipCounter = 0;
/** A fresh rate-limit bucket, so single-shot checks never interfere. */
const freshIp = () => `10.0.0.${++ipCounter}`;

// ── tiny assertion kit ──────────────────────────────────────────────────────
const results = [];
let currentCheck = null;

function check(id, title, fn) {
  return { id, title, fn };
}

function fail(msg) {
  throw new Error(msg);
}

function eq(actual, expected, what) {
  if (actual !== expected) {
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(cond, what) {
  if (!cond) fail(what);
}

// ── http ────────────────────────────────────────────────────────────────────
async function req(base, pathname, opts = {}) {
  const { method = 'GET', key = null, ip = null, headers = {}, origin = true, timeoutMs = 15_000 } = opts;
  const h = { ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  h[IP_HEADER] = ip ?? freshIp();
  if (origin) h.origin = RUNTIME_ORIGIN;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${pathname}`, { method, headers: h, signal: ac.signal });
    let body = null;
    const text = await res.text();
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

const acao = (r) => r.headers.get('access-control-allow-origin');

// ── build ───────────────────────────────────────────────────────────────────
/**
 * Build with the sentinel CORS_ORIGIN.
 *
 * The harness owns this on purpose. Check 5 only has teeth if the value baked
 * into the artifact differs from the value the server is run with — and if that
 * coupling lived in a CI env var, editing the workflow would silently reduce
 * check 5 to "a header is present", which passes on a build-frozen artifact.
 * Keeping both sentinels in this file makes the invariant local and visible.
 */
async function build() {
  console.log('building with the sentinel CORS_ORIGIN...');
  await new Promise((resolve, reject) => {
    // Invoke the repo's own build script rather than `next build` directly, so
    // this always builds the way the repo builds (Turbopack, the Next 16.x
    // default, since #54 removed the explicit --webpack pin).
    const child = spawn('npm', ['run', 'build'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        CORS_ORIGIN: BUILD_ORIGIN,
        CP_AID_SEED_HEX:
          '0000000000000000000000000000000000000000000000000000000000000001',
        ENROLLMENT_SECRET: 'harness-build-placeholder-min-thirty-two-chars',
        API_KEYS: 'build-placeholder-key',
        DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/aitp_control_plane',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`next build failed:\n${out.join('')}`)),
    );
  });
}

// ── server lifecycle ────────────────────────────────────────────────────────
//
// `npx next start` spawns a GRANDCHILD that inherits the stdio pipes. Killing
// only the direct child leaves those pipes open, so the 'data' listeners keep a
// handle on the event loop and this process never exits — it passed every check
// in CI and then hung for 18 minutes until the job was cancelled. Two fixes,
// both needed: spawn detached so the whole process GROUP can be signalled, and
// exit explicitly rather than trusting the loop to drain.

/** Every server booted this run, so none can be orphaned on any exit path. */
const spawned = new Set();

/** Hard ceiling. A hang must fail loudly and fast, never burn a CI job slot. */
const WATCHDOG_MS = 8 * 60_000;
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function boot(extraEnv = {}) {
  const port = await freePort();
  const child = spawn('npx', ['next', 'start', '--port', String(port)], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      CORS_ORIGIN: RUNTIME_ORIGIN,
      API_KEYS: `${KEY_PRIMARY},${KEY_BURST}`,
      CLIENT_IP_HEADER: IP_HEADER,
      RATE_LIMIT_PUBLIC_PER_IP_MIN: String(LIMIT_PUBLIC),
      RATE_LIMIT_ENROLLMENT_PER_IP_MIN: String(LIMIT_ENROLL),
      RATE_LIMIT_API_KEY_PER_MIN: String(LIMIT_APIKEY),
      CP_AID_SEED_HEX:
        '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      ENROLLMENT_SECRET: 'harness-runtime-secret-min-thirty-two-chars',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  spawned.add(child);
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  const base = `http://127.0.0.1:${port}`;
  // Readiness must poll a RATE-LIMIT-EXEMPT path. Polling a limited path
  // consumes bucket slots and makes the rate-limit checks flaky — verified.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode}):\n${logs.join('')}`);
    }
    try {
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`server not ready in 60s:\n${logs.join('')}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { base, child, logs };
}

function killGroup(child, signal) {
  try {
    // Negative pid signals the whole process group, reaching the `next start`
    // grandchild that `npx` wraps.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

async function shutdown(server) {
  const child = server?.child;
  if (!child) return;
  spawned.delete(child);
  if (child.exitCode === null) {
    killGroup(child, 'SIGTERM');
    await new Promise((r) => {
      const t = setTimeout(() => {
        killGroup(child, 'SIGKILL');
        r();
      }, 5000);
      child.on('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  }
  // The grandchild holds these fds; drop our end so they cannot pin the loop.
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

/** Last-resort sweep, for any path that skipped a `finally`. */
function killAllSpawned() {
  for (const child of spawned) {
    killGroup(child, 'SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  spawned.clear();
}

// ── manifests ───────────────────────────────────────────────────────────────
function readJson(rel) {
  const p = path.join(ROOT, rel);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/**
 * Locate the attached request gate, whichever runtime it compiled for.
 *
 * On the Edge `middleware` convention it lives in middleware-manifest.json.
 * On the Node `proxy` convention it moves to functions-config-manifest.json
 * under `/_middleware`. Reading BOTH is deliberate: it means this harness needs
 * no edit across the migration, and — more importantly — it makes "no gate is
 * attached at all" a loud failure rather than a silent pass. A `proxy.ts` in a
 * location Next does not recognise builds green, emits no warning, and leaves
 * the entire API public. This check is the thing that catches that.
 */
function findGate() {
  const mw = readJson('.next/server/middleware-manifest.json');
  const fns = readJson('.next/server/functions-config-manifest.json');
  if (!mw && !fns) fail('no build manifests found — run `npm run build` first');

  const edge = mw?.middleware?.['/'];
  if (edge) {
    return {
      runtime: 'edge',
      source: 'middleware-manifest.json',
      matchers: edge.matchers.map((m) => ({
        regexp: m.regexp,
        originalSource: m.originalSource,
      })),
    };
  }
  const node = fns?.functions?.['/_middleware'];
  if (node) {
    return {
      runtime: node.runtime ?? 'nodejs',
      source: 'functions-config-manifest.json',
      matchers: (node.matchers ?? []).map((m) => ({
        regexp: m.regexp,
        originalSource: m.originalSource,
      })),
    };
  }
  fail(
    'NO REQUEST GATE IS ATTACHED. Neither middleware-manifest.json nor ' +
      'functions-config-manifest.json declares one. Every /api/* route is ' +
      'unauthenticated and unthrottled. Most likely cause: the proxy file is ' +
      'in a location Next does not recognise (it must be src/proxy.ts, not ' +
      'the repo root).',
  );
}

/** Every API route Next actually built, from the manifest — not from source. */
function builtRoutes() {
  const fns = readJson('.next/server/functions-config-manifest.json');
  if (!fns?.functions) fail('functions-config-manifest.json missing or empty');
  return Object.keys(fns.functions)
    .filter((k) => k !== '/_middleware')
    .sort();
}

/** Fill `[param]` segments so the route is actually reachable. */
function materialize(route) {
  return route.replace(/\[([^\]]+)\]/g, (_, name) =>
    name === 'aid' ? encodeURIComponent('aid:pubkey:harness') : 'harness-probe-id',
  );
}

/**
 * Probe one route with no credentials and classify it, never throwing.
 *
 * A route that hangs must not abort the sweep. Inverting the auth guard makes
 * `/api/events/stream` publicly reachable, and an SSE handler then holds the
 * connection open forever — which previously aborted this check with an opaque
 * error and lost the classification of all 29 other routes, exactly when this
 * check is the primary detector. A timeout is itself a finding: it means the
 * request reached a streaming handler, i.e. it was NOT gated.
 */
async function probe(base, route) {
  try {
    const r = await req(base, materialize(route), { timeoutMs: 5000 });
    return classify(r);
  } catch (err) {
    return err?.name === 'AbortError' || /abort/i.test(err?.message ?? '')
      ? 'reached-streaming-handler'
      : `probe-error:${err?.message ?? 'unknown'}`;
  }
}

/**
 * Classify one unauthenticated probe as gated / gate-misconfigured / public.
 *
 * Classify on the GATE'S OWN SIGNATURE (the `code` in the body), never on the
 * bare status. `/api/health` and `/api/readyz` answer 503 from their own
 * handlers when the database is unreachable; reading that as the gate's
 * SERVER_MISCONFIGURED would mark two genuinely public routes as protected and
 * bake that lie into the baseline. A handler-level 5xx means the request
 * REACHED the handler, which is the definition of public here.
 */
function classify(r) {
  if (r.status === 401 && r.body?.code === 'INVALID_API_KEY') return 'gated';
  if (r.status === 503 && r.body?.code === 'SERVER_MISCONFIGURED') return 'gate-misconfigured';
  return 'public';
}

// ── checks ──────────────────────────────────────────────────────────────────
function buildChecks(base, gate, baseline) {
  return [
    check(1, 'unauthenticated GET on a protected route is rejected', async () => {
      const r = await req(base, '/api/sessions');
      eq(r.status, 401, 'status');
      eq(r.body?.code, 'INVALID_API_KEY', 'body.code');
      ok(r.headers.get('x-request-id'), 'x-request-id header present');
      eq(acao(r), RUNTIME_ORIGIN, 'access-control-allow-origin');
    }),

    check(2, 'a valid API key reaches the handler', async () => {
      const r = await req(base, '/api/sessions', { key: KEY_PRIMARY });
      ok(
        r.status !== 401 && r.status !== 503,
        `expected the handler to be reached, got ${r.status}`,
      );
    }),

    check(3, 'a wrong API key is rejected', async () => {
      const r = await req(base, '/api/sessions', { key: 'not-a-real-key' });
      eq(r.status, 401, 'status');
      eq(r.body?.code, 'INVALID_API_KEY', 'body.code');
    }),

    check(4, 'CORS preflight is answered directly, without auth', async () => {
      const r = await req(base, '/api/sessions', { method: 'OPTIONS' });
      eq(r.status, 204, 'status');
      eq(r.text, '', 'body is empty');
      eq(acao(r), RUNTIME_ORIGIN, 'access-control-allow-origin');
      ok(
        (r.headers.get('access-control-allow-methods') ?? '').includes('PATCH'),
        'allow-methods contains PATCH',
      );
      ok(r.headers.get('x-request-id'), 'x-request-id header present');
    }),

    check(5, 'CORS_ORIGIN is read at RUNTIME, not frozen at build time', async () => {
      const r = await req(base, '/api/health');
      eq(acao(r), RUNTIME_ORIGIN, 'access-control-allow-origin');
      ok(
        acao(r) !== BUILD_ORIGIN,
        `build-time CORS_ORIGIN (${BUILD_ORIGIN}) leaked into the response — ` +
          'the value has been frozen into the artifact',
      );
    }),

    check(6, 'the public-IP rate-limit bucket trips, with full headers', async () => {
      const ip = freshIp();
      let last = null;
      for (let i = 0; i < LIMIT_PUBLIC + 1; i++) {
        last = await req(base, '/api/registry/agents', { ip });
      }
      eq(last.status, 429, 'status on the over-limit request');
      eq(last.body?.code, 'RATE_LIMITED', 'body.code');
      eq(last.body?.bucket, 'public-ip', 'body.bucket');
      ok(Number(last.headers.get('retry-after')) >= 1, 'Retry-After >= 1');
      eq(last.headers.get('x-ratelimit-limit'), String(LIMIT_PUBLIC), 'X-RateLimit-Limit');
      eq(last.headers.get('x-ratelimit-remaining'), '0', 'X-RateLimit-Remaining');
      ok(
        Number.isFinite(Number(last.headers.get('x-ratelimit-reset'))),
        'X-RateLimit-Reset is numeric',
      );
    }),

    check(7, 'the enrollment bucket is separate and stricter', async () => {
      const ip = freshIp();
      let last = null;
      for (let i = 0; i < LIMIT_ENROLL + 1; i++) {
        last = await req(base, '/api/registry/enroll', { method: 'POST', ip });
      }
      eq(last.status, 429, 'status on the over-limit request');
      eq(last.body?.bucket, 'enroll-ip', 'body.bucket');
    }),

    check(8, 'the per-API-key bucket trips independently of IP', async () => {
      let last = null;
      for (let i = 0; i < LIMIT_APIKEY + 1; i++) {
        // A fresh IP each time, so only the API-key bucket can be what trips.
        last = await req(base, '/api/sessions', { key: KEY_BURST });
      }
      eq(last.status, 429, 'status on the over-limit request');
      eq(last.body?.bucket, 'api-key', 'body.bucket');
    }),

    check(9, 'probe endpoints are exempt from rate limiting', async () => {
      const ip = freshIp();
      for (let i = 0; i < 20; i++) {
        const a = await req(base, '/api/health', { ip });
        const b = await req(base, '/api/readyz', { ip });
        ok(a.status !== 429, `/api/health was rate limited on iteration ${i}`);
        ok(b.status !== 429, `/api/readyz was rate limited on iteration ${i}`);
      }
    }),

    check(10, 'the effective public route set matches the committed baseline', async () => {
      const observed = {};
      for (const route of builtRoutes()) {
        observed[route] = await probe(base, route);
      }
      const diffs = [];
      for (const route of new Set([
        ...Object.keys(observed),
        ...Object.keys(baseline.routes),
      ])) {
        const was = baseline.routes[route] ?? '(absent from baseline)';
        const now = observed[route] ?? '(no longer built)';
        if (was !== now) diffs.push(`  ${route}: ${was} -> ${now}`);
      }
      if (diffs.length) {
        fail(
          'the effective public route set changed:\n' +
            diffs.join('\n') +
            '\n\nIf this is intended, review each line above carefully, then ' +
            'regenerate with `node scripts/verify-request-gate.mjs --update-baseline`.',
        );
      }
    }),

    check(11, 'public agent discovery still works, unauthenticated', async () => {
      const aid = encodeURIComponent('aid:pubkey:harness');
      for (const p of [`/api/registry/agents/${aid}`, `/api/registry/agents/${aid}/manifest`]) {
        const r = await req(base, p);
        ok(r.status !== 401, `${p} should be publicly readable, got 401`);
      }
    }),

    check(12, 'agent sub-routes are NOT opened by the discovery pattern', async () => {
      const aid = encodeURIComponent('aid:pubkey:harness');
      const r = await req(base, `/api/registry/agents/${aid}/export`);
      eq(r.status, 401, '/export must stay gated (regression guard: startsWith leak)');
      const d = await req(base, `/api/registry/agents/${aid}`, { method: 'DELETE' });
      eq(d.status, 401, 'DELETE on a discoverable agent must stay gated');
    }),

    check(13, 'the gate does not run for /.well-known/* — locked in deliberately', async () => {
      // The gate executes BEFORE beforeFiles rewrites, so at gate time the path
      // is /.well-known/..., which does not match the /api/:path* matcher. That
      // response therefore carries no CORS headers. This is pre-existing and
      // identical on both runtimes. Asserting the ABSENCE of the header locks in
      // today's behaviour instead of silently blessing a change to it.
      const r = await req(base, '/.well-known/aitp-manifest');
      eq(r.status, 200, 'status');
      ok(
        acao(r) === null,
        'expected NO access-control-allow-origin on /.well-known/* — if this ' +
          'now has one, the matcher changed and the assertion needs revisiting',
      );
    }),

    check(14, 'the gate is attached, and its matcher is unchanged', async () => {
      eq(gate.matchers.length, 1, 'exactly one matcher');
      eq(gate.matchers[0].originalSource, '/api/:path*', 'matcher originalSource');
      eq(
        gate.matchers[0].regexp,
        baseline.gate.matcherRegexp,
        'compiled matcher regexp (a change here silently changes which routes are gated)',
      );
      ok(
        ['edge', 'nodejs'].includes(gate.runtime),
        `unexpected gate runtime: ${gate.runtime}`,
      );
    }),
  ];
}

// ── SERVER_MISCONFIGURED needs its own boot, with API_KEYS unset ────────────
async function checkMisconfigured() {
  const server = await boot({ API_KEYS: '' });
  try {
    const r = await req(server.base, '/api/sessions');
    eq(r.status, 503, 'status with API_KEYS unset under NODE_ENV=production');
    eq(r.body?.code, 'SERVER_MISCONFIGURED', 'body.code');
  } finally {
    await shutdown(server);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (DO_BUILD) await build();
  const gate = findGate();
  console.log(`request gate: ${gate.runtime} runtime, via ${gate.source}`);

  if (UPDATE) {
    const server = await boot();
    try {
      const routes = {};
      for (const route of builtRoutes()) {
        routes[route] = await probe(server.base, route);
      }
      const baseline = {
        _comment:
          'Effective request-gate contract, derived from a RUNNING built server ' +
          '(never from src/proxy.ts). Review every "public" entry by hand: each ' +
          'one is a route reachable with no credentials.',
        gate: {
          matcherSource: gate.matchers[0]?.originalSource,
          matcherRegexp: gate.matchers[0]?.regexp,
        },
        routes,
      };
      writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
      const pub = Object.entries(routes).filter(([, v]) => v === 'public');
      console.log(`baseline written: ${Object.keys(routes).length} routes, ${pub.length} public`);
      for (const [r] of pub) console.log(`  public: ${r}`);
    } finally {
      await shutdown(server);
    }
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    fail(`no baseline at ${BASELINE_PATH} — generate it with --update-baseline`);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

  const server = await boot();
  let failures = 0;
  try {
    for (const c of buildChecks(server.base, gate, baseline)) {
      currentCheck = c;
      try {
        await c.fn();
        console.log(`  ok   ${String(c.id).padStart(2)}  ${c.title}`);
        results.push({ id: c.id, ok: true });
      } catch (err) {
        failures++;
        console.log(`  FAIL ${String(c.id).padStart(2)}  ${c.title}`);
        console.log(`         ${err.message.split('\n').join('\n         ')}`);
        results.push({ id: c.id, ok: false });
      }
    }
  } finally {
    await shutdown(server);
  }

  try {
    currentCheck = { id: 15, title: 'API_KEYS unset in production is fail-closed' };
    await checkMisconfigured();
    console.log(`  ok   15  ${currentCheck.title}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL 15  ${currentCheck.title}`);
    console.log(`         ${err.message.split('\n').join('\n         ')}`);
  }

  const total = results.length + 1;
  if (failures) {
    throw new Error(`${failures}/${total} request-gate checks FAILED`);
  }
  console.log(`\nall ${total} request-gate checks passed`);
}

const watchdog = setTimeout(() => {
  console.error(
    `\nharness watchdog: exceeded ${WATCHDOG_MS / 60_000} minutes. Failing ` +
      'rather than hanging the job.',
  );
  killAllSpawned();
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

process.on('exit', killAllSpawned);

main()
  .then(() => {
    clearTimeout(watchdog);
    killAllSpawned();
    // Exit explicitly. A lingering handle must not turn a passing run into a
    // silent hang — that failure mode already cost one 20-minute CI job.
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\nharness error: ${err.message}`);
    clearTimeout(watchdog);
    killAllSpawned();
    process.exit(1);
  });
