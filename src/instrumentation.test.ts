// Unit tests for the boot hook's WIRING — that `register()` actually calls the
// things it is supposed to, in the order it is supposed to.
//
// WHY THIS FILE EXISTS AT ALL, given `jest.config.js` excludes
// `src/instrumentation.ts` from coverage ("OTel bootstrap; exercised only at
// process start"): the exclusion suppresses the coverage MEASUREMENT, not the
// ability to test. And the one line this file is really about —
// `enforceEnrollmentSecretAtBoot()` — was the single unasserted link in issue
// #99's fix. The policy behind it is exhaustively tested in
// `lib/registry/enrollment-config.test.ts`, but nothing anywhere proved the boot
// hook CALLS it. Deleting that call, or moving it below one of the early returns,
// would have shipped green while #99 silently reopened: every CI path supplies a
// valid ENROLLMENT_SECRET, so no other test or harness in the repo would notice.
//
// ORDER IS PART OF THE CONTRACT, not a detail. The config check must run before
// the shutdown hooks and before the OTel SDK starts: a process that is about to
// `process.exit(1)` should not first register signal handlers or bring up an
// exporter, and the failure must be the first thing in the log rather than the
// third. So both the call and its position are asserted.
//
// The Node-runtime guard is asserted too, because it is what keeps a
// `process.exit` out of the Edge runtime's reach — see the note in
// `enrollment-config.ts` about why the exit lives in that module rather than here.

import { jest } from '@jest/globals';

const enforceEnrollmentSecretAtBootMock = jest.fn(() => {});
const registerShutdownHooksMock = jest.fn((_hooks?: unknown) => {});
/** Every observable side effect, in the order it happened. */
const calls: string[] = [];

jest.mock('./lib/node-env', () => ({
  warnOnUnrecognisedNodeEnv: () => {
    calls.push('warnOnUnrecognisedNodeEnv');
  },
}));
jest.mock('./lib/registry/enrollment-config', () => ({
  enforceEnrollmentSecretAtBoot: () => {
    calls.push('enforceEnrollmentSecretAtBoot');
    enforceEnrollmentSecretAtBootMock();
  },
}));
const enforceCpSeedAtBootMock = jest.fn(() => {});
jest.mock('./lib/identity/cp-seed-config', () => ({
  enforceCpSeedAtBoot: () => {
    calls.push('enforceCpSeedAtBoot');
    enforceCpSeedAtBootMock();
  },
}));
jest.mock('./lib/shutdown', () => ({
  registerShutdownHooks: (hooks?: unknown) => {
    calls.push('registerShutdownHooks');
    registerShutdownHooksMock(hooks);
  },
}));

// The OTel packages are mocked only to record WHEN the SDK starts: the order
// against the JWKS refresher is the whole point of the OTel-on test below.
jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    start() {
      calls.push('sdk.start');
    }
    shutdown() {
      return Promise.resolve();
    }
  },
}));
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {},
}));
jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: () => [],
}));
jest.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: () => ({}),
}));

jest.mock('./lib/trust-anchors/jwks-refresher', () => ({
  startJwksRefresher: () => {
    calls.push('startJwksRefresher');
  },
}));

const reportRequestErrorMock = jest.fn((..._args: unknown[]): unknown => undefined);
jest.mock('./lib/request-error', () => ({
  reportRequestError: (...args: unknown[]) => reportRequestErrorMock(...args),
}));

import { onRequestError, register } from './instrumentation';
// Type-only, and the only import of a private Next path in this repo — see the
// signature pin at the bottom of this file for why it is confined to a test.
import type { Instrumentation } from 'next/dist/server/instrumentation/types';

const savedRuntime = process.env.NEXT_RUNTIME;
const savedOtel = process.env.OTEL_ENABLED;
// `NEXT_RUNTIME` is not one of the variables Next's generated `next-env.d.ts`
// types as read-only, but OTEL_ENABLED/NEXT_RUNTIME are written through the same
// widened alias as elsewhere in this suite for consistency.
const mutableEnv = process.env as Record<string, string | undefined>;

beforeEach(() => {
  calls.length = 0;
  enforceEnrollmentSecretAtBootMock.mockClear();
  enforceCpSeedAtBootMock.mockClear();
  registerShutdownHooksMock.mockClear();
  reportRequestErrorMock.mockReset();
  reportRequestErrorMock.mockImplementation(() => undefined);
  mutableEnv.NEXT_RUNTIME = 'nodejs';
  delete mutableEnv.OTEL_ENABLED;
});

/** The request Next hands the hook. Shaped like the real thing; the fields the
 *  reporter actually reads are asserted in `lib/request-error.test.ts`. */
