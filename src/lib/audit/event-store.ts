import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import { auditEvents, type AuditEventRow } from '../db/schema';
import type { AuditEventRecord } from './stream';

function toRow(record: AuditEventRecord) {
  return {
    id: record.id,
    type: record.type,
    ts: record.ts,
    aidA: record.aidA ?? null,
    aidB: record.aidB ?? null,
    sessionId: record.sessionId ?? null,
    runId: record.runId ?? null,
    grants: record.grants ?? null,
    payload: record.payload,
    source: record.source ?? null,
  };
}

export async function ingestOneEvent(
  record: AuditEventRecord,
): Promise<void> {
  await db.insert(auditEvents).values(toRow(record)).onConflictDoNothing();
}

/**
 * Insert a batch in ONE multi-row INSERT and return the ids of the rows that
 * were actually written. A record whose id already exists (a re-sent event
 * under the content-derived id recipe, src/lib/audit/event-id.ts) is skipped
 * by `ON CONFLICT DO NOTHING` and is absent from the result — `RETURNING`
 * yields only inserted rows. With several replicas the primary key decides:
 * exactly one concurrent insert of an id gets it back.
 */
export async function ingestEvents(
  records: AuditEventRecord[],
): Promise<string[]> {
  if (records.length === 0) return [];
  const rows = await db
    .insert(auditEvents)
    .values(records.map(toRow))
    .onConflictDoNothing()
    .returning({ id: auditEvents.id });
  return rows.map((r) => r.id);
}

export interface HistoryFilters {
  type?: string;
  aid?: string;
  sessionId?: string;
  runId?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

function parseIsoOrThrow(name: string, raw: string): string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidFilterError(
      `${name} must be a parseable date string (ISO-8601 recommended); got ${JSON.stringify(raw)}`,
    );
  }
  return parsed.toISOString();
}

export class InvalidFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFilterError';
  }
}

export async function queryHistory(
  filters: HistoryFilters,
): Promise<AuditEventRow[]> {
  const where = [];
  if (filters.type) where.push(eq(auditEvents.type, filters.type));
  if (filters.sessionId) where.push(eq(auditEvents.sessionId, filters.sessionId));
  if (filters.runId) where.push(eq(auditEvents.runId, filters.runId));
  if (filters.aid) {
    where.push(
      sql`(${auditEvents.aidA} = ${filters.aid} OR ${auditEvents.aidB} = ${filters.aid})`,
    );
  }
  if (filters.since) {
    where.push(gte(auditEvents.ts, parseIsoOrThrow('since', filters.since)));
  }
  if (filters.until) {
    where.push(lte(auditEvents.ts, parseIsoOrThrow('until', filters.until)));
  }

  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
  const offset = Math.max(filters.offset ?? 0, 0);

  const baseQuery = db.select().from(auditEvents);
  const filtered = where.length > 0 ? baseQuery.where(and(...where)) : baseQuery;
  return filtered.orderBy(desc(auditEvents.ts)).limit(limit).offset(offset);
}
