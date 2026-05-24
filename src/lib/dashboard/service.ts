import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  agents,
  auditEvents,
  handshakeSessions,
  webhookDeliveries,
} from '../db/schema';

export type Range = '1h' | '24h' | '7d' | '30d';

export interface DashboardOverview {
  range: Range;
  kpis: {
    agentsRegistered: number;
    handshakesTotal: number;
    handshakesInRange: number;
    handshakesSuccessInRange: number;
    capabilityInvocationsInRange: number;
    activeSessions: number;
    pendingWebhookDeliveries: number;
  };
  recentSessions: Array<{
    sessionId: string;
    aidA: string | null;
    aidB: string | null;
    status: string;
    grants: string[];
    boundary: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
  charts: {
    handshakesByBoundary: Array<{ boundary: string; count: number }>;
    handshakesOverTime: Array<{ bucket: string; count: number }>;
    topCapabilities: Array<{ capability: string; count: number }>;
  };
}

function rangeToHours(range: Range): number {
  switch (range) {
    case '1h':
      return 1;
    case '7d':
      return 168;
    case '30d':
      return 720;
    case '24h':
    default:
      return 24;
  }
}

// date_trunc() takes a hard-coded field name, not an interval, and we want
// to interpolate it as a literal (NOT a parameter) to avoid SQL injection.
// Restrict to the validated set.
type BucketField = 'minute' | 'hour' | 'day';
function bucketField(range: Range): BucketField {
  switch (range) {
    case '1h':
      return 'minute';
    case '7d':
    case '30d':
      return 'day';
    case '24h':
    default:
      return 'hour';
  }
}

export async function getDashboardOverview(
  range: Range = '24h',
): Promise<DashboardOverview> {
  const hours = rangeToHours(range);
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const trunc = bucketField(range);

  const [
    agentCount,
    totalHandshakes,
    handshakesInRangeRow,
    handshakesSuccessInRangeRow,
    activeSessionsRow,
    recentSessionRows,
    handshakesByBoundaryRows,
    capabilityInvocations,
    pendingDeliveries,
    timeBuckets,
    topCapabilities,
  ] = await Promise.all([
    db
      .select({ count: count() })
      .from(agents)
      .where(eq(agents.status, 'active')),
    db.select({ count: count() }).from(handshakeSessions),
    // KPI: total handshakes created in range, NOT capped to 20.
    db
      .select({ count: count() })
      .from(handshakeSessions)
      .where(gte(handshakeSessions.createdAt, since)),
    db
      .select({ count: count() })
      .from(handshakeSessions)
      .where(
        and(
          gte(handshakeSessions.createdAt, since),
          eq(handshakeSessions.status, 'complete'),
        ),
      ),
    db
      .select({ count: count() })
      .from(handshakeSessions)
      .where(
        and(
          gte(handshakeSessions.createdAt, since),
          eq(handshakeSessions.status, 'started'),
        ),
      ),
    // Display list — bounded for the UI's "recent" sidebar.
    db
      .select()
      .from(handshakeSessions)
      .where(gte(handshakeSessions.createdAt, since))
      .orderBy(desc(handshakeSessions.createdAt))
      .limit(20),
    db
      .select({
        boundary: handshakeSessions.boundary,
        count: count(),
      })
      .from(handshakeSessions)
      .groupBy(handshakeSessions.boundary),
    db
      .select({ count: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.type, 'capability.invoked'),
          gte(auditEvents.ts, since),
        ),
      ),
    db
      .select({ count: count() })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.status, 'pending')),
    // `trunc` is a hard-coded literal (minute|hour|day) chosen from a
    // closed set above, so sql.raw is safe here.
    db.execute<{ bucket: string; count: number }>(sql`
      SELECT date_trunc(${sql.raw(`'${trunc}'`)}, ts)::text AS bucket,
             count(*)::int AS count
      FROM audit_events
      WHERE type IN ('handshake.started', 'handshake.complete')
        AND ts >= ${since}
      GROUP BY 1
      ORDER BY 1
    `),
    db.execute<{ capability: string; count: number }>(sql`
      SELECT (payload->>'capability') AS capability,
             count(*)::int AS count
      FROM audit_events
      WHERE type = 'capability.invoked'
        AND payload ? 'capability'
        AND ts >= ${since}
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 10
    `),
  ]);

  const timeRows = (timeBuckets as { rows?: { bucket: string; count: number }[] })
    .rows ?? (timeBuckets as unknown as { bucket: string; count: number }[]);
  const capRows = (topCapabilities as { rows?: { capability: string; count: number }[] })
    .rows ?? (topCapabilities as unknown as { capability: string; count: number }[]);

  return {
    range,
    kpis: {
      agentsRegistered: agentCount[0]?.count ?? 0,
      handshakesTotal: totalHandshakes[0]?.count ?? 0,
      handshakesInRange: handshakesInRangeRow[0]?.count ?? 0,
      handshakesSuccessInRange: handshakesSuccessInRangeRow[0]?.count ?? 0,
      capabilityInvocationsInRange: capabilityInvocations[0]?.count ?? 0,
      activeSessions: activeSessionsRow[0]?.count ?? 0,
      pendingWebhookDeliveries: pendingDeliveries[0]?.count ?? 0,
    },
    recentSessions: recentSessionRows.map((s) => ({
      sessionId: s.sessionId,
      aidA: s.aidA,
      aidB: s.aidB,
      status: s.status,
      grants: s.grants,
      boundary: s.boundary,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
    })),
    charts: {
      handshakesByBoundary: handshakesByBoundaryRows.map((r) => ({
        boundary: r.boundary ?? 'unknown',
        count: r.count,
      })),
      handshakesOverTime: timeRows.map((r) => ({
        bucket: r.bucket,
        count: r.count,
      })),
      topCapabilities: capRows.map((r) => ({
        capability: r.capability,
        count: r.count,
      })),
    },
  };
}

export interface AgentMetrics {
  aid: string;
  displayName: string;
  status: string;
  registeredAt: string;
  lastSeenAt: string | null;
  handshakesAsInitiator: number;
  handshakesAsResponder: number;
  capabilityInvocations: number;
}

export async function getAgentMetrics(): Promise<AgentMetrics[]> {
  const allAgents = await db.select().from(agents);
  if (allAgents.length === 0) return [];

  const aids = allAgents.map((a) => a.aid);
  const [initiator, responder, invocations] = await Promise.all([
    db
      .select({ aid: handshakeSessions.aidA, count: count() })
      .from(handshakeSessions)
      .where(inArray(handshakeSessions.aidA, aids))
      .groupBy(handshakeSessions.aidA),
    db
      .select({ aid: handshakeSessions.aidB, count: count() })
      .from(handshakeSessions)
      .where(inArray(handshakeSessions.aidB, aids))
      .groupBy(handshakeSessions.aidB),
    db
      .select({ aid: auditEvents.aidA, count: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.type, 'capability.invoked'),
          inArray(auditEvents.aidA, aids),
        ),
      )
      .groupBy(auditEvents.aidA),
  ]);

  const lookup = (
    rows: { aid: string | null; count: number }[],
    aid: string,
  ): number => rows.find((r) => r.aid === aid)?.count ?? 0;

  return allAgents.map((a) => ({
    aid: a.aid,
    displayName: a.displayName,
    status: a.status,
    registeredAt: a.registeredAt,
    lastSeenAt: a.lastSeenAt,
    handshakesAsInitiator: lookup(initiator, a.aid),
    handshakesAsResponder: lookup(responder, a.aid),
    capabilityInvocations: lookup(invocations, a.aid),
  }));
}