function errorRequest(over: Record<string, unknown> = {}) {
  return {
    path: '/api/events/history',
    method: 'GET',
    headers: { 'x-request-id': 'cp-abc-123' },
    ...over,
  } as Parameters<typeof onRequestError>[1];
}

function errorContext(over: Record<string, unknown> = {}) {
  return {
    routerKind: 'App Router',
    routePath: '/api/events/history',
    routeType: 'route',
    revalidateReason: undefined,
    ...over,
  } as Parameters<typeof onRequestError>[2];
}

afterAll(() => {
  if (savedRuntime === undefined) delete mutableEnv.NEXT_RUNTIME;
  else mutableEnv.NEXT_RUNTIME = savedRuntime;
  if (savedOtel === undefined) delete mutableEnv.OTEL_ENABLED;
  else mutableEnv.OTEL_ENABLED = savedOtel;
});

describe('register', () => {
  it('validates ENROLLMENT_SECRET at boot', async () => {
    // The assertion issue #99 actually rests on. Everything else in this file
    // guards its position.
    await register();
    expect(enforceEnrollmentSecretAtBootMock).toHaveBeenCalledTimes(1);
  });

  it('validates CP_AID_SEED_HEX at boot, right after ENROLLMENT_SECRET', async () => {
    // Without this call a production deploy with no (or a malformed) seed boots
    // green and fails the manifest, revocation list and /api/health on first
    // use — every CI path supplies a valid seed, so nothing else would notice.
    await register();
    expect(enforceCpSeedAtBootMock).toHaveBeenCalledTimes(1);
    const i = calls.indexOf('enforceEnrollmentSecretAtBoot');
    expect(calls[i + 1]).toBe('enforceCpSeedAtBoot');
  });

  it('validates the config BEFORE registering shutdown hooks', async () => {
    // A process that is about to exit should not first install signal handlers,
    // and the operator should read the fatal line first rather than third.
    await register();
    expect(calls).toEqual([
      'warnOnUnrecognisedNodeEnv',
      'enforceEnrollmentSecretAtBoot',
      'enforceCpSeedAtBoot',
      'registerShutdownHooks',
      'startJwksRefresher',
    ]);
  });

  it('starts the JWKS refresher AFTER the OTel SDK, so pg is still patched', async () => {
    // The refresher imports the database module, which loads `pg`. OTel patches
    // `pg` through a require hook that only exists once `sdk.start()` has run, so
    // a refresher started first would leave every database query untraced.
    // Check 21 of the shipped-image harness catches this in the built image;
    // this pins the order where it is cheap to read.
    mutableEnv.OTEL_ENABLED = 'true';
    await register();
    expect(calls).toEqual([
      'warnOnUnrecognisedNodeEnv',
      'enforceEnrollmentSecretAtBoot',
      'enforceCpSeedAtBoot',
      'sdk.start',
      'registerShutdownHooks',
      'startJwksRefresher',
    ]);
  });

  it('still registers shutdown hooks with OTel off, so readiness drains', async () => {
    // The pre-existing contract this file must not let the new call displace:
    // shutdown hooks are wired even when OTel is disabled, or /api/readyz never
    // flips to 503 on SIGTERM.
    await register();
    expect(registerShutdownHooksMock).toHaveBeenCalledTimes(1);
    expect(registerShutdownHooksMock).toHaveBeenCalledWith(undefined);
  });

  it('does nothing at all off the Node.js runtime', async () => {
    // The guard that keeps `process.exit` out of the Edge runtime's reach. If it
    // regressed, the boot check would run in a realm that cannot host it — and
    // the build would start warning about an unsupported Node API.
    for (const runtime of ['edge', undefined]) {
      calls.length = 0;
      if (runtime === undefined) delete mutableEnv.NEXT_RUNTIME;
      else mutableEnv.NEXT_RUNTIME = runtime;
      await register();
      expect(calls).toEqual([]);
    }
  });
});

