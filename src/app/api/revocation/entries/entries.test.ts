// Unit tests for POST /api/revocation/entries.
//   • validation — non-JSON body, non-UUID jti (JTI_INVALID), non-string
//     reason, reason > 500 chars, unparseable revokedAt
//   • range      — revokedAt must land in years 0001-9999 (#98). Expanded-year
//     and negative-year inputs are 400 BODY_INVALID, as are offsets that push a
//     legal-looking year out of range; both exact boundaries are accepted.
//   • charset    — reason may not contain U+0000, which neither `text` nor the
//     `jsonb` event payload can store (#98); newlines and lone surrogates stay
//     legal.
//   • failure    — a database fault PROPAGATES (so the framework renders the
//     500 and the Postgres message cannot reach the body) and is logged.
//   • no leak    — no 4xx body carries Postgres vocabulary (#98 regression).
//   • success    — 201 with {jti, revokedAt, reason}, revokedAt normalized
//     to ISO, producer cache invalidated, tct.revoked event ingested +
//     published + webhooks dispatched
//
// All persistence/side-effect modules are mocked; no Idempotency-Key header
// is sent so withIdempotency runs the handler directly.

import { jest } from '@jest/globals';

const insertedValues: unknown[] = [];
let insertError: unknown = null;

jest.mock('@/lib/db', () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        insertedValues.push(v);
        return {
          onConflictDoNothing: () =>
            insertError ? Promise.reject(insertError) : Promise.resolve(),
        };
      },
    }),
  },
}));

const invalidateMock = jest.fn();
jest.mock('@/lib/revocation/producer', () => ({
  revocationProducer: { invalidate: () => invalidateMock() },
}));

const ingestOneEventMock = jest.fn(async (_e: unknown) => undefined);
const eventBusPublishMock = jest.fn();
const dispatchWebhooksMock = jest.fn(async (_e: unknown) => undefined);
const writeAdminAuditMock = jest.fn(async (_e: unknown) => undefined);
const tctMonitorOnEventMock = jest.fn(async (_e: unknown) => undefined);

jest.mock('@/lib/audit/event-store', () => ({
  ingestOneEvent: (e: unknown) => ingestOneEventMock(e),
}));
jest.mock('@/lib/audit/stream', () => ({
  eventBus: { publish: (e: unknown) => eventBusPublishMock(e) },
}));
jest.mock('@/lib/webhooks/service', () => ({
  dispatchWebhooks: (e: unknown) => dispatchWebhooksMock(e),
}));
jest.mock('@/lib/audit-log/service', () => ({
  writeAdminAudit: (e: unknown) => writeAdminAuditMock(e),
}));
jest.mock('@/lib/tcts/monitor', () => ({
  tctMonitor: { onEvent: (e: unknown) => tctMonitorOnEventMock(e) },
}));

const loggerErrorMock = jest.fn();
const loggerWarnMock = jest.fn();
jest.mock('@/lib/logger', () => ({
  logger: {
    error: (...a: unknown[]) => loggerErrorMock(...a),
    warn: (...a: unknown[]) => loggerWarnMock(...a),
  },
}));

import { POST } from './route';
import { NextRequest } from 'next/server';

const GOOD_JTI = '3f1d2c4b-1a2b-4c3d-8e4f-5a6b7c8d9e0f';

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest(
      new Request('http://localhost:4000/api/revocation/entries', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    ),
  );
}

beforeEach(() => {
  insertedValues.length = 0;
  insertError = null;
  invalidateMock.mockReset();
  ingestOneEventMock.mockReset();
  ingestOneEventMock.mockResolvedValue(undefined);
  eventBusPublishMock.mockReset();
  dispatchWebhooksMock.mockReset();
  dispatchWebhooksMock.mockResolvedValue(undefined);
  writeAdminAuditMock.mockReset();
  writeAdminAuditMock.mockResolvedValue(undefined);
  tctMonitorOnEventMock.mockReset();
  tctMonitorOnEventMock.mockResolvedValue(undefined);
  loggerErrorMock.mockReset();
  loggerWarnMock.mockReset();
});

