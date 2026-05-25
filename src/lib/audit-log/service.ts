import { desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { adminAuditLog, type AdminAuditRow } from '../db/schema';

export interface AdminAuditEntry {
  action: string;
  actorId?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  requestId?: string;
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
    // Audit logging must never break the calling request path.
    console.warn('[admin-audit] insert failed:', err);
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
