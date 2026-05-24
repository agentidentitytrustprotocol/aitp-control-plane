import { NextRequest } from 'next/server';
import { and, desc, eq, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import { handshakeSessions } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') ?? undefined;
  const runId = searchParams.get('run_id') ?? searchParams.get('runId') ?? undefined;
  const aid = searchParams.get('aid') ?? undefined;

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
    .orderBy(desc(handshakeSessions.createdAt))
    .limit(200);
  return Response.json({ sessions });
}