describe('onRequestError', () => {
  // Same reason as `register()` above: what this hook LOGS is tested in
  // `lib/request-error.test.ts` against real pino output, and what is tested
  // here is only that the wiring exists and holds. An `onRequestError` that is
  // exported, typechecks, and delegates nowhere is indistinguishable from a
  // working one — and Next reports a missing hook as nothing at all.

  it('delegates the fault to the pino reporter', async () => {
    // The assertion issue #114 actually rests on. Everything else in this
    // describe block guards its edges.
    const err = new Error('connect ECONNREFUSED');
    await onRequestError(err, errorRequest(), errorContext());
    expect(reportRequestErrorMock).toHaveBeenCalledTimes(1);
    expect(reportRequestErrorMock.mock.calls[0]?.[0]).toBe(err);
  });

  it('passes the request and context through unchanged', async () => {
    // The hook's whole value is the request id and the route, and it owns
    // neither — both arrive in these two arguments. Dropping or reshaping one on
    // the way through would leave a line with nothing to correlate by, which is
    // the pre-#114 state with extra steps.
    const req = errorRequest({ path: '/api/registry/agents/abc?x=1', method: 'POST' });
    const ctx = errorContext({ routePath: '/api/registry/agents/[aid]' });
    await onRequestError(new Error('x'), req, ctx);
    expect(reportRequestErrorMock.mock.calls[0]?.[1]).toBe(req);
    expect(reportRequestErrorMock.mock.calls[0]?.[2]).toBe(ctx);
  });

  it('does not throw when the reporter does', async () => {
    // Next wraps the hook in its own try/catch and reports a throw with
    // `console.error('Error in instrumentation.onRequestError:', err)` — so a
    // throw here costs the structured line AND emits a second unstructured one,
    // the exact channel #114 is about. The reporter swallows its own failures,
    // so in practice only the dynamic import can fail; asserted anyway, because
    // that is the guarantee the framework is relying on.
    reportRequestErrorMock.mockImplementation(() => {
      throw new Error('reporter exploded');
    });
    await expect(
      onRequestError(new Error('x'), errorRequest(), errorContext()),
    ).resolves.toBeUndefined();
  });

  it('does not throw when the reporter rejects', async () => {
    // Distinct from the case above: the reporter is `async`, so a rejected
    // promise reaches Next as an unhandled rejection rather than a throw unless
    // it is awaited inside the try. It is.
    reportRequestErrorMock.mockImplementation(() => Promise.reject(new Error('later')));
    await expect(
      onRequestError(new Error('x'), errorRequest(), errorContext()),
    ).resolves.toBeUndefined();
  });

  it('runs off the Node.js runtime too, unlike register()', async () => {
    // Deliberate divergence from `register()`, which returns early on Edge
    // because it must not reach `process.exit` there. Guarding this hook the
    // same way would mean logging NOTHING on a runtime where Next does call it
    // — the defect, not a safeguard. If someone adds that guard for symmetry,
    // this fails.
    mutableEnv.NEXT_RUNTIME = 'edge';
    await onRequestError(new Error('x'), errorRequest(), errorContext());
    expect(reportRequestErrorMock).toHaveBeenCalledTimes(1);
  });
});

// ── the signature pin ───────────────────────────────────────────────────────
//
// Next's `InstrumentationOnRequestError` is NOT on its public type surface: it
// is absent from `next/index.d.ts` and from every `next/*.d.ts`, and lives only
// at `next/dist/server/instrumentation/types`. Production code therefore
// declares the three argument shapes itself (see `lib/request-error.ts`) rather
// than importing a private path a minor upgrade may move.
//
// That leaves one gap, and this closes it. The failure mode is the QUIET one: if
// Next renames or retypes a field, our locally-declared types still compile,
// Next still calls the hook, and every line it emits reads `undefined` for the
// renamed field — a hook that looks wired and reports nothing useful. Nothing
// else in the repo would notice, because no unit test can see Next's types and
// the harness check only asserts the fields that still work.
//
// So the private import is confined to this test, where a drift is a loud
// `npm run typecheck` failure on the upgrade PR rather than a silent regression
// in production.
//
// Two assertions, because they catch different things:
//
//   1. Our exported hook is assignable to Next's hook type. This is the wiring
//      contract — if it fails, Next would not accept the module.
//   2. The ARGUMENT TUPLES are assignable BOTH ways. One direction alone is not
//      enough: Next growing a field our types lack fails only ours → Next's,
//      and Next dropping a field our types still require fails only Next's →
//      ours. Both directions together mean the two descriptions of the
//      arguments are the same description.
//
// Note the return type is deliberately NOT pinned in both directions. Next's is
// `void | Promise<void>` and ours is `Promise<void>` — narrower, which assertion
// (1) already proves is acceptable to Next, and which is what we want: the
// reporter is awaited rather than fired and forgotten.
const _ourHookIsAcceptableToNext: Instrumentation.onRequestError = onRequestError;
void _ourHookIsAcceptableToNext;

type NextArgs = Parameters<Instrumentation.onRequestError>;
type OurArgs = Parameters<typeof onRequestError>;

const _nextArgsFitOurs: OurArgs = null as unknown as NextArgs;
const _ourArgsFitNexts: NextArgs = null as unknown as OurArgs;
void _nextArgsFitOurs;
void _ourArgsFitNexts;
