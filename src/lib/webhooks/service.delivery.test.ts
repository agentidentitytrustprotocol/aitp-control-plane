// Unit tests for the delivery half of the webhook service (attemptDelivery
// + flushDueRetries) — the part service.test.ts / service.dispatch.test.ts
// don't touch. We mock `../db` (queued select results, recorded update
// sets), the circuit breaker, the SSRF url-guard and `../config`, and
// stub global fetch. Verifies: terminal states (delivered rows, missing/
// inactive webhooks, unsafe targets), the optimistic-claim bail-out,
// breaker-open deferral with jitter, the canonical body + HMAC signature
// headers on the POST (stored vs legacy on-the-fly signing), exponential
// backoff persistence, retry exhaustion, the enqueue outbox row written
// by dispatchWebhooks, CRUD helpers, and the idempotent reaper start.

import { jest } from '@jest/globals';
import { createHmac } from 'node:crypto';

let selectQueue: unknown[][] = [];
let selectCallCount = 0;
const updateSets: Record<string, unknown>[] = [];
const insertValuesCalls: Record<string, unknown>[] = [];
// Feeds .returning() on UPDATE (optimistic claim / updateWebhook) and DELETE.
let claimResult: { id: string }[] = [];
let deleteReturning: { id: string }[] = [];

jest.mock('../db', () => ({
  db: {
    select: () => {
      selectCallCount += 1;
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => chain;
      // Awaitable wherever the query chain ends.
      (chain as { then?: unknown }).then = (
        resolve: (v: unknown) => unknown,
      ) => resolve(selectQueue.shift() ?? []);
      return chain;
    },
    insert: () => ({
      values: (arg: Record<string, unknown>) => {
        insertValuesCalls.push(arg);
        return Promise.resolve(undefined);
      },
    }),
    update: () => ({
      set: (arg: Record<string, unknown>) => {
        updateSets.push(arg);
        return {
          where: () => {
            // Awaitable directly (plain UPDATE) and also supports
            // .returning() for the optimistic claim / updateWebhook.
            const p = Promise.resolve(undefined) as Promise<undefined> & {
              returning: () => Promise<{ id: string }[]>;
            };
            p.returning = () => Promise.resolve(claimResult);
            return p;
          },
        };
      },
    }),
    delete: () => ({
      where: () => ({ returning: () => Promise.resolve(deleteReturning) }),
    }),
  },
}));

let breakerAllows = true;
let breakerSnapshot: Record<string, unknown> = {
  state: 'closed',
  failures: 0,
  consecutiveSuccesses: 0,
  openedAt: null,
  nextProbeAt: null,
};
const breakerCalls: string[] = [];
jest.mock('./circuit-breaker', () => ({
  webhookBreaker: {
    shouldAttempt: () => breakerAllows,
    getSnapshot: () => breakerSnapshot,
    recordSuccess: () => breakerCalls.push('success'),
    recordFailure: () => breakerCalls.push('failure'),
  },
}));

let urlGuardError: Error | null = null;
jest.mock('./url-guard', () => {
  class UnsafeWebhookUrlError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'UnsafeWebhookUrlError';
    }
  }
  return {
    UnsafeWebhookUrlError,
    assertSafeWebhookUrl: async () => {
      if (urlGuardError) throw urlGuardError;
    },
  };
});

jest.mock('../config', () => ({
  config: { webhookRetryAttempts: 3 },
}));

const fetchMock = jest.fn<typeof fetch>();
global.fetch = fetchMock as never;

import {
  attemptDelivery,
  createWebhook,
  deleteWebhook,
  dispatchWebhooks,
  flushDueRetries,
  signPayload,
  startWebhookReaper,
  updateWebhook,
} from './service';
import { UnsafeWebhookUrlError } from './url-guard';

/** Let fire-and-forget attemptDelivery chains kicked off by enqueue
 * settle before the test (and its queues) move on. */
const flushAsync = () => new Promise((r) => setImmediate(r));

