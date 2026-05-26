import { count, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  agents,
  auditEvents,
  handshakeSessions,
  webhookDeliveries,
} from '@/lib/db/schema';
import { rateLimiter } from '@/lib/rate-limit';
import { webhookBreaker } from '@/lib/webhooks/circuit-breaker';

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
  }

  lines.push('# HELP aitp_control_plane_db_up Whether the database was reachable for this scrape');
  lines.push('# TYPE aitp_control_plane_db_up gauge');
  lines.push(`aitp_control_plane_db_up ${dbOk ? 1 : 0}`);

  const drops = rateLimiter.getDropTotals();
  lines.push(
    '# HELP aitp_control_plane_rate_limit_drops Requests rejected by the rate limiter, by bucket',
  );
  lines.push('# TYPE aitp_control_plane_rate_limit_drops counter');
  for (const [bucket, total] of Object.entries(drops)) {
    const label = bucket.replace(/"/g, '\\"');
    lines.push(`aitp_control_plane_rate_limit_drops{bucket="${label}"} ${total}`);
  }

  const breakers = webhookBreaker.getAllSnapshots();
  lines.push(
    '# HELP aitp_control_plane_webhook_circuit_breaker_open Webhooks whose circuit breaker is open or half_open',
  );
  lines.push(
    '# TYPE aitp_control_plane_webhook_circuit_breaker_open gauge',
  );
  let openCount = 0;
  let halfOpenCount = 0;
  for (const snap of Object.values(breakers)) {
    if (snap.state === 'open') openCount += 1;
    else if (snap.state === 'half_open') halfOpenCount += 1;
  }
  lines.push(
    `aitp_control_plane_webhook_circuit_breaker_open{state="open"} ${openCount}`,
  );
  lines.push(
    `aitp_control_plane_webhook_circuit_breaker_open{state="half_open"} ${halfOpenCount}`,
  );

  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
}
