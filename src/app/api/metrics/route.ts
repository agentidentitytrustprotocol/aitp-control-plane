import { count, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  agents,
  auditEvents,
  handshakeSessions,
  webhookDeliveries,
} from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const lines: string[] = [];
  let dbOk = true;
  try {
    const [
      activeAgents,
      expiredAgents,
      totalSessions,
      deliveriesPending,
      deliveriesFailed,
    ] = await Promise.all([
      db
        .select({ c: count() })
        .from(agents)
        .where(eq(agents.status, 'active')),
      db
        .select({ c: count() })
        .from(agents)
        .where(eq(agents.status, 'expired')),
      db.select({ c: count() }).from(handshakeSessions),
      db
        .select({ c: count() })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.status, 'pending')),
      db
        .select({ c: count() })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.status, 'failed')),
    ]);
    const eventsByType = await db
      .select({ type: auditEvents.type, c: count() })
      .from(auditEvents)
      .groupBy(auditEvents.type);

    lines.push('# HELP aitp_control_plane_agents_active Active agents in registry');
    lines.push('# TYPE aitp_control_plane_agents_active gauge');
    lines.push(`aitp_control_plane_agents_active ${activeAgents[0]?.c ?? 0}`);

    lines.push(
      '# HELP aitp_control_plane_agents_expired Agents with expired manifests awaiting re-enrollment',
    );
    lines.push('# TYPE aitp_control_plane_agents_expired gauge');
    lines.push(`aitp_control_plane_agents_expired ${expiredAgents[0]?.c ?? 0}`);

    lines.push('# HELP aitp_control_plane_sessions_total Total handshake sessions ever observed');
    lines.push('# TYPE aitp_control_plane_sessions_total counter');
    lines.push(`aitp_control_plane_sessions_total ${totalSessions[0]?.c ?? 0}`);

    lines.push('# HELP aitp_control_plane_webhook_deliveries Webhook deliveries by status');
    lines.push('# TYPE aitp_control_plane_webhook_deliveries gauge');
    lines.push(`aitp_control_plane_webhook_deliveries{status="pending"} ${deliveriesPending[0]?.c ?? 0}`);
    lines.push(`aitp_control_plane_webhook_deliveries{status="failed"} ${deliveriesFailed[0]?.c ?? 0}`);

    lines.push('# HELP aitp_control_plane_audit_events Total audit events by type');
    lines.push('# TYPE aitp_control_plane_audit_events counter');
    for (const r of eventsByType) {
      const labelType = r.type.replace(/"/g, '\\"');
      lines.push(`aitp_control_plane_audit_events{type="${labelType}"} ${r.c}`);
    }
  } catch (err) {
    dbOk = false;
    lines.push('# DB unavailable: ' + (err instanceof Error ? err.message : String(err)));
    void sql; // keep import live
  }

  lines.push('# HELP aitp_control_plane_db_up Whether the database was reachable for this scrape');
  lines.push('# TYPE aitp_control_plane_db_up gauge');
  lines.push(`aitp_control_plane_db_up ${dbOk ? 1 : 0}`);

  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
}
