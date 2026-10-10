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
//   • per-item validation (#P4): `events` not an array -> 400; an item over a
//     column limit, holding U+0000 (or a lone surrogate in payload/grants),
//     or with a payload nested too deep is
//     dropped and reported in `dropped` / `errors[]` while the rest ingest;
//     out-of-range `ts` falls back to ingest time
//   • de-duplication (#P5): content-derived ids (recipe v1) — same raw event
//     + same bearer token + valid ts => same id across requests; key order
//     irrelevant; ts-less events keep random ids; in-batch duplicates
//     collapsed; events the store did not insert still reach the monitors but
//     are NOT published or dispatched; `inserted` / `duplicates` reported
//   • fan-out: eventBus.publish + session/tct monitors per event, last-seen
//     touch with the union of AIDs, webhook dispatch with the active list —
//     and graceful degradation when listing webhooks fails.
//
// All downstream services and @/lib/db are mocked; no Postgres needed.

import { jest } from '@jest/globals';
import type { AuditEventRecord } from '@/lib/audit/stream';

// Default: the store inserts every record it is handed (returns all ids).
const ingestEventsMock = jest.fn(async (e: AuditEventRecord[]) => e.map((r) => r.id));
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
  ingestEventsMock.mockImplementation(async (e: AuditEventRecord[]) => e.map((r) => r.id));
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
    expect(await res.json()).toEqual({ ingested: 1, dropped: 0, errors: [], inserted: 1, duplicates: 0 });

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
    expect(await res.json()).toEqual({ ingested: 1, dropped: 0, errors: [], inserted: 1, duplicates: 0 });
  });

  it('silently drops non-object entries', async () => {
    const res = await POST(
      makeReq(JSON.stringify({ events: [null, 'str', 42, { type: 'ok' }] })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 1, dropped: 0, errors: [], inserted: 1, duplicates: 0 });
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
    expect(await res.json()).toEqual({ ingested: 0, dropped: 0, errors: [], inserted: 0, duplicates: 0 });
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

type IngestBody = {
  ingested: number;
  dropped: number;
  errors: Array<{ index: number; field: string; reason: string }>;
  inserted: number;
  duplicates: number;
};

describe('POST /api/events — `events` must be an array', () => {
  it.each([
    ['a string', '"x"'],
    ['a number', '5'],
    ['an object', '{"a":1}'],
    ['an array-like object', '{"length":501}'],
    ['a string longer than 500 chars', JSON.stringify('x'.repeat(600))],
    ['true', 'true'],
  ])('answers 400 BODY_INVALID when events is %s (not 413, not 500)', async (_label, value) => {
    const res = await POST(makeReq(`{"events":${value}}`));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('BODY_INVALID');
    expect(body.error).toBe('events must be an array');
    expect(ingestEventsMock).not.toHaveBeenCalled();
  });

  it.each([
    ['events: null', '{"events":null}'],
    ['no events key', '{}'],
    ['a top-level string', '"hello"'],
    ['a top-level number', '42'],
    ['top-level null', 'null'],
  ])('keeps answering 200 {ingested: 0} for %s', async (_label, raw) => {
    const res = await POST(makeReq(raw));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 0, dropped: 0, errors: [], inserted: 0, duplicates: 0 });
  });
});

