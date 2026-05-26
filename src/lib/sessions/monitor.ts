import { eq } from 'drizzle-orm';
import { db } from '../db';
import { handshakeSessions } from '../db/schema';
import type { AuditEventRecord } from '../audit/stream';
import { logger } from '../logger';

function deriveBoundary(event: AuditEventRecord): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.boundary === 'string') return payload.boundary;
  return undefined;
}

class SessionMonitorService {
  async onEvent(event: AuditEventRecord): Promise<void> {
    const sid = event.sessionId;
    if (!sid) return;

    try {
      if (event.type === 'handshake.started') {
        await db
          .insert(handshakeSessions)
          .values({
            sessionId: sid,
            aidA: event.aidA ?? null,
            aidB: event.aidB ?? null,
            status: 'started',
            runId: event.runId ?? null,
            boundary: deriveBoundary(event) ?? null,
            startedAt: event.ts,
          })
          .onConflictDoNothing();
      } else if (event.type === 'handshake.complete') {
        await db
          .update(handshakeSessions)
          .set({
            status: 'complete',
            completedAt: event.ts,
            grants: event.grants ?? [],
            updatedAt: new Date().toISOString(),
          })
          .where(eq(handshakeSessions.sessionId, sid));
      } else if (event.type === 'handshake.failed') {
        const payload = event.payload as Record<string, unknown>;
        await db
          .update(handshakeSessions)
          .set({
            status: 'failed',
            error: typeof payload.error === 'string' ? payload.error : null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(handshakeSessions.sessionId, sid));
      }
    } catch (err) {
      logger.warn({ err, sessionId: sid, type: event.type }, 'session-monitor db update failed');
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __sessionMonitor: SessionMonitorService | undefined;
}

export const sessionMonitor =
  globalThis.__sessionMonitor ??
  (globalThis.__sessionMonitor = new SessionMonitorService());
