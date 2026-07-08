// Unit tests for POST /api/events — the batched telemetry ingest sink.
//
// Verifies:
//   • envelope handling: `{events:[...]}` and bare-array bodies both work,
//     non-object entries are silently dropped
//   • normalization: snake_case aliases (aid_a / session_id / playground.run_id),
//     numeric-seconds timestamps, type/source defaults, payload passthrough
//   • rejection paths: non-JSON body (400), >500-event batches (413),
//     >64KB per-event payloads (413 naming the offending type), >256KB bodies
//     (413), malformed Idempotency-Key (400)
//   • fan-out: eventBus.publish + session/tct monitors per event, last-seen
//     touch with the union of AIDs, webhook dispatch with the active list —
//     and graceful degradation when listing webhooks fails.
//
// All downstream services and @/lib/db are mocked; no Postgres needed.

import { jest } from '@jest/globals';
import type { AuditEventRecord } from '@/lib/audit/stream';

const ingestEventsMock = jest.fn(async (_e: AuditEventRecord[]) => undefined);
const publishMock = jest.fn();
const sessionOnEventMock = jest.fn(async (_e: unknown) => undefined);
const tctOnEventMock = jest.fn(async (_e: unknown) => undefined);
const touchLastSeenBatchMock = jest.fn(async (_aids: string[]) => undefined);
const listActiveWebhooksMock = jest.fn(async () => [] as unknown[]);
const dispatchMock = jest.fn(async (_e: unknown, _list: unknown) => undefined);

jest.mock('@/lib/db', () => ({ db: {} }));
jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock('@/lib/audit/event-store', () => ({
  ingestEvents: (e: unknown) => ingestEventsMock(e as AuditEventRecord[]),
}));
jest.mock('@/lib/audit/stream', () => ({
  eventBus: { publish: (e: unknown) => publishMock(e) },
}));
jest.mock('@/lib/sessions/monitor', () => ({
  sessionMonitor: { onEvent: (e: unknown) => sessionOnEventMock(e) },
}));
jest.mock('@/lib/tcts/monitor', () => ({
  tctMonitor: { onEvent: (e: unknown) => tctOnEventMock(e) },
}));
jest.mock('@/lib/registry/store', () => ({
  touchLastSeenBatch: (aids: string[]) => touchLastSeenBatchMock(aids),
}));
jest.mock('@/lib/webhooks/service', () => ({
  listActiveWebhooks: () => listActiveWebhooksMock(),
  dispatchWebhooksWithList: (e: unknown, list: unknown) =>
    dispatchMock(e, list),
  startWebhookReaper: jest.fn(),
}));
jest.mock('@/lib/registry/expiry-job', () => ({ startExpiryJob: jest.fn() }));
jest.mock('@/lib/retention', () => ({ startRetentionJob: jest.fn() }));

import { POST } from './route';
import { NextRequest } from 'next/server';

function makeReq(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    new Request('http://localhost:4000/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
  );
}

beforeEach(() => {
  ingestEventsMock.mockReset();
  ingestEventsMock.mockResolvedValue(undefined);
  publishMock.mockReset();
  sessionOnEventMock.mockReset();
  sessionOnEventMock.mockResolvedValue(undefined);
  tctOnEventMock.mockReset();
  tctOnEventMock.mockResolvedValue(undefined);
  touchLastSeenBatchMock.mockReset();
  touchLastSeenBatchMock.mockResolvedValue(undefined);
  listActiveWebhooksMock.mockReset();
  listActiveWebhooksMock.mockResolvedValue([]);
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(undefined);
});