describe('POST /api/revocation/entries — validation', () => {
  it('returns 400 BODY_INVALID for a non-JSON body', async () => {
    const res = await post('not json');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
  });

  it('returns 400 JTI_INVALID when jti is missing or not a UUID', async () => {
    for (const jti of [undefined, 'not-a-uuid', 12345, GOOD_JTI + 'x']) {
      const res = await post({ jti });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('JTI_INVALID');
    }
    expect(insertedValues).toHaveLength(0);
  });

  it('rejects a non-string reason', async () => {
    const res = await post({ jti: GOOD_JTI, reason: { nested: true } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'reason must be a string',
    );
  });

  it('rejects a reason longer than 500 characters', async () => {
    const res = await post({ jti: GOOD_JTI, reason: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/500 character/);
  });

  it('rejects an unparseable revokedAt', async () => {
    const res = await post({ jti: GOOD_JTI, revokedAt: 'yesterday-ish' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
  });
});

describe('POST /api/revocation/entries — success path', () => {
  it('returns 201, normalizes revokedAt to ISO, and fires all side effects', async () => {
    const res = await post({
      jti: GOOD_JTI,
      reason: 'key compromised',
      revokedAt: '2026-06-15T10:00:00Z',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      jti: string;
      revokedAt: string;
      reason: string;
    };
    expect(body).toEqual({
      jti: GOOD_JTI,
      revokedAt: '2026-06-15T10:00:00.000Z',
      reason: 'key compromised',
    });

    expect(invalidateMock).toHaveBeenCalledTimes(1);
    expect(ingestOneEventMock).toHaveBeenCalledTimes(1);
    expect(eventBusPublishMock).toHaveBeenCalledTimes(1);
    expect(tctMonitorOnEventMock).toHaveBeenCalledTimes(1);
    expect(dispatchWebhooksMock).toHaveBeenCalledTimes(1);
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);

    const event = eventBusPublishMock.mock.calls[0][0] as {
      type: string;
      ts: string;
      payload: Record<string, unknown>;
    };
    expect(event.type).toBe('tct.revoked');
    expect(event.ts).toBe('2026-06-15T10:00:00.000Z');
    expect(event.payload).toEqual({ jti: GOOD_JTI, reason: 'key compromised' });
  });

  it('defaults revokedAt to now and reason to null when omitted', async () => {
    const before = Date.now();
    const res = await post({ jti: GOOD_JTI });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { revokedAt: string; reason: null };
    expect(body.reason).toBeNull();
    const ts = new Date(body.revokedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });
});

// U+0000 built rather than written, so no raw control byte ever sits in this
// source file. A raw NUL here would be invisible in a diff and would silently
// degrade to the empty string if any tool in the chain dropped it — and
// `'anything'.includes('')` is true, which would make the guard under test look
// like it passed while actually rejecting every request.
const NUL = String.fromCharCode(0);
// Unpaired high surrogate. Legal in a JS string and in JSON, and NOT an error
// for Postgres: Node's UTF-8 encoder substitutes U+FFFD before the driver sends
// it. Here to pin that the NUL guard stays narrow.
const LONE_SURROGATE = String.fromCharCode(0xd800);

describe('POST /api/revocation/entries — revokedAt range (#98)', () => {
  // `new Date()` accepts years to +/-275760, but `toISOString()` then emits an
  // expanded year (`+010000-…`) that Postgres cannot parse — so these all used
  // to pass validation and fail in the database, which answered 500 with the
  // Postgres message in the body.
  it('rejects a revokedAt outside years 0001-9999 without touching the database', async () => {
    const outOfRange = [
      '+010000-01-01T00:00:00Z',
      '-000001-01-01T00:00:00Z',
      '0000-01-01T00:00:00Z',
      new Date(8640000000000000).toISOString(),
      new Date(-8640000000000000).toISOString(),
    ];
    for (const revokedAt of outOfRange) {
      const res = await post({ jti: GOOD_JTI, revokedAt });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('BODY_INVALID');
      expect(body.error).toMatch(/years 0001-9999/);
    }
    // Never reached the insert: the point of the fix is that these are decided
    // from the request body, not by the database.
    expect(insertedValues).toHaveLength(0);
  });

  // The bound is on the UTC instant, not on the digits in the string. A naive
  // "does the year have four digits" reimplementation would wrongly accept both
  // of these.
  it('rejects a UTC instant out of range even when the written year looks legal', async () => {
    for (const revokedAt of [
      '0001-01-01T00:00:00+01:00', // UTC year 0000
      '9999-12-31T23:59:59.999-01:00', // UTC year 10000
    ]) {
      const res = await post({ jti: GOOD_JTI, revokedAt });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
    }
    expect(insertedValues).toHaveLength(0);
  });

  it('accepts both exact boundaries', async () => {
    for (const revokedAt of ['0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
      const res = await post({ jti: GOOD_JTI, revokedAt });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { revokedAt: string }).revokedAt).toBe(revokedAt);
    }
    expect(insertedValues).toHaveLength(2);
  });

  // V8 truncates sub-millisecond digits rather than rounding, so this cannot
  // carry into year 10000.
  it('accepts a sub-millisecond value at the upper boundary', async () => {
    const res = await post({ jti: GOOD_JTI, revokedAt: '9999-12-31T23:59:59.9995Z' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { revokedAt: string }).revokedAt).toBe(
      '9999-12-31T23:59:59.999Z',
    );
  });

  // LOAD-BEARING, not decoration. The route's guard is written as
  // `!(ms >= MIN && ms <= MAX)` so that a NaN bound rejects everything rather
  // than accepting everything; these two numbers are what a live Postgres was
  // measured to accept at the extremes, and this is the only place they are
  // written down as numbers. If someone "simplifies" the bound, this fails.
  it('pins the measured Postgres boundary in milliseconds', () => {
    expect(Date.parse('0001-01-01T00:00:00.000Z')).toBe(-62135596800000);
    expect(Date.parse('9999-12-31T23:59:59.999Z')).toBe(253402300799999);
  });
});

describe('POST /api/revocation/entries — reason charset (#98)', () => {
  // `text` rejects the byte (22021) and so does the jsonb event payload (22P05).
  // The harness's JSON.stringify emits the escape form, which is the only way a
  // caller can get one past the body parse.
  it('rejects a reason containing U+0000 without touching the database', async () => {
    const res = await post({ jti: GOOD_JTI, reason: `a${NUL}b` });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('BODY_INVALID');
    expect(body.error).toMatch(/NUL/);
    expect(insertedValues).toHaveLength(0);
  });

  // Pins the guard as NARROW. Unlike idempotency keys, operator prose may carry
  // a newline or a tab, and a lone surrogate is harmless. Widening the guard to
  // all control characters must be a deliberate, test-breaking act.
  it('accepts a reason with newlines, tabs and a lone surrogate', async () => {
    const reason = `line one\nline\ttwo ${LONE_SURROGATE}`;
    const res = await post({ jti: GOOD_JTI, reason });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { reason: string }).reason).toBe(reason);
    expect(insertedValues).toHaveLength(1);
  });
});

describe('POST /api/revocation/entries — database fault (#98)', () => {
  // Previously this answered `500 INSERT_FAILED` with err.message in the body.
  // Now it propagates, so the framework renders the 500 and there is no body for
  // the Postgres message to travel in — a structural guarantee, not a redaction.
  it('propagates a database fault instead of answering with its message', async () => {
    const dbError = Object.assign(
      new Error('relation "revocation_entries" does not exist'),
      { code: '42P01' },
    );
    insertError = dbError;
    await expect(post({ jti: GOOD_JTI })).rejects.toThrow(dbError);
  });

  it('skips every side effect when the insert fails', async () => {
    insertError = new Error('connection refused');
    await expect(post({ jti: GOOD_JTI })).rejects.toThrow();
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(ingestOneEventMock).not.toHaveBeenCalled();
    expect(eventBusPublishMock).not.toHaveBeenCalled();
    expect(tctMonitorOnEventMock).not.toHaveBeenCalled();
    expect(dispatchWebhooksMock).not.toHaveBeenCalled();
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  // The response body was the only record of this failure before; the log is
  // what replaces it. Nothing else captures it — there is no onRequestError hook
  // — so dropping this line would trade a leak for silence.
  it('logs the fault through the structured logger, with the jti', async () => {
    insertError = new Error('connection refused');
    await expect(post({ jti: GOOD_JTI })).rejects.toThrow();
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [fields, msg] = loggerErrorMock.mock.calls[0] as [
      { err: unknown; jti: string },
      string,
    ];
    expect(fields.err).toBe(insertError);
    expect(fields.jti).toBe(GOOD_JTI);
    expect(msg).toMatch(/insert failed/);
  });
});

describe('POST /api/revocation/entries — no internal detail in any body (#98)', () => {
  // Stated as a property over Postgres VOCABULARY rather than against the one
  // message this bug happened to leak, so it also catches a future rejection
  // that starts echoing a different database error.
  const PG_TELLS = [
    'relation ',
    'invalid input syntax',
    'revocation_entries',
    'timestamp with time zone',
    'byte sequence',
    'UTF8',
    'INSERT_FAILED',
  ];

  it('never echoes Postgres vocabulary in a rejection body', async () => {
    const rejections: unknown[] = [
      'not json',
      { jti: 'not-a-uuid' },
      { jti: GOOD_JTI, revokedAt: '+010000-01-01T00:00:00Z' },
      { jti: GOOD_JTI, revokedAt: '-000001-01-01T00:00:00Z' },
      { jti: GOOD_JTI, revokedAt: 'yesterday-ish' },
      { jti: GOOD_JTI, reason: `a${NUL}b` },
      { jti: GOOD_JTI, reason: 'x'.repeat(501) },
      { jti: GOOD_JTI, reason: { nested: true } },
    ];
    for (const body of rejections) {
      const res = await post(body);
      expect(res.status).toBe(400);
      const text = await res.text();
      for (const tell of PG_TELLS) {
        expect(text).not.toContain(tell);
      }
    }
  });
});
