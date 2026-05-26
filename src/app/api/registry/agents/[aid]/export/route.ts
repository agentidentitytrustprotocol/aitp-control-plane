/**
 * GET /api/registry/agents/:aid/export?format=json|jsonl
 *
 * Bundles everything we have on a single agent: registry row,
 * sessions they participated in (either side), TCTs they issued or
 * received, and the most recent audit events touching them.
 *
 * Useful for support handoff or compliance evidence ("everything this
 * agent did between dates").
 */

import { NextRequest } from 'next/server';
import { desc, eq, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  agents,
  auditEvents,
  handshakeSessions,
  issuedTcts,
} from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ aid: string }> },
) {
  const { aid } = await params;
  const sp = new URL(req.url).searchParams;
  const format = sp.get('format') ?? 'json';
  const eventLimit = Math.min(
    Math.max(parseInt(sp.get('eventLimit') ?? '1000', 10) || 1000, 1),
    10000,
  );

  const agentRows = await db
    .select()
    .from(agents)
    .where(eq(agents.aid, aid))
    .limit(1);
  if (!agentRows[0]) {
    return Response.json(
      { error: 'agent not found', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }

  const sessions = await db
    .select()
    .from(handshakeSessions)
    .where(
      or(eq(handshakeSessions.aidA, aid), eq(handshakeSessions.aidB, aid)),
    )
    .orderBy(desc(handshakeSessions.startedAt));

  const tcts = await db
    .select()
    .from(issuedTcts)
    .where(
      or(
        eq(issuedTcts.issuerAid, aid),
        eq(issuedTcts.subjectAid, aid),
        eq(issuedTcts.audienceAid, aid),
      ),
    );

  const events = await db
    .select()
    .from(auditEvents)
    .where(sql`${auditEvents.aidA} = ${aid} or ${auditEvents.aidB} = ${aid}`)
    .orderBy(desc(auditEvents.ts))
    .limit(eventLimit);

  if (format === 'jsonl') {
    const lines: string[] = [];
    lines.push(JSON.stringify({ kind: 'agent', record: agentRows[0] }));
    for (const s of sessions) lines.push(JSON.stringify({ kind: 'session', record: s }));
    for (const t of tcts) lines.push(JSON.stringify({ kind: 'tct', record: t }));
    for (const e of events) lines.push(JSON.stringify({ kind: 'event', record: e }));
    return new Response(lines.join('\n') + '\n', {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': `attachment; filename="agent-${encodeURIComponent(aid)}.jsonl"`,
      },
    });
  }

  return Response.json({
    agent: agentRows[0],
    sessions,
    tcts,
    events,
    exportedAt: new Date().toISOString(),
  });
}
