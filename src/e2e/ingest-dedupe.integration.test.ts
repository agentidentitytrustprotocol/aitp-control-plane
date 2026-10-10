/**
 * Integration (real Postgres): POST /api/events de-duplication (content-derived
 * event ids, recipe v1 — src/lib/audit/event-id.ts).
 *
 * The playground flushes a run's log mid-run and posts the WHOLE log again at
 * the end (a prefix, then a superset). Before content-derived ids every
 * re-sent event became a second history row and a second webhook delivery.
 * Pins that:
 *   - prefix batch then superset => each event exactly once in history;
 *   - exactly one webhook_deliveries row for a webhook-subscribed event type;
 *   - the session projection is unchanged by the re-send;
 *   - `inserted` / `duplicates` report it; `ingested` keeps counting accepted items;
 *   - a different bearer token is a different producer: its identical event is
 *     stored separately;
 *   - events without a ts keep random ids (two identical ones are both kept).
 */

import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { POST as eventsPost } from '@/app/api/events/route';
import { createWebhook } from '@/lib/webhooks/service';
import { getEventsDuplicateTotal } from '@/lib/audit/ingest-metrics';
import { db, pool } from '@/lib/db';
import {
  auditEvents,
  handshakeSessions,
  webhookDeliveries,
  webhooks,
} from '@/lib/db/schema';

const RUN_ID = `ingest-dedupe-${randomUUID()}`;
const SESSION = randomUUID();
const AID_A = `aid:test:dedupe-a-${RUN_ID}`;
const AID_B = `aid:test:dedupe-b-${RUN_ID}`;
const createdWebhookIds: string[] = [];

function post(events: unknown[], token = 'dedupe-producer-one'): Promise<Response> {
  return eventsPost(
    new NextRequest('http://localhost/api/events', {
      method: 'POST',
      body: JSON.stringify({ events }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    }),
  );
}

async function historyRows() {
  return db
    .select({ id: auditEvents.id, type: auditEvents.type })
    .from(auditEvents)
    .where(eq(auditEvents.runId, RUN_ID));
}

describe('integration: POST /api/events de-duplicates re-sent events', () => {
  const base = Date.now() - 60_000;
  const iso = (offsetMs: number) => new Date(base + offsetMs).toISOString();
  const started = {
    type: 'handshake.started',
    ts: iso(0),
    aid_a: AID_A,
    aid_b: AID_B,
    session_id: SESSION,
    run_id: RUN_ID,
    payload: { boundary: 'intra-org' },
  };
  const complete = {
    type: 'handshake.complete',
    ts: iso(1_000),
    aid_a: AID_A,
    aid_b: AID_B,
    session_id: SESSION,
    run_id: RUN_ID,
    grants: ['demo.echo'],
    payload: { boundary: 'intra-org' },
  };
  const invoked = {
    type: 'capability.invoked',
    ts: iso(2_000),
    aid_a: AID_A,
    aid_b: AID_B,
    session_id: SESSION,
    run_id: RUN_ID,
    payload: { capability: 'demo.echo' },
  };
  let subscriberId: string;

  beforeAll(async () => {
    const subscriber = await createWebhook({
      url: `http://aitp-dedupe-${randomUUID()}.invalid/hook`,
      events: ['handshake.complete'],
      secret: `dedupe-secret-${randomUUID()}`,
    });
    subscriberId = subscriber.id;
    createdWebhookIds.push(subscriber.id);
  });

  afterAll(async () => {
    if (createdWebhookIds.length > 0) {
      await db.delete(webhooks).where(inArray(webhooks.id, createdWebhookIds));
    }
    await db.delete(auditEvents).where(eq(auditEvents.runId, RUN_ID));
    await db.delete(handshakeSessions).where(eq(handshakeSessions.sessionId, SESSION));
    await pool.end();
  });

  async function sessionRow() {
    const [row] = await db
      .select()
      .from(handshakeSessions)
      .where(eq(handshakeSessions.sessionId, SESSION));
    return row;
  }

  async function deliveriesForSession() {
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, subscriberId));
    return rows.filter((r) => (r.payload as { sessionId?: string }).sessionId === SESSION);
  }

  it('prefix batch then superset: each event once, one webhook delivery, projection unchanged', async () => {
    const first = await post([started, complete]);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ingested: 2,
      dropped: 0,
      errors: [],
      inserted: 2,
      duplicates: 0,
    });
    const projectionBefore = await sessionRow();
    expect(projectionBefore).toMatchObject({ status: 'complete', grants: ['demo.echo'] });
    expect(await deliveriesForSession()).toHaveLength(1);

    const dupBefore = getEventsDuplicateTotal();
    // Superset with re-ordered keys on the re-sent items: still duplicates.
    const reordered = Object.fromEntries(Object.entries(complete).reverse());
    const second = await post([started, reordered, invoked]);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ingested: 3,
      dropped: 0,
      errors: [],
      inserted: 1,
      duplicates: 2,
    });
    expect(getEventsDuplicateTotal()).toBe(dupBefore + 2);

    const rows = await historyRows();
    expect(rows.map((r) => r.type).sort()).toEqual([
      'capability.invoked',
      'handshake.complete',
      'handshake.started',
    ]);
    expect(await deliveriesForSession()).toHaveLength(1);
    // The projections re-run for duplicates (idempotent; that is what repairs a
    // projection that failed the first time), so only `updatedAt` may move.
    const { updatedAt: _before, ...projectedBefore } = projectionBefore;
    const { updatedAt: _after, ...projectedAfter } = await sessionRow();
    expect(projectedAfter).toEqual(projectedBefore);
  });

  it('a different bearer token is a different producer: its identical event is stored too', async () => {
    const before = (await historyRows()).length;
    const res = await post([invoked], 'dedupe-producer-two');
    expect(await res.json()).toMatchObject({ ingested: 1, inserted: 1, duplicates: 0 });
    const rows = await historyRows();
    expect(rows).toHaveLength(before + 1);
    expect(rows.filter((r) => r.type === 'capability.invoked')).toHaveLength(2);
  });

  it('events without a ts keep random ids: two identical ones are both kept, a re-send adds more', async () => {
    const tick = { type: 'dedupe.tick', run_id: RUN_ID, payload: { n: 1 } };
    expect(await (await post([tick, tick])).json()).toMatchObject({ inserted: 2, duplicates: 0 });
    expect(await (await post([tick])).json()).toMatchObject({ inserted: 1, duplicates: 0 });
    const ticks = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, RUN_ID), eq(auditEvents.type, 'dedupe.tick')));
    expect(ticks).toHaveLength(3);
  });

  it('stores content-derived ids as RFC 9562 version-8 UUIDs', async () => {
    const [row] = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.runId, RUN_ID), eq(auditEvents.type, 'handshake.started')),
      );
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(eq(auditEvents.id, row.id));
    expect(n).toBe(1);
  });
});
