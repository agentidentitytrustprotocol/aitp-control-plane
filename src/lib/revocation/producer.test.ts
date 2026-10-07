// Unit tests for the revocation list producer. We mock `../db`, the CP
// agent, and config so we can assert: (1) DB rows are mapped to the
// signer's entry shape (epoch-seconds revokedAt, reason null → omitted),
// (2) the signed envelope is cached for ~60s and invalidate() clears it,
// (3) a DB failure NEVER signs an empty list: fail_closed (default) throws
// RevocationUnavailableError; serve_stale re-serves the last good list only
// within a bounded age.

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

const mockConfig = {
  revocationListTtlSecs: 777,
  revocationFailMode: 'fail_closed' as 'fail_closed' | 'serve_stale',
  revocationMaxStalenessSecs: 300,
};
jest.mock('../config', () => ({ config: mockConfig }));

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
const errorCalls: { obj: unknown; msg: string }[] = [];
jest.mock('../logger', () => ({
  logger: {
    warn: (obj: unknown, msg: string) => {
      warnCalls.push({ obj, msg });
    },
    info: () => {},
    error: (obj: unknown, msg: string) => {
      errorCalls.push({ obj, msg });
    },
    debug: () => {},
  },
}));

import { revocationProducer, RevocationUnavailableError } from './producer';
/** The substring `scripts/verify-image.mjs` greps for. Keep the two in step. */
const HARNESS_GREPPED_WARNING = 'revocation DB read failed';

beforeEach(() => {
  revocationProducer.invalidate();
  signCalls.length = 0;
  warnCalls.length = 0;
  errorCalls.length = 0;
  rowsToReturn = [];
  dbShouldThrow = false;
  mockConfig.revocationFailMode = 'fail_closed';
  mockConfig.revocationMaxStalenessSecs = 300;
  mockConfig.revocationListTtlSecs = 777;
  jest.restoreAllMocks();
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

  it('fail_closed (default): throws RevocationUnavailableError and signs NOTHING when the DB read fails', async () => {
    dbShouldThrow = true;
    await expect(revocationProducer.getEnvelopeJson()).rejects.toBeInstanceOf(
      RevocationUnavailableError,
    );
    expect(signCalls.length).toBe(0);
  });

  it('fail_closed: the error carries a fixed message and code, never the DB error', async () => {
    dbShouldThrow = true;
    const err = await revocationProducer.getEnvelopeJson().catch((e) => e);
    expect(err.code).toBe('REVOCATION_UNAVAILABLE');
    expect(err.message).not.toContain('db unreachable');
  });

  it('fail_closed: does not serve a previous good list after the 60s throttle lapses', async () => {
    await revocationProducer.getEnvelopeJson();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    dbShouldThrow = true;
    await expect(revocationProducer.getEnvelopeJson()).rejects.toBeInstanceOf(
      RevocationUnavailableError,
    );
    expect(signCalls.length).toBe(1);
  });

  it('serve_stale: re-serves the last good envelope (byte-identical, no re-sign) within the bound', async () => {
    mockConfig.revocationFailMode = 'serve_stale';
    const good = await revocationProducer.getEnvelopeJson();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    dbShouldThrow = true;
    expect(await revocationProducer.getEnvelopeJson()).toBe(good);
    expect(signCalls.length).toBe(1);
    expect(warnCalls[0].msg).toContain(HARNESS_GREPPED_WARNING);
    expect(warnCalls[0].obj).toHaveProperty('err');
  });

  it('serve_stale: throws once the snapshot is older than REVOCATION_MAX_STALENESS_SECS', async () => {
    mockConfig.revocationFailMode = 'serve_stale';
    mockConfig.revocationMaxStalenessSecs = 300;
    await revocationProducer.getEnvelopeJson();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 301_000);
    dbShouldThrow = true;
    await expect(revocationProducer.getEnvelopeJson()).rejects.toBeInstanceOf(
      RevocationUnavailableError,
    );
  });

  it('serve_stale: the bound is clamped to the list TTL so an expired envelope is never served', async () => {
    mockConfig.revocationFailMode = 'serve_stale';
    mockConfig.revocationMaxStalenessSecs = 100_000;
    mockConfig.revocationListTtlSecs = 200;
    await revocationProducer.getEnvelopeJson();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 201_000);
    dbShouldThrow = true;
    await expect(revocationProducer.getEnvelopeJson()).rejects.toBeInstanceOf(
      RevocationUnavailableError,
    );
  });

  it('serve_stale: throws when no good read has ever happened (no snapshot to serve)', async () => {
    mockConfig.revocationFailMode = 'serve_stale';
    dbShouldThrow = true;
    await expect(revocationProducer.getEnvelopeJson()).rejects.toBeInstanceOf(
      RevocationUnavailableError,
    );
    expect(signCalls.length).toBe(0);
  });

  it('serve_stale: invalidate() drops the fallback — a snapshot known to omit a new revocation is not served', async () => {
    mockConfig.revocationFailMode = 'serve_stale';
    await revocationProducer.getEnvelopeJson();
    revocationProducer.invalidate(); // a revocation was just committed
    dbShouldThrow = true;
    await expect(revocationProducer.getEnvelopeJson()).rejects.toBeInstanceOf(
      RevocationUnavailableError,
    );
  });

  it('a recovered DB is picked up: failure does not poison later reads', async () => {
    dbShouldThrow = true;
    await expect(revocationProducer.getEnvelopeJson()).rejects.toBeInstanceOf(
      RevocationUnavailableError,
    );
    dbShouldThrow = false;
    expect(await revocationProducer.getEnvelopeJson()).toBe('envelope-1');
  });

  // THE PIN ON THE FAILURE LOG TEXT. `scripts/verify-image.mjs` asserts this
  // substring is ABSENT from a healthy container's logs. Fail-closed now turns a
  // broken database into a 503 that the harness's status check catches first, but
  // the grep stays as the second line of defence (serve_stale mode still answers
  // 200 on a failed read). Reword here only together with that harness.
  it('logs an error containing the substring verify-image.mjs greps for, carrying err', async () => {
    dbShouldThrow = true;
    await revocationProducer.getEnvelopeJson().catch(() => undefined);
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0].msg).toContain(HARNESS_GREPPED_WARNING);
    expect(errorCalls[0].obj).toHaveProperty('err');
  });

  it('logs NO such message on the healthy path', async () => {
    rowsToReturn = [];
    await revocationProducer.getEnvelopeJson();
    const all = [...warnCalls, ...errorCalls];
    expect(all.filter((c) => c.msg.includes(HARNESS_GREPPED_WARNING))).toEqual([]);
  });
});
