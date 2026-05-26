/**
 * Data retention sweep.
 *
 * Periodically deletes:
 *   - audit_events older than AUDIT_EVENTS_TTL_DAYS
 *   - webhook_deliveries in terminal states (delivered / failed)
 *     older than WEBHOOK_DELIVERY_TTL_DAYS
 *   - admin_audit_log older than ADMIN_AUDIT_TTL_DAYS
 *   - idempotency_keys older than IDEMPOTENCY_KEY_TTL_DAYS
 *   - agents with status='deregistered' older than the grace window
 *     (status='expired' rows are left in place — operators may want to
 *     re-enroll them; only operator-deregistered agents are GC'd)
 *
 * Multi-instance safe via `pg_try_advisory_xact_lock` taken inside a
 * single transaction. The whole sweep runs on one pool connection so
 * the lock acquire and release see the same session. Auto-released
 * when the transaction commits or rolls back.
 *
 * Why transaction-scoped (not session-scoped):
 *   `pg_try_advisory_lock` is per-session and survives transactions,
 *   but a Drizzle `db.execute()` call goes through the connection pool
 *   — there's no guarantee the unlock runs on the same connection that
 *   acquired the lock. Using the `xact` variant + a transaction binds
 *   both calls to one connection without manual client checkout.
 */

import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from './db';
import {
  adminAuditLog,
  agents,
  auditEvents,
  idempotencyKeys,
  webhookDeliveries,
} from './db/schema';
import { config } from './config';
import { logger } from './logger';

// Arbitrary bigint stable across deployments. Documented here so future
// advisory-lock callers don't collide. Embedded as a SQL literal (not a
// parameter) to avoid any driver-level bigint encoding ambiguity.
//
//   0x4149_5450_5245_5400 = 4_694_481_020_131_148_800 (decimal)
//   bytes spell 'AITPRET\0' (handy when grepping pg_locks output)
const RETENTION_LOCK_KEY_SQL = sql.raw('4694481020131148800');
export const RETENTION_LOCK_KEY = 4_694_481_020_131_148_800n;

export interface SweepResult {
  status: 'completed' | 'skipped' | 'disabled';
  auditEventsDeleted: number;
  webhookDeliveriesDeleted: number;
  adminAuditDeleted: number;
  agentsDeleted: number;
  idempotencyKeysDeleted: number;
  durationMs: number;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// `Tx` is the same query API as `db` but bound to one connection inside
// the transaction. We keep this minimally typed to avoid the deep
// generic spread Drizzle exposes.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function purgeAuditEvents(tx: Tx, limit: number): Promise<number> {
  if (config.auditEventsTtlDays <= 0) return 0;
  const cutoff = daysAgoIso(config.auditEventsTtlDays);
  const deleted = await tx.execute(sql`
    delete from ${auditEvents}
    where id in (
      select id from ${auditEvents}
      where ${auditEvents.ts} < ${cutoff}
      limit ${limit}
    )
  `);
  return (deleted as unknown as { rowCount?: number }).rowCount ?? 0;
}

async function purgeWebhookDeliveries(tx: Tx, limit: number): Promise<number> {
  if (config.webhookDeliveryTtlDays <= 0) return 0;
  const cutoff = daysAgoIso(config.webhookDeliveryTtlDays);
  const deleted = await tx.execute(sql`
    delete from ${webhookDeliveries}
    where id in (
      select id from ${webhookDeliveries}
      where ${webhookDeliveries.status} in ('delivered', 'failed')
        and ${webhookDeliveries.createdAt} < ${cutoff}
      limit ${limit}
    )
  `);
  return (deleted as unknown as { rowCount?: number }).rowCount ?? 0;
}

async function purgeAdminAudit(tx: Tx, limit: number): Promise<number> {
  if (config.adminAuditTtlDays <= 0) return 0;
  const cutoff = daysAgoIso(config.adminAuditTtlDays);
  const deleted = await tx.execute(sql`
    delete from ${adminAuditLog}
    where id in (
      select id from ${adminAuditLog}
      where ${adminAuditLog.createdAt} < ${cutoff}
      limit ${limit}
    )
  `);
  return (deleted as unknown as { rowCount?: number }).rowCount ?? 0;
}

