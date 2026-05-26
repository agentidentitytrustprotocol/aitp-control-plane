/**
 * GET /api/sessions/:sessionId/replay
 *
 * Returns the chronological event stream for a single handshake
 * session, suitable for offline analysis or driving a future
 * scrubber-style debug UI. This is a low-effort dump — no timing
 * envelope, no SSE pacing; the caller does the timing if they want
 * "replay at speed".
 *
 * Filters:
 *   ?since=<ISO>      lower bound on ts (inclusive)
 *   ?until=<ISO>      upper bound on ts (inclusive)
 *   ?limit=<n>        max 10000, default 1000
 */

import { NextRequest } from 'next/server';
import { and, asc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auditEvents } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const sp = new URL(req.url).searchParams;
  const wheres: SQL[] = [eq(auditEvents.sessionId, sessionId)];
  const since = sp.get('since');
  if (since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) {
      return Response.json(
        { error: 'invalid since', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }
    wheres.push(gte(auditEvents.ts, d.toISOString()));
  }
  const until = sp.get('until');
  if (until) {
    const d = new Date(until);
    if (Number.isNaN(d.getTime())) {
      return Response.json(
        { error: 'invalid until', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }
    wheres.push(lte(auditEvents.ts, d.toISOString()));
  }
  const limit = Math.min(
    Math.max(parseInt(sp.get('limit') ?? '1000', 10) || 1000, 1),
    10000,
  );

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...wheres))
    .orderBy(asc(auditEvents.ts))
    .limit(limit);

  return Response.json({
    sessionId,
    count: rows.length,
    events: rows,
  });
}
