// Pure logic test: simulate the SQL that `enforceManifestExpiry` issues
// without spinning up Postgres. We mock the `../db` module so the same
// drizzle query-builder chain that the job uses returns canned data.

import { jest } from '@jest/globals';

let insertShouldReject = false;
let transitionedRows: Array<{ aid: string; displayName: string; namespace: string }> =
  [
    { aid: 'aid:pubkey:one', displayName: 'one', namespace: 'default' },
    { aid: 'aid:pubkey:two', displayName: 'two', namespace: 'production' },
  ];

jest.mock('../db', () => {
  // UPDATE … RETURNING returns the canned rows the job has just
  // claimed/transitioned. The new implementation no longer SELECTs
  // first, so the only chain that needs canned data is `update`.
  const updateChain: Record<string, unknown> = {};
  updateChain.set = () => updateChain;
  updateChain.where = () => updateChain;
  updateChain.returning = () => Promise.resolve(transitionedRows);

  // INSERT chain — for ingestOneEvent best-effort calls
  const insertChain: Record<string, unknown> = {};
  insertChain.values = () => insertChain;
  insertChain.onConflictDoNothing = () =>
    insertShouldReject
      ? Promise.reject(new Error('insert failed'))
      : Promise.resolve(undefined as unknown);

  return {
    db: {
      update: () => updateChain,
      insert: () => insertChain,
    },
  };
});

const dispatchWebhooksMock = jest.fn(async (_e: unknown) => undefined);
jest.mock('../webhooks/service', () => ({
  dispatchWebhooks: (e: unknown) => dispatchWebhooksMock(e),
}));

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { enforceManifestExpiry, startExpiryJob } from './expiry-job';
import { eventBus } from '../audit/stream';
import { logger } from '../logger';

beforeEach(() => {
  insertShouldReject = false;
  dispatchWebhooksMock.mockClear();
  dispatchWebhooksMock.mockResolvedValue(undefined);
  jest.clearAllMocks();
  transitionedRows = [
    { aid: 'aid:pubkey:one', displayName: 'one', namespace: 'default' },
    { aid: 'aid:pubkey:two', displayName: 'two', namespace: 'production' },
  ];
});

describe('enforceManifestExpiry', () => {
  it('transitions active→expired, emits agent.expired events, returns count', async () => {
    const seen: string[] = [];
    const unsubscribe = eventBus.subscribe((e) => {
      if (e.type === 'agent.expired') seen.push(e.aidA ?? '');
    });
    try {
      const count = await enforceManifestExpiry();
      expect(count).toBe(2);
      expect(seen).toEqual(
        expect.arrayContaining(['aid:pubkey:one', 'aid:pubkey:two']),
      );
    } finally {
      unsubscribe();
    }
  });

  it('returns 0 and touches neither eventBus nor webhooks when nothing transitioned', async () => {
    transitionedRows = [];
    const unsubscribe = eventBus.subscribe(() => {
      throw new Error('should not publish when nothing expired');
    });
    try {
      const count = await enforceManifestExpiry();
      expect(count).toBe(0);
      expect(dispatchWebhooksMock).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('still publishes + dispatches webhooks even when the best-effort audit insert fails', async () => {
    insertShouldReject = true;
    const seen: string[] = [];
    const unsubscribe = eventBus.subscribe((e) => {
      if (e.type === 'agent.expired') seen.push(e.aidA ?? '');
    });
    try {
      const count = await enforceManifestExpiry();
      expect(count).toBe(2);
      expect(seen).toHaveLength(2);
      expect(dispatchWebhooksMock).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'expiry-job audit insert failed',
      );
    } finally {
      unsubscribe();
    }
  });

  it('does not throw when dispatchWebhooks rejects (fire-and-forget)', async () => {
    dispatchWebhooksMock.mockRejectedValue(new Error('webhook target down'));
    await expect(enforceManifestExpiry()).resolves.toBe(2);
    // The rejection is handled via a .catch chained onto the
    // fire-and-forget call — flush microtasks so it runs before
    // asserting, otherwise it'd surface as an unhandled rejection later.
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'expiry-job webhook dispatch failed',
    );
  });
});

describe('startExpiryJob', () => {
  afterEach(() => {
    if (globalThis.__expiryInterval) {
      clearInterval(globalThis.__expiryInterval);
      globalThis.__expiryInterval = undefined;
    }
    jest.useRealTimers();
  });

  it('is idempotent: a second call does not replace the running interval', () => {
    startExpiryJob(1000);
    const first = globalThis.__expiryInterval;
    startExpiryJob(1000);
    expect(globalThis.__expiryInterval).toBe(first);
  });

  it('ticks call enforceManifestExpiry on the given interval', async () => {
    jest.useFakeTimers();
    startExpiryJob(1000);
    // The async variant advances virtual time one tick and drains the
    // microtasks the (async) interval callback schedules along the way.
    await jest.advanceTimersByTimeAsync(1000);
    expect(dispatchWebhooksMock).toHaveBeenCalledTimes(2);
  });
});
