import { count, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  agents,
  auditEvents,
  handshakeSessions,
  webhookDeliveries,
} from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import { rateLimiter } from '@/lib/rate-limit';
import { webhookBreaker } from '@/lib/webhooks/circuit-breaker';
import { getAdminAuditInsertFailures } from '@/lib/audit-log/service';
import { getEnrollFailureTotals } from '@/lib/registry/enroll-metrics';
import { eventBus } from '@/lib/audit/stream';
import { getSseMetrics } from '@/lib/audit/sse-metrics';

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
    // The message is LOGGED, never published (#112). It used to be interpolated
    // into a `# DB unavailable: <msg>` comment here, and the throw comes from
    // the pg pool, so in a misconfigured or unreachable deployment it names
    // infrastructure rather than SQL: `getaddrinfo ENOTFOUND
    // <internal-db-host>`, `password authentication failed for user "<user>"`,
    // `database "<name>" does not exist`, `connect ECONNREFUSED <host>:<port>`.
    // This route is in BOTH `PUBLIC_PATHS` and `RATE_LIMIT_EXEMPT_PATHS`
    // (src/proxy.ts), so that was an internal hostname or username handed to any
    // anonymous caller who polls for the moment a deploy breaks.
    //
    // Two reasons, not one. The second is that the Prometheus text exposition
    // format is LINE-ORIENTED and the message was interpolated unescaped into a
    // body joined with '\n'. A message containing a newline therefore did not
    // merely leak, it injected lines into the scrape: a message reading
    // "boom\naitp_control_plane_db_up 1" puts a forged healthy sample next to
    // this route's truthful `db_up 0`, and a parser taking the last value for a
    // series reports the database as UP during an outage — the opposite of what
    // the series exists to say. pg messages are not guaranteed single-line
    // (Postgres composes message/detail/hint, and hostnames come from the
    // environment), so this was a correctness hole in the format as well as a
    // disclosure. metrics.test.ts pins it as a property of the output rather
    // than as the absence of one string.
    //
    // Nothing is lost for the scraper: `aitp_control_plane_db_up 0` below is the
    // signal, and docs/operations.md#metrics says so explicitly ("Alert on `db_up`, not
    // on the absence of the others"). The message-free comment is still emitted
    // — see below.
    //
    // Structure is the guard: this block flips a boolean and logs, and every
    // output line is built outside it from literals, so `err` is not in scope
    // anywhere `lines` is appended to. `warn` rather than `error` because the
    // scrape still succeeds (200, with every process-local series intact) and a
    // tight scrape interval would otherwise flood the log during an outage.
    //
    // The log is try-guarded, for the reason enroll's recordFailure states:
    // "instrumentation must never change the response, so neither half may
    // throw". That rule is at its sharpest here. This handler answers 200 with
    // every process-local series in it, and pino's `err` serializer does throw
    // synchronously for an error carrying a throwing getter — so an unguarded
    // log would convert a DB outage into a 500 scrape, taking the SSE, enroll
    // and breaker counters down with it. Those are emitted outside this try
    // precisely because they must survive a DB outage, and a swallowed log line
    // is a far smaller loss than the whole scrape.
    dbOk = false;
    try {
      logger.warn({ err }, 'metrics scrape: database query failed');
    } catch {
      // Intentionally ignored — see above.
    }
  }

  // Kept as a literal, with no detail. It is the human hint for whoever is
  // curling this endpoint during an incident, it costs a scraper nothing
  // (comments other than # HELP / # TYPE are ignored), and it keeps
  // docs/operations.md#metrics's "`db_up 0` plus a `# DB unavailable` comment appears
  // instead" true. Emitted here rather than in the catch so the line cannot be
  // built from `err`, and positioned before the db_up block so scrape output
  // ordering is unchanged from before the fix.
  if (!dbOk) {
    lines.push('# DB unavailable: cause logged server-side, deliberately not published here');
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

  // Operator visibility into silent-degradation surfaces.
  lines.push(
    '# HELP aitp_control_plane_admin_audit_insert_failures Admin-audit inserts that failed since process start',
  );
  lines.push('# TYPE aitp_control_plane_admin_audit_insert_failures counter');
  lines.push(
    `aitp_control_plane_admin_audit_insert_failures ${getAdminAuditInsertFailures()}`,
  );

  // Enrollment is the service's only public crypto-verification endpoint and
  // had no failure signal at all before this — a credential-stuffing or
  // misconfigured-fleet event was invisible until someone filed a ticket.
  // Label values are allowlisted upstream in enroll-metrics.ts, so cardinality
  // is bounded at ten regardless of what callers send.
  lines.push(
    '# HELP aitp_control_plane_enroll_verification_failures Failed enrollment manifest verifications since process start, by code ("none" = rejected by this service rather than the SDK, "other" = an SDK code this build does not recognize)',
  );
  lines.push(
    '# TYPE aitp_control_plane_enroll_verification_failures counter',
  );
  for (const [code, total] of Object.entries(getEnrollFailureTotals())) {
    const label = code.replace(/"/g, '\\"');
    lines.push(
      `aitp_control_plane_enroll_verification_failures{code="${label}"} ${total}`,
    );
  }

  lines.push(
    '# HELP aitp_control_plane_event_backlog_dropped Audit events evicted from the in-memory SSE backlog since process start',
  );
  lines.push('# TYPE aitp_control_plane_event_backlog_dropped counter');
  lines.push(
    `aitp_control_plane_event_backlog_dropped ${eventBus.getDroppedCount()}`,
  );

  // SSE stream lifecycle. These exist because issue #89 — the stream endpoint
  // never flushing its response headers — was undiagnosable from outside the
  // process: nothing published whether the handler was even being reached.
  // This endpoint is public and rate-limit exempt, so these three answer that
  // from anywhere. Note they are emitted OUTSIDE the DB try/catch above, which
  // is load-bearing: the stream route has no database coupling at all, and an
  // SSE incident can easily coincide with (or be misread as) a DB outage that
  // already has /api/health returning 503.
  const sse = getSseMetrics();
  lines.push(
    '# HELP aitp_control_plane_sse_streams_open /api/events/stream connections open right now on this replica',
  );
  lines.push('# TYPE aitp_control_plane_sse_streams_open gauge');
  lines.push(`aitp_control_plane_sse_streams_open ${sse.open}`);

  lines.push(
    '# HELP aitp_control_plane_sse_streams_opened_total /api/events/stream connections accepted since process start',
  );
  lines.push('# TYPE aitp_control_plane_sse_streams_opened_total counter');
  lines.push(
    `aitp_control_plane_sse_streams_opened_total ${sse.openedTotal}`,
  );

  lines.push(
    '# HELP aitp_control_plane_sse_streams_rejected_total /api/events/stream connections refused by MAX_SSE_CONNECTIONS since process start',
  );
  lines.push('# TYPE aitp_control_plane_sse_streams_rejected_total counter');
  lines.push(
    `aitp_control_plane_sse_streams_rejected_total ${sse.rejectedTotal}`,
  );

  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
}