async function purgeIdempotencyKeys(tx: Tx, limit: number): Promise<number> {
  if (config.idempotencyKeyTtlDays <= 0) return 0;
  const cutoff = daysAgoIso(config.idempotencyKeyTtlDays);
  const deleted = await tx.execute(sql`
    delete from ${idempotencyKeys}
    where (scope, key) in (
      select scope, key from ${idempotencyKeys}
      where ${idempotencyKeys.createdAt} < ${cutoff}
      limit ${limit}
    )
  `);
  return (deleted as unknown as { rowCount?: number }).rowCount ?? 0;
}

async function purgeDeregisteredAgents(tx: Tx): Promise<number> {
  if (config.expiredAgentGraceDays <= 0) return 0;
  const cutoff = daysAgoIso(config.expiredAgentGraceDays);
  const result = await tx
    .delete(agents)
    .where(
      and(
        eq(agents.status, 'deregistered'),
        or(
          and(
            isNotNull(agents.lastSeenAt),
            lt(agents.lastSeenAt, cutoff),
          ),
          and(
            sql`${agents.lastSeenAt} is null`,
            lt(agents.registeredAt, cutoff),
          ),
        ),
      ),
    )
    .returning({ aid: agents.aid });
  return result.length;
}

const SKIPPED: Omit<SweepResult, 'durationMs'> = {
  status: 'skipped',
  auditEventsDeleted: 0,
  webhookDeliveriesDeleted: 0,
  adminAuditDeleted: 0,
  agentsDeleted: 0,
  idempotencyKeysDeleted: 0,
};

const DISABLED: Omit<SweepResult, 'durationMs'> = {
  ...SKIPPED,
  status: 'disabled',
};

/** Run the full sweep. Returns counts. Safe to call multiple times in
 * parallel — only the lock-holder does work; others return 'skipped'. */
export async function runRetentionSweep(): Promise<SweepResult> {
  const t0 = Date.now();
  if (!config.retentionEnabled) {
    return { ...DISABLED, durationMs: 0 };
  }

  const limit = config.retentionBatchLimit;

  const counts = await db.transaction(async (tx) => {
    const lockRes = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${RETENTION_LOCK_KEY_SQL}::bigint) as got`,
    );
    const got =
      (lockRes as unknown as { rows: { got: boolean }[] }).rows[0]?.got ??
      false;
    if (!got) return null;

    // Sequential, not Promise.all — drizzle tx is single-connection so
    // parallel queries on the same tx are unsupported. Sweep runs every
    // 30 minutes by default; the serial cost is irrelevant.
    const auditEventsDeleted = await purgeAuditEvents(tx, limit);
    const webhookDeliveriesDeleted = await purgeWebhookDeliveries(tx, limit);
    const adminAuditDeleted = await purgeAdminAudit(tx, limit);
    const agentsDeleted = await purgeDeregisteredAgents(tx);
    const idempotencyKeysDeleted = await purgeIdempotencyKeys(tx, limit);
    return {
      auditEventsDeleted,
      webhookDeliveriesDeleted,
      adminAuditDeleted,
      agentsDeleted,
      idempotencyKeysDeleted,
    };
  });

  const durationMs = Date.now() - t0;
  if (counts === null) {
    logger.debug('retention sweep skipped — another instance holds the lock');
    return { ...SKIPPED, durationMs };
  }

  const total =
    counts.auditEventsDeleted +
    counts.webhookDeliveriesDeleted +
    counts.adminAuditDeleted +
    counts.agentsDeleted +
    counts.idempotencyKeysDeleted;
  if (total > 0) {
    logger.info({ ...counts, durationMs }, 'retention sweep complete');
  }
  return { status: 'completed', ...counts, durationMs };
}

declare global {
  // eslint-disable-next-line no-var
  var __retentionInterval: ReturnType<typeof setInterval> | undefined;
}

/** Idempotent — safe to call from hot route handlers. */
export function startRetentionJob(): void {
  if (globalThis.__retentionInterval) return;
  if (!config.retentionEnabled) return;
  void runRetentionSweep().catch((err) =>
    logger.warn({ err }, 'retention initial sweep failed'),
  );
  globalThis.__retentionInterval = setInterval(() => {
    runRetentionSweep().catch((err) =>
      logger.warn({ err }, 'retention sweep failed'),
    );
  }, config.retentionIntervalMs);
  globalThis.__retentionInterval.unref?.();
}
