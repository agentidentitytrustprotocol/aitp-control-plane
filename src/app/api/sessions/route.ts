import { NextRequest } from 'next/server';
import { and, desc, eq, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import { handshakeSessions } from '@/lib/db/schema';
import { badRequest, checkQueryParam } from '@/lib/http/validate';
import { parsePagination } from '@/lib/pagination';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') ?? undefined;
  const runId = searchParams.get('run_id') ?? searchParams.get('runId') ?? undefined;
  const aid = searchParams.get('aid') ?? undefined;

  // A NUL in a text filter reaches a varchar comparison (22021) and would 500.
  for (const name of ['status', 'run_id', 'runId', 'aid']) {
    const problem = checkQueryParam(searchParams.get(name), name);
    if (problem) return badRequest(problem, 'BAD_REQUEST');
  }
  const { limit, offset } = parsePagination(searchParams, {
    defaultLimit: 200,
    maxLimit: 1000,
  });

  const where = [];
  if (status) where.push(eq(handshakeSessions.status, status));
  if (runId) where.push(eq(handshakeSessions.runId, runId));
  if (aid) {
    where.push(
      or(
        eq(handshakeSessions.aidA, aid),
        eq(handshakeSessions.aidB, aid),
      )!,
    );
  }
  const base = db.select().from(handshakeSessions);
  const filtered = where.length > 0 ? base.where(and(...where)) : base;
  const sessions = await filtered
    // sessionId breaks createdAt ties so offset pages are stable.
    .orderBy(desc(handshakeSessions.createdAt), desc(handshakeSessions.sessionId))
    .limit(limit)
    .offset(offset);
  return Response.json({ sessions });
}
