// Unit tests for the revocation list producer. We mock `../db`, the CP
// agent, and config so we can assert: (1) DB rows are mapped to the
// signer's entry shape (epoch-seconds revokedAt, reason null → omitted),
// (2) the signed envelope is cached for ~60s and invalidate() clears it,
// (3) a DB failure degrades to signing an EMPTY list rather than
// throwing (the spec treats an empty list as a meaningful assertion).

import { jest } from '@jest/globals';

let rowsToReturn: { jti: string; revokedAt: string; reason: string | null }[] =
  [];
let dbShouldThrow = false;

jest.mock('../db', () => ({
  db: {
    select: () => ({
      from: () =>
        dbShouldThrow
          ? Promise.reject(new Error('db unreachable'))
          : Promise.resolve(rowsToReturn),
    }),
  },
}));

const signCalls: { entries: unknown[]; ttl: number }[] = [];
jest.mock('../identity/cp-agent', () => ({
  getCpAgent: () => ({
    signRevocationList: (entries: unknown[], ttl: number) => {
      signCalls.push({ entries, ttl });
      return `envelope-${signCalls.length}`;
    },
  }),
}));

jest.mock('../config', () => ({
  config: { revocationListTtlSecs: 777 },
}));

import { revocationProducer } from './producer';

beforeEach(() => {
  revocationProducer.invalidate();
  signCalls.length = 0;
  rowsToReturn = [];
  dbShouldThrow = false;
});

describe('revocationProducer.getEnvelopeJson', () => {
  it('maps DB rows to signer entries (epoch secs, reason optional) with the configured TTL', async () => {
    rowsToReturn = [
      {
        jti: 'jti-1',
        revokedAt: '2026-07-01T00:00:00.000Z',
        reason: 'key compromised',
      },
      { jti: 'jti-2', revokedAt: '2026-07-02T12:30:45.999Z', reason: null },
    ];

    const envelope = await revocationProducer.getEnvelopeJson();

    expect(envelope).toBe('envelope-1');
    expect(signCalls.length).toBe(1);
    expect(signCalls[0].ttl).toBe(777);
    expect(signCalls[0].entries).toEqual([
      {
        jti: 'jti-1',
        revokedAt: Math.floor(Date.parse('2026-07-01T00:00:00.000Z') / 1000),
        reason: 'key compromised',
      },
      {
        jti: 'jti-2',
        revokedAt: Math.floor(Date.parse('2026-07-02T12:30:45.999Z') / 1000),
        reason: undefined,
      },
    ]);
  });

  it('caches the signed envelope — a second call re-signs nothing and ignores new rows', async () => {
    rowsToReturn = [
      { jti: 'jti-1', revokedAt: '2026-07-01T00:00:00.000Z', reason: null },
    ];
    const first = await revocationProducer.getEnvelopeJson();

    // A newly revoked token appears in the DB, but the cache is fresh.
    rowsToReturn = [
      { jti: 'jti-1', revokedAt: '2026-07-01T00:00:00.000Z', reason: null },
      { jti: 'jti-2', revokedAt: '2026-07-03T00:00:00.000Z', reason: null },
    ];
    const second = await revocationProducer.getEnvelopeJson();

    expect(second).toBe(first);
    expect(signCalls.length).toBe(1);
  });

  it('invalidate() forces a re-read and re-sign', async () => {
    rowsToReturn = [];
    await revocationProducer.getEnvelopeJson();
    expect(signCalls.length).toBe(1);

    rowsToReturn = [
      { jti: 'jti-9', revokedAt: '2026-07-05T00:00:00.000Z', reason: null },
    ];
    revocationProducer.invalidate();
    const envelope = await revocationProducer.getEnvelopeJson();

    expect(envelope).toBe('envelope-2');
    expect(signCalls.length).toBe(2);
    expect(
      (signCalls[1].entries as { jti: string }[]).map((e) => e.jti),
    ).toEqual(['jti-9']);
  });

  it('publishes a signed EMPTY list when the DB read fails', async () => {
    dbShouldThrow = true;
    const envelope = await revocationProducer.getEnvelopeJson();
    expect(envelope).toBe('envelope-1');
    expect(signCalls.length).toBe(1);
    expect(signCalls[0].entries).toEqual([]);
  });
});
