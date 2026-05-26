/**
 * Integration coverage for the retention sweep against a real Postgres.
 *
 * Verifies:
 *   - audit events past the default TTL are deleted
 *   - terminal webhook deliveries past TTL are deleted; pending ones survive
 *   - deregistered agents past the grace window are deleted
 *   - admin-audit rows past TTL are deleted
 *   - the transaction-scoped advisory lock serializes parallel sweeps
 *     (exactly one runs, the other observes 'skipped')
 *
 * The defaults are used as-is (we can't change them after config is
 * frozen at import). Each test inserts rows old enough to pass the
 * defaults: audit_events > 90d, deliveries > 14d, admin_audit > 365d,
 * deregistered agents > 30d.
 */

import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, pool } from './db';
import {
  adminAuditLog,
  agents,
  auditEvents,
  webhookDeliveries,
  webhooks,
} from './db/schema';
import { runRetentionSweep } from './retention';

const ONE_DAY = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * ONE_DAY).toISOString();
}

describe('integration: retention sweep', () => {
  const probeAid = `did:test:retention-${randomUUID()}`;
  const otherAid = `did:test:retention-${randomUUID()}`;

  afterAll(async () => {
    await db
      .delete(agents)
      .where(sql`${agents.aid} in (${probeAid}, ${otherAid})`);
    await pool.end();
  });

  it('purges audit events older than the default TTL (90 days)', async () => {
    const oldId = randomUUID();
    const freshId = randomUUID();
    await db.insert(auditEvents).values([
      {
        id: oldId,
        type: 'test.retention.old',
        ts: isoDaysAgo(100),
        payload: {},
      },
      {
        id: freshId,
        type: 'test.retention.fresh',
        ts: isoDaysAgo(1),
        payload: {},
      },
    ]);

    const result = await runRetentionSweep();
    expect(result.status).toBe('completed');

    const remaining = await db
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.id} in (${oldId}, ${freshId})`);
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain(oldId);
    expect(ids).toContain(freshId);

    await db.delete(auditEvents).where(sql`${auditEvents.id} = ${freshId}`);
  });

  it('purges terminal webhook deliveries past TTL but keeps pending ones', async () => {
    const webhookId = randomUUID();
    await db.insert(webhooks).values({
      id: webhookId,
      url: 'http://test.invalid/retention',
      events: [],
      secret: 'test-secret',
      active: false,
    });

    const oldDelivered = randomUUID();
    const oldPending = randomUUID();
    await db.insert(webhookDeliveries).values([
      {
        id: oldDelivered,
        webhookId,
        eventType: 'test.retention',
        payload: {},
        status: 'delivered',
        createdAt: isoDaysAgo(30),
      },
      {
        id: oldPending,
        webhookId,
        eventType: 'test.retention',
        payload: {},
        status: 'pending',
        createdAt: isoDaysAgo(30),
      },
    ]);

    await runRetentionSweep();

    const remaining = await db
      .select()
      .from(webhookDeliveries)
      .where(
        sql`${webhookDeliveries.id} in (${oldDelivered}, ${oldPending})`,
      );
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain(oldDelivered);
    expect(ids).toContain(oldPending);

    await db
      .delete(webhookDeliveries)
      .where(sql`${webhookDeliveries.id} = ${oldPending}`);
    await db.delete(webhooks).where(sql`${webhooks.id} = ${webhookId}`);
  });

  it('purges deregistered agents past the 30-day grace window', async () => {
    await db.insert(agents).values([
      {
        aid: probeAid,
        displayName: 'retention-probe-old',
        handshakeEndpoint: 'http://test.invalid',
        offeredCaps: [],
        manifestJson: '{}',
        status: 'deregistered',
        registeredAt: isoDaysAgo(60),
        lastSeenAt: isoDaysAgo(60),
      },
      {
        aid: otherAid,
        displayName: 'retention-probe-fresh',
        handshakeEndpoint: 'http://test.invalid',
        offeredCaps: [],
        manifestJson: '{}',
        status: 'deregistered',
        registeredAt: isoDaysAgo(1),
        lastSeenAt: isoDaysAgo(1),
      },
    ]);

    await runRetentionSweep();

    const remaining = await db
      .select()
      .from(agents)
      .where(sql`${agents.aid} in (${probeAid}, ${otherAid})`);
    const aids = remaining.map((r) => r.aid);
    expect(aids).not.toContain(probeAid);
    expect(aids).toContain(otherAid);
  });

  it('admin audit purge respects the 365-day TTL', async () => {
    const oldId = randomUUID();
    await db.insert(adminAuditLog).values({
      id: oldId,
      action: 'test.retention',
      createdAt: isoDaysAgo(400),
    });
    await runRetentionSweep();
    const remaining = await db
      .select()
      .from(adminAuditLog)
      .where(sql`${adminAuditLog.id} = ${oldId}`);
    expect(remaining.length).toBe(0);
  });

  it('skips when another transaction holds the advisory lock', async () => {
    // The retention lock key — must match RETENTION_LOCK_KEY in
    // retention.ts. Hardcoded here so the test doesn't import it from
    // the module under test (then mocking would mask drift).
    const LOCK_KEY = '4694481020131148800'; // 0x4149_5450_5245_5400 as decimal

    // Acquire the lock from a separately-held connection. While we
    // hold it, a sweep must return 'skipped'. On rollback the lock
    // releases and the next sweep can run.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY]);

      const blocked = await runRetentionSweep();
      expect(blocked.status).toBe('skipped');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // With the lock released, the sweep proceeds normally.
    const unblocked = await runRetentionSweep();
    expect(unblocked.status).toBe('completed');
  });
});
