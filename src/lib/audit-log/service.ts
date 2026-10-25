import { desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { adminAuditLog, type AdminAuditRow } from '../db/schema';
import { logger } from '../logger';

export interface AdminAuditEntry {
  action: string;
  actorId?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  requestId?: string;
  /** Recorded as `details.client_ip` when present (see auditContext). */
  clientIp?: string;
}

// Failures here never abort the caller (audit must not gate the request
// path), but silent loss is dangerous — surface a counter on /api/metrics
// so operators notice if the audit trail is degrading.
//
// On `globalThis`, not module scope: Next gives instrumentation.ts and the
// routes separate instances of this module, and the boot-started webhook
// reaper (instrumentation's instance) writes `webhook.unsubscribed` rows.
// A module-level counter there would be one /api/metrics never reads.
declare global {
  // eslint-disable-next-line no-var
  var __adminAuditInsertFailures: number | undefined;
}

export function getAdminAuditInsertFailures(): number {
  return globalThis.__adminAuditInsertFailures ?? 0;
}

export async function writeAdminAudit(entry: AdminAuditEntry): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      id: randomUUID(),
      action: entry.action,
      actorId: entry.actorId ?? null,
      targetId: entry.targetId ?? null,
      details: entry.clientIp
        ? { ...(entry.details ?? {}), client_ip: entry.clientIp }
        : (entry.details ?? {}),
      requestId: entry.requestId ?? null,
    });
  } catch (err) {
    globalThis.__adminAuditInsertFailures = getAdminAuditInsertFailures() + 1;
    logger.warn({ err, action: entry.action }, 'admin-audit insert failed');
  }
}

export async function listAdminAudit(
  limit = 100,
  offset = 0,
): Promise<AdminAuditRow[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 1000);
  const safeOffset = Math.max(offset, 0);
  return db
    .select()
    .from(adminAuditLog)
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(safeLimit)
    .offset(safeOffset);
}
