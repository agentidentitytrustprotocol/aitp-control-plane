/**
 * GET /api/sessions/:sessionId/export?format=json|jsonl
 *
 * Bundles everything we know about a single handshake session into a
 * downloadable artifact: the session row + all related audit events +
 * any TCTs the monitor projected from this session.
 *
 * JSONL format streams one event per line so a large export doesn't
 * have to fit in memory on either side.
 */

import { NextRequest } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auditEvents, handshakeSessions, issuedTcts } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const format = new URL(req.url).searchParams.get('format') ?? 'json';

  const sessions = await db
    .select()
    .from(handshakeSessions)
    .where(eq(handshakeSessions.sessionId, sessionId))
    .limit(1);
  const session = sessions[0];
  if (!session) {
    return Response.json(
      { error: 'session not found', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }
  const events = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.sessionId, sessionId))
    .orderBy(asc(auditEvents.ts));
  const tcts = await db
    .select()
    .from(issuedTcts)
    .where(eq(issuedTcts.sessionId, sessionId));

  if (format === 'jsonl') {
    const lines: string[] = [];
    lines.push(JSON.stringify({ kind: 'session', record: session }));
    for (const t of tcts) lines.push(JSON.stringify({ kind: 'tct', record: t }));
    for (const e of events) lines.push(JSON.stringify({ kind: 'event', record: e }));
    return new Response(lines.join('\n') + '\n', {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': `attachment; filename="session-${sessionId}.jsonl"`,
      },
    });
  }

  return Response.json({
    session,
    tcts,
    events,
    exportedAt: new Date().toISOString(),
  });
}