describe('POST /api/events — body validation', () => {
  it('returns 400 BODY_INVALID for a non-JSON body', async () => {
    const res = await POST(makeReq('not json {'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BODY_INVALID');
    expect(ingestEventsMock).not.toHaveBeenCalled();
  });

  it('returns 413 when the batch exceeds 500 events', async () => {
    const events = Array.from({ length: 501 }, () => ({ type: 't' }));
    const res = await POST(makeReq(JSON.stringify({ events })));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error).toContain('500');
    expect(ingestEventsMock).not.toHaveBeenCalled();
  });

  it('returns 413 naming the event type when one payload exceeds 64KB', async () => {
    const events = [
      { type: 'small.ok', payload: { a: 1 } },
      { type: 'big.one', payload: { blob: 'x'.repeat(70_000) } },
    ];
    const res = await POST(makeReq(JSON.stringify({ events })));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; eventType: string };
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.eventType).toBe('big.one');
    expect(ingestEventsMock).not.toHaveBeenCalled();
  });

  it('returns 413 for a request body over the 256KB ceiling', async () => {
    const huge = JSON.stringify({
      events: [{ type: 'a', payload: { b: 'y'.repeat(300 * 1024) } }],
    });
    const res = await POST(makeReq(huge));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(ingestEventsMock).not.toHaveBeenCalled();
  });

  it('returns 400 IDEMPOTENCY_KEY_INVALID for a blank Idempotency-Key header', async () => {
    const res = await POST(
      makeReq(JSON.stringify({ events: [{ type: 't' }] }), {
        'idempotency-key': '   ',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(ingestEventsMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/events — envelope shapes and normalization', () => {
  it('accepts {events:[...]} and normalizes snake_case + numeric ts', async () => {
    const res = await POST(
      makeReq(
        JSON.stringify({
          events: [
            {
              type: 'handshake.complete',
              ts: 1_700_000_000, // seconds — must be scaled to ms
              aid_a: 'aid:pubkey:A',
              aid_b: 'aid:pubkey:B',
              session_id: 'sess-1',
              playground: { run_id: 'run-9' },
              grants: ['demo.echo'],
              payload: { foo: 'bar' },
            },
          ],
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { ingested: number }).toEqual({ ingested: 1 });

    expect(ingestEventsMock).toHaveBeenCalledTimes(1);
    const rec = ingestEventsMock.mock.calls[0][0][0];
    expect(rec.type).toBe('handshake.complete');
    expect(rec.ts).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(rec.aidA).toBe('aid:pubkey:A');
    expect(rec.aidB).toBe('aid:pubkey:B');
    expect(rec.sessionId).toBe('sess-1');
    expect(rec.runId).toBe('run-9');
    expect(rec.grants).toEqual(['demo.echo']);
    expect(rec.payload).toEqual({ foo: 'bar' }); // passed through verbatim
    expect(rec.source).toBe('playground'); // default
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/i); // server-assigned UUID
  });

  it('accepts a bare top-level array body', async () => {
    const res = await POST(makeReq(JSON.stringify([{ type: 'x' }])));
    expect(res.status).toBe(200);
    expect((await res.json()) as { ingested: number }).toEqual({ ingested: 1 });
  });

  it('silently drops non-object entries', async () => {
    const res = await POST(
      makeReq(JSON.stringify({ events: [null, 'str', 42, { type: 'ok' }] })),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { ingested: number }).toEqual({ ingested: 1 });
    expect(ingestEventsMock.mock.calls[0][0]).toHaveLength(1);
  });

  it('defaults type to "unknown" and uses the raw object as payload when payload is absent', async () => {
    await POST(makeReq(JSON.stringify({ events: [{ foo: 1 }] })));
    const rec = ingestEventsMock.mock.calls[0][0][0];
    expect(rec.type).toBe('unknown');
    expect(rec.payload).toEqual({ foo: 1 });
    expect(Number.isNaN(new Date(rec.ts).getTime())).toBe(false);
  });

  it('ingests an empty batch as {ingested: 0}', async () => {
    const res = await POST(makeReq(JSON.stringify({ events: [] })));
    expect(res.status).toBe(200);
    expect((await res.json()) as { ingested: number }).toEqual({ ingested: 0 });
    expect(touchLastSeenBatchMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/events — fan-out', () => {
  it('publishes each event, notifies monitors, touches last-seen, dispatches webhooks', async () => {
    listActiveWebhooksMock.mockResolvedValue([{ id: 'wh1' }]);
    await POST(
      makeReq(
        JSON.stringify({
          events: [
            { type: 'a', aidA: 'aid:pubkey:A', aidB: 'aid:pubkey:B' },
            { type: 'b', aidA: 'aid:pubkey:B', aidB: 'aid:pubkey:C' },
          ],
        }),
      ),
    );
    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(sessionOnEventMock).toHaveBeenCalledTimes(2);
    expect(tctOnEventMock).toHaveBeenCalledTimes(2);

    expect(touchLastSeenBatchMock).toHaveBeenCalledTimes(1);
    const touched = [...touchLastSeenBatchMock.mock.calls[0][0]].sort();
    expect(touched).toEqual(['aid:pubkey:A', 'aid:pubkey:B', 'aid:pubkey:C']);

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock.mock.calls[0][1]).toEqual([{ id: 'wh1' }]);
  });

  it('still returns 200 when listing webhooks fails; dispatch gets an empty list', async () => {
    listActiveWebhooksMock.mockRejectedValue(new Error('db blew up'));
    const res = await POST(makeReq(JSON.stringify({ events: [{ type: 'a' }] })));
    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0][1]).toEqual([]);
  });
});
