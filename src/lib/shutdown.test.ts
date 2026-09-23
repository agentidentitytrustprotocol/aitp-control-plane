// Unit tests for the shutdown coordinator — verifies:
//   • isShuttingDown() reflects the module-global flag
//   • registerShutdownHooks() is idempotent (a second call registers no
//     extra signal listeners)
//   • receiving SIGTERM: flips the draining flag, clears every background
//     timer, runs extra hooks in parallel, and exits
//   • a hook that rejects does not stop the other hooks or block exit
//   • a second signal while already shutting down is a no-op
//
// process.exit is mocked so the test runner survives; the SIGTERM/SIGINT
// listeners this module installs via `.once` are diffed against a
// baseline and removed after every test so nothing leaks onto other
// suites sharing this worker's `process` object.

import { jest } from '@jest/globals';

jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { isShuttingDown, registerShutdownHooks } from './shutdown';
import { logger } from './logger';

type Signal = 'SIGTERM' | 'SIGINT';
let baseline: Record<Signal, Function[]> = { SIGTERM: [], SIGINT: [] };

function snapshotListeners(): Record<Signal, Function[]> {
  return {
    SIGTERM: [...process.listeners('SIGTERM')],
    SIGINT: [...process.listeners('SIGINT')],
  };
}

function removeListenersAddedSince(before: Record<Signal, Function[]>) {
  for (const sig of ['SIGTERM', 'SIGINT'] as Signal[]) {
    for (const l of process.listeners(sig)) {
      if (!before[sig].includes(l)) process.removeListener(sig, l as never);
    }
  }
}

let exitSpy: jest.SpiedFunction<typeof process.exit>;

// The shutdown handler chains several promises (per-hook .then/.catch,
// then Promise.all, Promise.race, .catch, .finally) before calling
// process.exit — a couple of bare `await Promise.resolve()` hops isn't
// always enough to drain all of them. setImmediate runs after every
// currently-queued microtask, so awaiting it flushes the whole chain.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  baseline = snapshotListeners();
  globalThis.__shuttingDown = false;
  globalThis.__shutdownHooksRegistered = false;
  globalThis.__expiryInterval = undefined;
  globalThis.__retentionInterval = undefined;
  globalThis.__webhookReaperInterval = undefined;
  globalThis.__rateLimiterGcInterval = undefined;
  exitSpy = jest
    .spyOn(process, 'exit')
    .mockImplementation(() => undefined as never);
  jest.clearAllMocks();
});

afterEach(() => {
  removeListenersAddedSince(baseline);
  exitSpy.mockRestore();
  globalThis.__shuttingDown = false;
  globalThis.__shutdownHooksRegistered = false;
});

describe('isShuttingDown', () => {
  it('is false before any shutdown signal', () => {
    expect(isShuttingDown()).toBe(false);
  });

  it('reflects the module-global flag once set', () => {
    globalThis.__shuttingDown = true;
    expect(isShuttingDown()).toBe(true);
  });
});

describe('registerShutdownHooks', () => {
  it('installs exactly one SIGTERM and one SIGINT listener', () => {
    registerShutdownHooks();
    expect(process.listeners('SIGTERM')).toHaveLength(baseline.SIGTERM.length + 1);
    expect(process.listeners('SIGINT')).toHaveLength(baseline.SIGINT.length + 1);
  });

  it('is idempotent: a second call adds no further listeners', () => {
    registerShutdownHooks();
    registerShutdownHooks();
    expect(process.listeners('SIGTERM')).toHaveLength(baseline.SIGTERM.length + 1);
    expect(process.listeners('SIGINT')).toHaveLength(baseline.SIGINT.length + 1);
  });

  it('on SIGTERM: flips isShuttingDown, clears background timers, runs hooks, exits', async () => {
    const expiryHandle = setInterval(() => {}, 1_000_000);
    expiryHandle.unref?.();
    globalThis.__expiryInterval = expiryHandle;

    const hook = jest.fn(async () => undefined);
    registerShutdownHooks([hook]);

    process.emit('SIGTERM');
    expect(isShuttingDown()).toBe(true);
    expect(globalThis.__expiryInterval).toBeUndefined();

    await flush();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('a rejecting hook is logged but does not block the other hooks or exit', async () => {
    const okHook = jest.fn(async () => undefined);
    const badHook = jest.fn(async () => {
      throw new Error('hook blew up');
    });
    registerShutdownHooks([badHook, okHook]);

    process.emit('SIGTERM');
    await flush();

    expect(okHook).toHaveBeenCalledTimes(1);
    expect(badHook).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'shutdown: hook failed',
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('a second signal while already draining is a no-op (hooks run once)', async () => {
    const hook = jest.fn(async () => undefined);
    registerShutdownHooks([hook]);

    process.emit('SIGTERM');
    process.emit('SIGINT');
    await flush();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});