const ts = '2026-07-07T08:00:00.000Z';

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    webhookId: 'wh1',
    eventType: 'handshake.complete',
    payload: { id: 'evt-1', type: 'handshake.complete', ts, payload: {} },
    body: '{"deliveryId":"d1","canonical":true}',
    signature: 'stored-signature',
    status: 'pending',
    attempts: 0,
    statusCode: null,
    error: null,
    nextRetryAt: null,
    deliveredAt: null,
    createdAt: ts,
    ...overrides,
  };
}

function makeWebhook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wh1',
    url: 'https://receiver.example.com/hook',
    events: [],
    secret: 'topsecret',
    active: true,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

beforeEach(() => {
  selectQueue = [];
  selectCallCount = 0;
  updateSets.length = 0;
  insertValuesCalls.length = 0;
  claimResult = [{ id: 'd1' }];
  deleteReturning = [];
  breakerAllows = true;
  breakerCalls.length = 0;
  urlGuardError = null;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
});

describe('attemptDelivery — terminal / no-op paths', () => {
  it('does nothing when the delivery row is missing', async () => {
    selectQueue = [[]];
    await attemptDelivery('nope');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSets).toEqual([]);
  });

  it('does nothing when the row is already delivered', async () => {
    selectQueue = [[makeDelivery({ status: 'delivered' })]];
    await attemptDelivery('d1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSets).toEqual([]);
  });

  it('fails the delivery when the webhook row is gone', async () => {
    selectQueue = [[makeDelivery()], []];
    await attemptDelivery('d1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSets).toEqual([
      { status: 'failed', error: 'webhook missing or inactive' },
    ]);
  });

  it('fails the delivery when the webhook is inactive', async () => {
    selectQueue = [[makeDelivery()], [makeWebhook({ active: false })]];
    await attemptDelivery('d1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSets).toEqual([
      { status: 'failed', error: 'webhook missing or inactive' },
    ]);
  });

  it('bails without POSTing when another caller wins the optimistic claim', async () => {
    selectQueue = [[makeDelivery()], [makeWebhook()]];
    claimResult = []; // WHERE attempts=<read value> matched no row
    await attemptDelivery('d1');
    expect(fetchMock).not.toHaveBeenCalled();
    // Only the claim UPDATE was issued, no delivered/failed transition.
    expect(updateSets).toEqual([{ attempts: 1, status: 'pending' }]);
  });
});

describe('attemptDelivery — circuit breaker', () => {
  it('defers with jitter on top of the breaker probe time instead of POSTing', async () => {
    const nextProbeAt = Date.now() + 45_000;
    breakerAllows = false;
    breakerSnapshot = { state: 'open', nextProbeAt };
    selectQueue = [[makeDelivery()], [makeWebhook()]];

    await attemptDelivery('d1');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSets.length).toBe(1);
    const set = updateSets[0];
    expect(set.status).toBe('pending');
    expect(set.error).toBe('circuit breaker open');
    const retryMs = Date.parse(set.nextRetryAt as string);
    expect(retryMs).toBeGreaterThanOrEqual(nextProbeAt);
    expect(retryMs).toBeLessThanOrEqual(nextProbeAt + 30_000);
  });
});

describe('attemptDelivery — successful POST', () => {
  it('sends the stored canonical body verbatim with signature headers, then marks delivered', async () => {
    const delivery = makeDelivery();
    selectQueue = [[delivery], [makeWebhook()]];

    await attemptDelivery('d1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://receiver.example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(delivery.body);
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Aitp-Event': 'handshake.complete',
      'X-Aitp-Delivery': 'd1',
      'X-Aitp-Signature': 'sha256=stored-signature',
    });

    expect(breakerCalls).toEqual(['success']);
    const final = updateSets[updateSets.length - 1];
    expect(final.status).toBe('delivered');
    expect(final.statusCode).toBe(200);
    expect(final.error).toBeNull();
    expect(final.nextRetryAt).toBeNull();
    expect(typeof final.deliveredAt).toBe('string');
  });

  it('signs legacy rows (no stored body/signature) on the fly with the webhook secret', async () => {
    const delivery = makeDelivery({ body: null, signature: null });
    selectQueue = [[delivery], [makeWebhook()]];

    await attemptDelivery('d1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const expectedBody = JSON.stringify({
      deliveryId: 'd1',
      eventType: 'handshake.complete',
      payload: delivery.payload,
      enqueuedAt: ts, // falls back to the row's createdAt
    });
    expect(init.body).toBe(expectedBody);
    const expectedSig = createHmac('sha256', 'topsecret')
      .update(expectedBody)
      .digest('hex');
    expect(
      (init.headers as Record<string, string>)['X-Aitp-Signature'],
    ).toBe(`sha256=${expectedSig}`);
  });
});

