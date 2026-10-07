// Unit tests for the revocation list producer. We mock `../db`, the CP
// agent, and config so we can assert: (1) DB rows are mapped to the
// signer's entry shape (epoch-seconds revokedAt, reason null → omitted),
// (2) the signed envelope is cached for ~60s and invalidate() clears it,
// (3) a DB failure degrades to signing an EMPTY list rather than
// throwing (the spec treats an empty list as a meaningful assertion).

import { jest } from '@jest/globals';

let rowsToReturn: { jti: string; revokedAt: number; reason: string | null }[] =
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

/**
 * The logger is mocked so the DB-failure WARNING TEXT can be asserted.
 *
 * That text is not cosmetic: `scripts/verify-image.mjs` greps the shipped
 * container's logs for it, and its absence is the single assertion standing between
 * that harness's five revocation checks and total vacuity — the fallback below
 * publishes an EMPTY BUT VALIDLY SIGNED list, so a broken database passes a
 * signature check, an issuer check and a tamper check alike. Reword the message in
 * `producer.ts` and that harness goes green against an image whose database access
 * is entirely broken. Measured, not theorised. This test is the pin.
 */
const warnCalls: { obj: unknown; msg: string }[] = [];
jest.mock('../logger', () => ({
  logger: {
    warn: (obj: unknown, msg: string) => {
      warnCalls.push({ obj, msg });
    },
    info: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { revocationProducer } from './producer';
/** The substring `scripts/verify-image.mjs` greps for. Keep the two in step. */
const HARNESS_GREPPED_WARNING = 'revocation DB read failed';

beforeEach(() => {
  revocationProducer.invalidate();
  signCalls.length = 0;
  warnCalls.length = 0;
  rowsToReturn = [];
  dbShouldThrow = false;
});

describe('revocationProducer.getEnvelopeJson', () => {
  it('maps DB rows to signer entries (epoch secs, reason optional) with the configured TTL', async () => {
    rowsToReturn = [
      {
        jti: 'jti-1',
        revokedAt: Math.floor(Date.parse('2026-07-01T00:00:00.000Z') / 1000),
        reason: 'key compromised',
      },
      { jti: 'jti-2', revokedAt: Math.floor(Date.parse('2026-07-02T12:30:45.999Z') / 1000), reason: null },
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

  it('passes the SQL-computed epoch seconds through unchanged, including negative (pre-1970) values', async () => {
    // Year 0001-01-01 is -62135596800; the producer must not re-parse it.
    rowsToReturn = [{ jti: 'jti-low', revokedAt: -62135596800, reason: null }];
    await revocationProducer.getEnvelopeJson();
    expect(signCalls[0].entries).toEqual([
      { jti: 'jti-low', revokedAt: -62135596800, reason: undefined },
    ]);
  });

  it('caches the signed envelope — a second call re-signs nothing and ignores new rows', async () => {
    rowsToReturn = [
      { jti: 'jti-1', revokedAt: Math.floor(Date.parse('2026-07-01T00:00:00.000Z') / 1000), reason: null },
    ];
    const first = await revocationProducer.getEnvelopeJson();

    // A newly revoked token appears in the DB, but the cache is fresh.
    rowsToReturn = [
      { jti: 'jti-1', revokedAt: Math.floor(Date.parse('2026-07-01T00:00:00.000Z') / 1000), reason: null },
      { jti: 'jti-2', revokedAt: Math.floor(Date.parse('2026-07-03T00:00:00.000Z') / 1000), reason: null },
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
      { jti: 'jti-9', revokedAt: Math.floor(Date.parse('2026-07-05T00:00:00.000Z') / 1000), reason: null },
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

  // THE PIN ON THE FALLBACK'S WARNING TEXT. Read the comment on the logger mock
  // above before touching this: `scripts/verify-image.mjs` asserts this exact
  // substring is ABSENT from a healthy container's logs, and that assertion is the
  // only thing that distinguishes a correctly-signed list from the empty-but-signed
  // one the branch above produces. A reword here without a matching change there
  // turns five image checks green against a broken database, silently.
  it('logs a warning containing the substring verify-image.mjs greps for, at warn level', async () => {
    dbShouldThrow = true;
    await revocationProducer.getEnvelopeJson();
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0].msg).toContain(HARNESS_GREPPED_WARNING);
    // `err` must be carried, or an operator sees "the DB read failed" with no cause.
    expect(warnCalls[0].obj).toHaveProperty('err');
  });

  it('logs NO such warning on the healthy path', async () => {
    rowsToReturn = [];
    await revocationProducer.getEnvelopeJson();
    expect(warnCalls.filter((c) => c.msg.includes(HARNESS_GREPPED_WARNING))).toEqual([]);
  });
});
