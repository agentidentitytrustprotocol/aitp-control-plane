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

jest.mock('./lib/registry/enrollment-config', () => ({
  enforceEnrollmentSecretAtBoot: () => {
    calls.push('enforceEnrollmentSecretAtBoot');
    enforceEnrollmentSecretAtBootMock();
  },
}));
jest.mock('./lib/shutdown', () => ({
  registerShutdownHooks: (hooks?: unknown) => {
    calls.push('registerShutdownHooks');
    registerShutdownHooksMock(hooks);
  },
}));

jest.mock('./lib/trust-anchors/jwks-refresher', () => ({
  startJwksRefresher: () => {
    calls.push('startJwksRefresher');
  },
}));

import { register } from './instrumentation';

const savedRuntime = process.env.NEXT_RUNTIME;
const savedOtel = process.env.OTEL_ENABLED;
// `NEXT_RUNTIME` is not one of the variables Next's generated `next-env.d.ts`
// types as read-only, but OTEL_ENABLED/NEXT_RUNTIME are written through the same
// widened alias as elsewhere in this suite for consistency.
const mutableEnv = process.env as Record<string, string | undefined>;

beforeEach(() => {
  calls.length = 0;
  enforceEnrollmentSecretAtBootMock.mockClear();
  registerShutdownHooksMock.mockClear();
  mutableEnv.NEXT_RUNTIME = 'nodejs';
  delete mutableEnv.OTEL_ENABLED;
});

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

  it('validates the config BEFORE registering shutdown hooks', async () => {
    // A process that is about to exit should not first install signal handlers,
    // and the operator should read the fatal line first rather than third.
    await register();
    expect(calls).toEqual([
      'enforceEnrollmentSecretAtBoot',
      'startJwksRefresher',
      'registerShutdownHooks',
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
