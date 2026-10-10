/**
 * Integration (real Postgres): POST /api/events per-item validation.
 *
 * The batch is ONE multi-row INSERT, so before per-item validation a single
 * unstorable item (a session_id over varchar(255), U+0000 in the payload)
 * failed the whole request with a 500 and lost every good event with it.
 * Pins that the bad item is now dropped and reported while the good events
 * are persisted — and that an Idempotency-Key replay returns the same report.
 * Also pins the lone-surrogate drop (jsonb rejects the `\ud800` escape that
 * JSON.stringify writes), that a non-array-`events` 400 is stored and replayed
 * under an Idempotency-Key, and that a replay does not re-count
 * `events_dropped_total`.
 */

import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

import { POST as eventsPost } from '@/app/api/events/route';
import { db, pool } from '@/lib/db';
import { auditEvents, handshakeSessions, idempotencyKeys } from '@/lib/db/schema';
import { ingestEvents } from '@/lib/audit/event-store';
import { getEventsDroppedTotal } from '@/lib/audit/ingest-metrics';

const RUN_ID = `events-drop-${randomUUID()}`;
const goodSessions = [randomUUID(), randomUUID()];

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return eventsPost(
    new NextRequest('http://localhost/api/events', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    }),
  );
}

describe('integration: POST /api/events drops unstorable items, keeps the rest', () => {
  const idemKey = randomUUID();
  const surrogateKey = randomUUID();
  const badArrayKey = randomUUID();

  afterAll(async () => {
    await db.delete(auditEvents).where(eq(auditEvents.runId, RUN_ID));
    await db
      .delete(handshakeSessions)
      .where(inArray(handshakeSessions.sessionId, goodSessions));
    await db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, 'events.ingest'),
          inArray(idempotencyKeys.key, [idemKey, surrogateKey, badArrayKey]),
        ),
      );
    await pool.end();
  });

  it('a 300-char session_id and a NUL payload are dropped; good events persist', async () => {
    const body = {
      events: [
        { type: 'p4.test.good', run_id: RUN_ID, session_id: goodSessions[0] },
        { type: 'p4.test.bad', run_id: RUN_ID, session_id: 's'.repeat(300) },
        { type: 'p4.test.bad', run_id: RUN_ID, payload: { msg: 'boom\u0000' } },
        { type: 'p4.test.good', run_id: RUN_ID, session_id: goodSessions[1], ts: 1e20 },
      ],
    };
    const res = await post(body, { 'idempotency-key': idemKey });
    expect(res.status).toBe(200);
    const expected = {
      ingested: 2,
      dropped: 2,
      errors: [
        { index: 1, field: 'sessionId', reason: 'sessionId exceeds 255 character limit' },
        { index: 2, field: 'payload', reason: 'payload contains a NUL character' },
      ],
    };
    expect(await res.json()).toEqual(expected);

    const rows = await db
      .select({ type: auditEvents.type, sessionId: auditEvents.sessionId })
      .from(auditEvents)
      .where(eq(auditEvents.runId, RUN_ID));
    expect(rows.map((r) => r.type)).toEqual(['p4.test.good', 'p4.test.good']);
    expect(rows.map((r) => r.sessionId).sort()).toEqual([...goodSessions].sort());

    // Replay: same report (persisted through jsonb), handler not re-run.
    const replay = await post(body, { 'idempotency-key': idemKey });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await replay.json()).toEqual(expected);
    const after = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.runId, RUN_ID));
    expect(after).toHaveLength(2);
  });

  it('Postgres jsonb really rejects a lone surrogate (why the route must drop it)', async () => {
    await expect(
      ingestEvents([
        {
          id: randomUUID(),
          type: 'p4.test.raw',
          ts: new Date().toISOString(),
          runId: RUN_ID,
          payload: { msg: 'x\ud800' },
          source: 'test',
        },
      ]),
    ).rejects.toThrow();
  });

  it('a lone surrogate in a payload value, a payload key, grants or a flat event is dropped; good events persist', async () => {
    const body = {
      events: [
        { type: 'p4.surrogate.good', run_id: RUN_ID, payload: { emoji: '\u{1F600}' } },
        { type: 'p4.surrogate.bad', run_id: RUN_ID, payload: { msg: 'x\ud800' } },
        { type: 'p4.surrogate.bad', run_id: RUN_ID, payload: { ['k\udc00']: 1 } },
        { type: 'p4.surrogate.bad', run_id: RUN_ID, grants: ['g\ud800'], payload: {} },
        { type: 'p4.surrogate.bad', run_id: RUN_ID, note: 'flat\udfff' },
        { type: 'p4.surrogate.good', run_id: RUN_ID, grants: ['g.\u{1F680}'], note: 'flat ok' },
      ],
    };
    const droppedBefore = getEventsDroppedTotal();
    const res = await post(body, { 'idempotency-key': surrogateKey });
    expect(res.status).toBe(200);
    const lone = (field: string) => `${field} contains a lone UTF-16 surrogate`;
    const expected = {
      ingested: 2,
      dropped: 4,
      errors: [
        { index: 1, field: 'payload', reason: lone('payload') },
        { index: 2, field: 'payload', reason: lone('payload') },
        { index: 3, field: 'grants', reason: lone('grants') },
        { index: 4, field: 'payload', reason: lone('payload') },
      ],
    };
    expect(await res.json()).toEqual(expected);
    expect(getEventsDroppedTotal()).toBe(droppedBefore + 4);

    const rows = await db
      .select({ type: auditEvents.type, payload: auditEvents.payload, grants: auditEvents.grants })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, RUN_ID), eq(auditEvents.type, 'p4.surrogate.good')));
    expect(rows).toHaveLength(2);
    // Well-formed astral characters round-trip through jsonb intact.
    expect(rows.map((r) => (r.payload as { emoji?: string }).emoji)).toContain('\u{1F600}');
    expect(rows.map((r) => r.grants)).toContainEqual(['g.\u{1F680}']);

    // Replay: same report, handler not re-run, the drop metric not re-counted.
    const replay = await post(body, { 'idempotency-key': surrogateKey });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await replay.json()).toEqual(expected);
    expect(getEventsDroppedTotal()).toBe(droppedBefore + 4);
    const after = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, RUN_ID), eq(auditEvents.type, 'p4.surrogate.good')));
    expect(after).toHaveLength(2);
  });

  it('a non-array `events` 400 is stored under the Idempotency-Key and replayed', async () => {
    const body = { events: { length: 501 } };
    const res = await post(body, { 'idempotency-key': badArrayKey });
    expect(res.status).toBe(400);
    expect(res.headers.get('Idempotency-Replayed')).toBeNull();
    const expected = { error: 'events must be an array', code: 'BODY_INVALID' };
    expect(await res.json()).toEqual(expected);

    const stored = await db
      .select({ status: idempotencyKeys.responseStatus, body: idempotencyKeys.responseBody })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, 'events.ingest'), eq(idempotencyKeys.key, badArrayKey)));
    expect(stored).toEqual([{ status: 400, body: expected }]);

    // Even a now-valid body replays the stored 400: the key, not the body, is
    // what is matched.
    const replay = await post(
      { events: [{ type: 'p4.test.never', run_id: RUN_ID }] },
      { 'idempotency-key': badArrayKey },
    );
    expect(replay.status).toBe(400);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await replay.json()).toEqual(expected);
    const never = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, RUN_ID), eq(auditEvents.type, 'p4.test.never')));
    expect(never).toHaveLength(0);
  });
});
