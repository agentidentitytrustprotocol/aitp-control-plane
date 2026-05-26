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
}

// Failures here never abort the caller (audit must not gate the request
// path), but silent loss is dangerous — surface a counter on /api/metrics
// so operators notice if the audit trail is degrading.
let adminAuditInsertFailures = 0;

export function getAdminAuditInsertFailures(): number {
  return adminAuditInsertFailures;
}

export async function writeAdminAudit(entry: AdminAuditEntry): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      id: randomUUID(),
      action: entry.action,
      actorId: entry.actorId ?? null,
      targetId: entry.targetId ?? null,
      details: entry.details ?? {},
      requestId: entry.requestId ?? null,
    });
  } catch (err) {
    adminAuditInsertFailures += 1;
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