describe('POST /api/events — per-item drop', () => {
  const limits: Array<[string, string, number]> = [
    ['type', 'type', 128],
    ['aidA', 'aidA', 512],
    ['aid_b', 'aidB', 512],
    ['session_id', 'sessionId', 255],
    ['runId', 'runId', 255],
    ['source', 'source', 128],
  ];

  it.each(limits)(
    'drops an item whose %s exceeds %s\'s %i-code-point limit; keeps the rest',
    async (wireKey, field, max) => {
      const events = [
        { type: 'good.0' },
        { type: 'bad', [wireKey]: 'x'.repeat(max + 1) },
        { type: 'good.2' },
      ];
      const res = await POST(makeReq(JSON.stringify({ events })));
      expect(res.status).toBe(200);
      const body = (await res.json()) as IngestBody;
      expect(body.ingested).toBe(2);
      expect(body.dropped).toBe(1);
      expect(body.errors).toEqual([
        { index: 1, field, reason: `${field} exceeds ${max} character limit` },
      ]);
      const stored = ingestEventsMock.mock.calls[0][0].map((e) => e.type);
      expect(stored).toEqual(['good.0', 'good.2']);
    },
  );

  it.each(limits)('accepts %s at exactly the limit (counting code points)', async (wireKey, _f, max) => {
    // Astral characters: 2 UTF-16 units each, 1 code point — must still fit.
    const atLimit = wireKey === 'type' ? '\u{1F600}'.repeat(max) : 'y'.repeat(max);
    const res = await POST(
      makeReq(JSON.stringify({ events: [{ type: 't', [wireKey]: atLimit }] })),
    );
    expect(((await res.json()) as IngestBody).dropped).toBe(0);
  });

  it.each(limits)('drops an item with a NUL in %s', async (wireKey, field) => {
    const res = await POST(
      makeReq(JSON.stringify({ events: [{ type: 't', [wireKey]: 'a\u0000b' }] })),
    );
    const body = (await res.json()) as IngestBody;
    expect(body).toEqual({
      ingested: 0,
      dropped: 1,
      errors: [{ index: 0, field, reason: `${field} must not contain a NUL character` }],
      inserted: 0,
      duplicates: 0,
    });
  });

  it.each([
    ['a payload string value', { payload: { a: { b: ['ok', 'bad\u0000'] } } }],
    ['a payload key', { payload: { nested: { ['k\u0000']: 1 } } }],
    ['a flat event (the event itself is the payload)', { error: 'trace\u0000' }],
  ])('drops only the item with a NUL in %s', async (_label, bad) => {
    const res = await POST(
      makeReq(JSON.stringify({ events: [{ type: 'ok.0' }, { type: 'bad', ...bad }, { type: 'ok.2' }] })),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as IngestBody;
    expect(body).toEqual({
      ingested: 2,
      dropped: 1,
      errors: [{ index: 1, field: 'payload', reason: 'payload contains a NUL character' }],
      inserted: 2,
      duplicates: 0,
    });
    // The reason never echoes caller content.
    expect(JSON.stringify(body)).not.toContain('\\u0000');
  });

  it('drops an item with a NUL in a grant', async () => {
    const res = await POST(
      makeReq(JSON.stringify({ events: [{ type: 't', grants: ['ok', 'b\u0000'] }] })),
    );
    expect(((await res.json()) as IngestBody).errors).toEqual([
      { index: 0, field: 'grants', reason: 'grants contains a NUL character' },
    ]);
  });

  // A lone UTF-16 surrogate survives JSON.parse (the wire carries it as the
  // escape `\ud800`), and JSON.stringify — how the jsonb parameter is sent —
  // writes the same escape back, which Postgres jsonb rejects ("invalid input
  // syntax for type json"). Unlike a text column, there is no U+FFFD
  // substitution on that path, so the item must be dropped before the INSERT.
  it.each([
    ['a payload string value', { payload: { msg: 'x\ud800y' } }],
    ['a payload key', { payload: { ['k\udfff']: 1 } }],
    ['a deeply nested payload value', { payload: { a: [{ b: { c: ['ok', '\udc00'] } }] } }],
    ['a trailing high surrogate', { payload: { msg: 'end\ud83d' } }],
    ['a flat event (the event itself is the payload)', { error: 'trace\ud800' }],
    ['a flat event text field (aidA is also stored in the payload)', { aidA: 'aid:\ud800' }],
  ])('drops only the item with a lone surrogate in %s', async (_label, bad) => {
    const res = await POST(
      makeReq(JSON.stringify({ events: [{ type: 'ok.0' }, { type: 'bad', ...bad }, { type: 'ok.2' }] })),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as IngestBody;
    expect(body).toEqual({
      ingested: 2,
      dropped: 1,
      errors: [{ index: 1, field: 'payload', reason: 'payload contains a lone UTF-16 surrogate' }],
      inserted: 2,
      duplicates: 0,
    });
    expect(ingestEventsMock.mock.calls[0][0].map((e) => e.type)).toEqual(['ok.0', 'ok.2']);
  });

  it('drops an item with a lone surrogate in a grant', async () => {
    const res = await POST(
      makeReq(
        JSON.stringify({ events: [{ type: 't', grants: ['ok', 'b\ud800'], payload: {} }] }),
      ),
    );
    expect(((await res.json()) as IngestBody).errors).toEqual([
      { index: 0, field: 'grants', reason: 'grants contains a lone UTF-16 surrogate' },
    ]);
  });

  it('reports NUL over a lone surrogate when a payload has both', async () => {
    const res = await POST(
      makeReq(JSON.stringify({ events: [{ type: 't', payload: { a: '\ud800', b: '\u0000' } }] })),
    );
    expect(((await res.json()) as IngestBody).errors).toEqual([
      { index: 0, field: 'payload', reason: 'payload contains a NUL character' },
    ]);
  });

  it('keeps well-formed astral characters (surrogate PAIRS) in keys, values and grants', async () => {
    const res = await POST(
      makeReq(
        JSON.stringify({
          events: [
            {
              type: 't',
              grants: ['g.\u{1F600}'],
              payload: { ['k\u{1F680}']: ['\u{10FFFF}', { s: '😀' }] },
            },
            { type: 'flat', note: '\u{1F4A9}' },
          ],
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2, dropped: 0, errors: [], inserted: 2, duplicates: 0 });
  });

  it('reports indices into the ORIGINAL array (non-objects counted) and preserves order', async () => {
    const events = [
      null,
      { type: 'keep.1' },
      'str',
      { type: 'x'.repeat(200) },
      { type: 'keep.4' },
      42,
      { type: 'n', session_id: 's'.repeat(300) },
      { type: 'keep.7' },
    ];
    const res = await POST(makeReq(JSON.stringify({ events })));
    const body = (await res.json()) as IngestBody;
    expect(body.ingested).toBe(3);
    expect(body.dropped).toBe(2);
    expect(body.errors.map((e) => [e.index, e.field])).toEqual([
      [3, 'type'],
      [6, 'sessionId'],
    ]);
    expect(ingestEventsMock.mock.calls[0][0].map((e) => e.type)).toEqual([
      'keep.1',
      'keep.4',
      'keep.7',
    ]);
    // Only kept events reach the fan-out.
    expect(publishMock).toHaveBeenCalledTimes(3);
    expect(sessionOnEventMock).toHaveBeenCalledTimes(3);
    expect(dispatchMock).toHaveBeenCalledTimes(3);
  });

  it('answers 200 with ingested 0 when every item is dropped, and touches nothing', async () => {
    const events = Array.from({ length: 30 }, () => ({ type: 'z'.repeat(129) }));
    const res = await POST(makeReq(JSON.stringify({ events })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as IngestBody;
    expect(body.ingested).toBe(0);
    expect(body.dropped).toBe(30);
    // errors[] is capped at 20; dropped is the full count.
    expect(body.errors).toHaveLength(20);
    expect(body.errors[19].index).toBe(19);
    expect(publishMock).not.toHaveBeenCalled();
    expect(touchLastSeenBatchMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('logs counts only (no payload content) and counts drops in the metric', async () => {
    const { logger } = jest.requireMock('@/lib/logger') as {
      logger: { warn: jest.Mock };
    };
    logger.warn.mockClear();
    const { getEventsDroppedTotal } = jest.requireActual(
      '@/lib/audit/ingest-metrics',
    ) as typeof import('@/lib/audit/ingest-metrics');
    const before = getEventsDroppedTotal();
    await POST(
      makeReq(
        JSON.stringify({ events: [{ type: 'ok' }, { type: 't', payload: { secret: 'SEKRIT\u0000' } }] }),
      ),
    );
    expect(getEventsDroppedTotal()).toBe(before + 1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toEqual({ received: 2, ingested: 1, dropped: 1 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SEKRIT');
  });

  it('drops a ~120k-level nested payload as too deep without throwing', async () => {
    const depth = 120_000;
    const raw = `{"events":[{"type":"ok"},{"type":"deep","payload":${'['.repeat(depth)}${']'.repeat(depth)}}]}`;
    expect(raw.length).toBeLessThan(256 * 1024); // under the request-body cap
    const res = await POST(makeReq(raw));
    expect(res.status).toBe(200);
    const body = (await res.json()) as IngestBody;
    expect(body.ingested).toBe(1);
    expect(body.dropped).toBe(1);
    expect(body.errors[0]).toMatchObject({ index: 1, field: 'payload' });
    expect(body.errors[0].reason).toContain('too deep');
  });

  it('accepts a payload nested exactly 64 levels; drops 65', async () => {
    const nest = (n: number) => `${'['.repeat(n)}${']'.repeat(n)}`;
    const res = await POST(
      makeReq(
        `{"events":[{"type":"a","payload":${nest(64)}},{"type":"b","payload":${nest(65)}}]}`,
      ),
    );
    const body = (await res.json()) as IngestBody;
    expect(body.ingested).toBe(1);
    expect(body.errors.map((e) => e.index)).toEqual([1]);
  });

  it('reports too deep even when the item also has a NUL (deep payload never reaches JSON.stringify)', async () => {
    const depth = 100_000;
    const raw = `{"events":[{"type":"t\\u0000","payload":${'['.repeat(depth)}"\\u0000"${']'.repeat(depth)}}]}`;
    const res = await POST(makeReq(raw));
    expect(res.status).toBe(200);
    const body = (await res.json()) as IngestBody;
    expect(body.dropped).toBe(1);
    expect(body.errors[0].reason).toContain('too deep');
  });

  it('keeps the 64KB per-event 413 whole-batch even when that item would be dropped', async () => {
    const res = await POST(
      makeReq(
        JSON.stringify({
          events: [{ type: 'big', payload: { blob: 'x'.repeat(70_000), k: '\u0000' } }],
        }),
      ),
    );
    expect(res.status).toBe(413);
    expect(ingestEventsMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/events — out-of-range ts falls back to ingest time', () => {
  it.each([
    ['numeric ms beyond 8.64e15', 1e20],
    ['negative seconds beyond the range', -1e13],
    ['ISO year 10000', '+010000-01-01T00:00:00.000Z'],
    ['ms rendering in year 10000', Date.UTC(10000, 0, 1)],
    ['ISO year 0000', '0000-06-01T00:00:00.000Z'],
  ])('%s -> kept, ts = ingest time', async (_label, ts) => {
    const before = Date.now();
    const res = await POST(makeReq(JSON.stringify({ events: [{ type: 't', ts }] })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as IngestBody).ingested).toBe(1);
    const rec = ingestEventsMock.mock.calls[0][0][0];
    const got = new Date(rec.ts).getTime();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(Date.now());
  });

  it('keeps an in-range boundary ts (year 9999)', async () => {
    await POST(
      makeReq(JSON.stringify({ events: [{ type: 't', ts: '9999-12-31T23:59:59.999Z' }] })),
    );
    expect(ingestEventsMock.mock.calls[0][0][0].ts).toBe('9999-12-31T23:59:59.999Z');
  });
});

describe('POST /api/events — content-derived ids and de-duplication', () => {
  const V8_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const TOKEN = { authorization: 'Bearer key-one' };

  async function idsFor(events: unknown[], headers: Record<string, string> = TOKEN) {
    ingestEventsMock.mockClear();
    const res = await POST(makeReq(JSON.stringify({ events }), headers));
    expect(res.status).toBe(200);
    return ingestEventsMock.mock.calls[0][0].map((r) => r.id);
  }

  const ev = {
    type: 'handshake.complete',
    ts: '2026-10-01T12:00:00.123456Z',
    aid_a: 'aid:pubkey:A',
    session_id: 'sess-1',
    payload: { boundary: 'intra-org', nested: { b: 2, a: [1, { y: 1, x: 0 }] } },
  };

  it('gives the same raw event the same v8 id across requests', async () => {
    const [first] = await idsFor([ev]);
    const [second] = await idsFor([ev]);
    expect(first).toMatch(V8_UUID);
    expect(second).toBe(first);
  });

  it('ignores key order at every level', async () => {
    const [a] = await idsFor([ev]);
    const reordered = {
      payload: { nested: { a: [1, { x: 0, y: 1 }], b: 2 }, boundary: 'intra-org' },
      session_id: 'sess-1',
      aid_a: 'aid:pubkey:A',
      ts: '2026-10-01T12:00:00.123456Z',
      type: 'handshake.complete',
    };
    const [b] = await idsFor([reordered]);
    expect(b).toBe(a);
  });

  it('hashes the RAW event: sub-millisecond ts digits and array order matter', async () => {
    const [a] = await idsFor([ev]);
    const [b] = await idsFor([{ ...ev, ts: '2026-10-01T12:00:00.123999Z' }]);
    const [c] = await idsFor([{ ...ev, payload: { ...ev.payload, nested: { b: 2, a: [{ y: 1, x: 0 }, 1] } } }]);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('gives a different token a different id; Bearer and raw token forms agree', async () => {
    const [one] = await idsFor([ev], { authorization: 'Bearer key-one' });
    const [raw] = await idsFor([ev], { authorization: 'key-one' });
    const [two] = await idsFor([ev], { authorization: 'Bearer key-two' });
    const [none] = await idsFor([ev], {});
    expect(raw).toBe(one);
    expect(two).not.toBe(one);
    expect(none).not.toBe(one);
    expect(none).toMatch(V8_UUID);
  });

  it.each([
    ['no ts', {}],
    ['an unparseable ts', { ts: 'yesterday' }],
    ['an out-of-range ts', { ts: 1e20 }],
  ])('keeps random ids for events with %s (two identical events both kept)', async (_l, extra) => {
    const e = { type: 'tick', payload: { n: 1 }, ...extra };
    const ids = await idsFor([e, e]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).not.toMatch(V8_UUID);
    const [again] = await idsFor([e]);
    expect(ids).not.toContain(again);
  });

  it('collapses duplicates inside one batch (first wins) and counts them', async () => {
    const other = { ...ev, type: 'handshake.started' };
    const res = await POST(makeReq(JSON.stringify({ events: [ev, other, ev] }), TOKEN));
    expect(await res.json()).toEqual({
      ingested: 3,
      dropped: 0,
      errors: [],
      inserted: 2,
      duplicates: 1,
    });
    const stored = ingestEventsMock.mock.calls[0][0];
    expect(stored.map((r) => r.type)).toEqual(['handshake.complete', 'handshake.started']);
    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(sessionOnEventMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it('runs monitors but NOT publish/dispatch for events the store did not insert', async () => {
    listActiveWebhooksMock.mockResolvedValue([{ id: 'wh1' }]);
    ingestEventsMock.mockImplementation(async () => []);
    const { getEventsDuplicateTotal } = jest.requireActual(
      '@/lib/audit/ingest-metrics',
    ) as typeof import('@/lib/audit/ingest-metrics');
    const before = getEventsDuplicateTotal();
    const res = await POST(
      makeReq(JSON.stringify({ events: [ev, { ...ev, type: 'b' }] }), TOKEN),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ingested: 2,
      dropped: 0,
      errors: [],
      inserted: 0,
      duplicates: 2,
    });
    expect(publishMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(sessionOnEventMock).toHaveBeenCalledTimes(2);
    expect(tctOnEventMock).toHaveBeenCalledTimes(2);
    expect(getEventsDuplicateTotal()).toBe(before + 2);
  });

  it('fans out only the newly inserted subset of a partially stored batch', async () => {
    const second = { ...ev, type: 'second' };
    const [firstId] = await idsFor([ev]);
    publishMock.mockClear();
    dispatchMock.mockClear();
    sessionOnEventMock.mockClear();
    ingestEventsMock.mockImplementation(async (e: AuditEventRecord[]) =>
      e.map((r) => r.id).filter((id) => id !== firstId),
    );
    const res = await POST(makeReq(JSON.stringify({ events: [ev, second] }), TOKEN));
    const body = (await res.json()) as IngestBody;
    expect(body).toMatchObject({ ingested: 2, inserted: 1, duplicates: 1 });
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect((publishMock.mock.calls[0][0] as AuditEventRecord).type).toBe('second');
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect((dispatchMock.mock.calls[0][0] as AuditEventRecord).type).toBe('second');
    expect(sessionOnEventMock).toHaveBeenCalledTimes(2);
  });

  it('computes ids for a kept item even with a deeply nested sibling field (iterative hash)', async () => {
    const depth = 100_000;
    const raw = `{"events":[{"type":"t","ts":"2026-01-01T00:00:00Z","payload":{},"extra":${'['.repeat(depth)}${']'.repeat(depth)}}]}`;
    const res = await POST(makeReq(raw, TOKEN));
    expect(res.status).toBe(200);
    expect(((await res.json()) as IngestBody).inserted).toBe(1);
    expect(ingestEventsMock.mock.calls[0][0][0].id).toMatch(V8_UUID);
  });
});