describe('attemptDelivery — SSRF re-validation', () => {
  it('terminally fails (no retry) when the target resolves to a private address', async () => {
    urlGuardError = new UnsafeWebhookUrlError('host resolves to 10.0.0.5');
    selectQueue = [[makeDelivery()], [makeWebhook()]];

    await attemptDelivery('d1');

    expect(fetchMock).not.toHaveBeenCalled();
    const final = updateSets[updateSets.length - 1];
    expect(final).toEqual({
      status: 'failed',
      error: 'unsafe target: host resolves to 10.0.0.5',
      nextRetryAt: null,
    });
  });

  it('rethrows unexpected url-guard errors (e.g. DNS infrastructure failure)', async () => {
    urlGuardError = new Error('dns backend exploded');
    selectQueue = [[makeDelivery()], [makeWebhook()]];
    await expect(attemptDelivery('d1')).rejects.toThrow('dns backend exploded');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('attemptDelivery — failure, backoff, exhaustion', () => {
  it('records a non-2xx response and schedules the first retry ~30s out', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    selectQueue = [[makeDelivery()], [makeWebhook()]];
    const before = Date.now();

    await attemptDelivery('d1');

    expect(breakerCalls).toEqual(['failure']);
    const final = updateSets[updateSets.length - 1];
    expect(final.status).toBe('pending');
    expect(final.statusCode).toBe(500);
    expect(final.error).toBe('non-2xx (500): boom');
    const retryMs = Date.parse(final.nextRetryAt as string);
    expect(retryMs).toBeGreaterThanOrEqual(before + 30_000);
    expect(retryMs).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('quadruples the backoff on the second attempt (30s → 120s)', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }));
    selectQueue = [[makeDelivery({ attempts: 1 })], [makeWebhook()]];
    const before = Date.now();

    await attemptDelivery('d1');

    const final = updateSets[updateSets.length - 1];
    expect(final.status).toBe('pending');
    const retryMs = Date.parse(final.nextRetryAt as string);
    expect(retryMs).toBeGreaterThanOrEqual(before + 120_000);
    expect(retryMs).toBeLessThanOrEqual(Date.now() + 121_000);
  });

  it('records network errors (fetch rejection) as the error string', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    selectQueue = [[makeDelivery()], [makeWebhook()]];

    await attemptDelivery('d1');

    const final = updateSets[updateSets.length - 1];
    expect(final.status).toBe('pending');
    expect(final.statusCode).toBeNull();
    expect(final.error).toBe('ECONNREFUSED');
  });

  it('marks the delivery failed with no retry once the attempt budget is spent', async () => {
    fetchMock.mockResolvedValue(new Response('still down', { status: 500 }));
    // attempts=2 read + this claim → attempts=3 == webhookRetryAttempts.
    selectQueue = [[makeDelivery({ attempts: 2 })], [makeWebhook()]];
    claimResult = [{ id: 'd1' }];

    await attemptDelivery('d1');

    const final = updateSets[updateSets.length - 1];
    expect(final).toEqual({
      status: 'failed',
      statusCode: 500,
      error: 'non-2xx (500): still down',
      nextRetryAt: null,
    });
  });
});

describe('flushDueRetries', () => {
  it('attempts every due delivery and reports how many were picked up', async () => {
    selectQueue = [
      [{ id: 'a' }, { id: 'b' }], // due rows
      [], // attemptDelivery('a') → row gone, no-op
      [], // attemptDelivery('b') → row gone, no-op
    ];
    const n = await flushDueRetries();
    expect(n).toBe(2);
    expect(selectQueue).toEqual([]); // both per-delivery lookups consumed
  });

  it('returns 0 when nothing is due', async () => {
    selectQueue = [[]];
    await expect(flushDueRetries()).resolves.toBe(0);
  });
});

