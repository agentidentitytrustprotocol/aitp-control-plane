// Unit tests for POST /api/revocation/entries.
//   • validation — non-JSON body, non-UUID jti (JTI_INVALID), non-string
//     reason, reason > 500 chars, unparseable revokedAt
//   • success    — 201 with {jti, revokedAt, reason}, revokedAt normalized
//     to ISO, producer cache invalidated, tct.revoked event ingested +
//     published + webhooks dispatched
//   • failure    — insert error surfaces as 500 INSERT_FAILED
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

describe('POST /api/revocation/entries — insert failure', () => {
  it('returns 500 INSERT_FAILED and skips side effects', async () => {
    insertError = new Error('connection refused');
    const res = await post({ jti: GOOD_JTI });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INSERT_FAILED');
    expect(body.error).toBe('connection refused');
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(eventBusPublishMock).not.toHaveBeenCalled();
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });
});
