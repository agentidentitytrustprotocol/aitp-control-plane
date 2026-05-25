import { NextRequest } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auditEvents, handshakeSessions } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
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

  return Response.json({ session, events });
}