describe('dispatchWebhooks — enqueue outbox row', () => {
  it('writes a pending delivery whose stored signature matches the stored body', async () => {
    const webhook = makeWebhook();
    selectQueue = [
      [webhook], // active-webhook fetch
      [], // fire-and-forget attemptDelivery finds no row → no-op
    ];
    await dispatchWebhooks({
      id: 'evt-7',
      type: 'tct.revoked',
      ts,
      payload: { jti: 'jti-1' },
    });
    await flushAsync();

    expect(insertValuesCalls.length).toBe(1);
    const row = insertValuesCalls[0];
    expect(row.webhookId).toBe('wh1');
    expect(row.eventType).toBe('tct.revoked');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    // Canonical body embeds the delivery id and enqueue time; the stored
    // signature is the HMAC of exactly those bytes.
    const body = JSON.parse(row.body as string) as Record<string, unknown>;
    expect(body.deliveryId).toBe(row.id);
    expect(body.eventType).toBe('tct.revoked');
    expect((body.payload as { id: string }).id).toBe('evt-7');
    expect(row.signature).toBe(signPayload('topsecret', row.body as string));
  });

  it('skips non-deliverable event types without touching the DB', async () => {
    await dispatchWebhooks({
      id: 'evt-8',
      type: 'capability.invoked',
      ts,
      payload: {},
    });
    expect(selectCallCount).toBe(0);
    expect(insertValuesCalls).toEqual([]);
  });
});

describe('webhook CRUD helpers', () => {
  it('createWebhook generates a 32-hex secret and defaults active=true when omitted', async () => {
    selectQueue = [[makeWebhook()]]; // re-read after insert
    const created = await createWebhook({
      url: 'https://receiver.example.com/hook',
      events: ['tct.revoked'],
    });
    const row = insertValuesCalls[0];
    expect(row.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(row.active).toBe(true);
    expect(row.events).toEqual(['tct.revoked']);
    expect(created.id).toBe('wh1'); // the re-read row is returned
  });

  it('createWebhook keeps a caller-supplied secret and active flag', async () => {
    selectQueue = [[makeWebhook()]];
    await createWebhook({
      url: 'https://receiver.example.com/hook',
      events: [],
      secret: 'caller-secret',
      active: false,
    });
    expect(insertValuesCalls[0].secret).toBe('caller-secret');
    expect(insertValuesCalls[0].active).toBe(false);
  });

  it('updateWebhook patches only the provided fields (plus updatedAt)', async () => {
    claimResult = [{ id: 'wh1' }];
    const updated = await updateWebhook('wh1', { active: false });
    expect(updated).toEqual({ id: 'wh1' });
    expect(Object.keys(updateSets[0]).sort()).toEqual(['active', 'updatedAt']);
    expect(updateSets[0].active).toBe(false);
  });

  it('updateWebhook returns undefined when no row matched', async () => {
    claimResult = [];
    await expect(updateWebhook('missing', { url: 'x' })).resolves.toBeUndefined();
  });

  it('deleteWebhook reports whether a row was removed', async () => {
    deleteReturning = [{ id: 'wh1' }];
    await expect(deleteWebhook('wh1')).resolves.toBe(true);
    deleteReturning = [];
    await expect(deleteWebhook('wh1')).resolves.toBe(false);
  });
});

describe('startWebhookReaper', () => {
  afterEach(() => {
    if (globalThis.__webhookReaperInterval) {
      clearInterval(globalThis.__webhookReaperInterval);
      globalThis.__webhookReaperInterval = undefined;
    }
  });

  it('runs a boot flush and is idempotent across repeated calls', async () => {
    selectQueue = [[], []];
    startWebhookReaper(3_600_000);
    const handle = globalThis.__webhookReaperInterval;
    expect(handle).toBeDefined();
    await flushAsync();
    expect(selectCallCount).toBe(1); // boot flushDueRetries ran once

    startWebhookReaper(3_600_000);
    expect(globalThis.__webhookReaperInterval).toBe(handle); // no second interval
    await flushAsync();
    expect(selectCallCount).toBe(1); // and no second boot flush
  });
});
