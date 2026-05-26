import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { agents } from '../db/schema';
import { ingestOneEvent } from '../audit/event-store';
import { eventBus, type AuditEventRecord } from '../audit/stream';
import { dispatchWebhooks } from '../webhooks/service';
import { logger } from '../logger';

/** Sweep all currently-expired manifests, transition their rows to
 * status='expired', and emit `agent.expired` events. Returns the
 * number of rows transitioned.
 *
 * Concurrency-safe: a single `UPDATE ... RETURNING` atomically claims
 * the rows this caller transitioned. Concurrent callers' UPDATEs see
 * different (or zero) rows, so each `agent.expired` event fires exactly
 * once across the cluster. (Postgres serializes the row-level locks for
 * us — the SELECT-then-UPDATE pattern this replaced would double-emit
 * because each caller's SELECT would see the still-active rows.) */
export async function enforceManifestExpiry(): Promise<number> {
  const now = new Date().toISOString();
  const transitioned = await db
    .update(agents)
    .set({ status: 'expired' })
    .where(
      and(
        eq(agents.status, 'active'),
        isNotNull(agents.manifestExpiresAt),
        lt(agents.manifestExpiresAt, now),
      ),
    )
    .returning({
      aid: agents.aid,
      displayName: agents.displayName,
      namespace: agents.namespace,
    });

  if (transitioned.length === 0) return 0;

  for (const agent of transitioned) {
    const event: AuditEventRecord = {
      id: randomUUID(),
      type: 'agent.expired',
      ts: now,
      aidA: agent.aid,
      payload: {
        displayName: agent.displayName,
        namespace: agent.namespace,
        reason: 'manifest_expired',
      },
      source: 'cp',
    };
    // Persist before the in-memory fan-out so subscribers can resolve
    // event.id against the audit row if they need to. Failures here
    // are non-fatal: the state transition is already committed.
    try {
      await ingestOneEvent(event);
    } catch (err) {
      logger.warn({ err, aid: agent.aid }, 'expiry-job audit insert failed');
    }
    eventBus.publish(event);
    void dispatchWebhooks(event).catch((err) =>
      logger.warn({ err, aid: agent.aid }, 'expiry-job webhook dispatch failed'),
    );
  }

  logger.info({ count: transitioned.length }, 'expiry-job marked agents expired');
  return transitioned.length;
}

declare global {
  // eslint-disable-next-line no-var
  var __expiryInterval: ReturnType<typeof setInterval> | undefined;
}

/** Start the periodic expiry sweep. Idempotent — repeated calls are
 * no-ops, so this is safe to invoke lazily from a hot route handler. */
export function startExpiryJob(intervalMs = 5 * 60 * 1000): void {
  if (globalThis.__expiryInterval) return;
  globalThis.__expiryInterval = setInterval(() => {
    enforceManifestExpiry().catch((err) =>
      logger.warn({ err }, 'expiry-job tick failed'),
    );
  }, intervalMs);
  // Don't hold the event loop open just for the timer.
  globalThis.__expiryInterval.unref?.();
}
