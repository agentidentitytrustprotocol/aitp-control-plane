import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { agents } from '../db/schema';
import { ingestOneEvent } from '../audit/event-store';
import { eventBus, type AuditEventRecord } from '../audit/stream';
import { dispatchWebhooks } from '../webhooks/service';
import { logger } from '../logger';
import { SUPPORTED_MANIFEST_VERSION } from './manifest-version';

type ExpiredRow = { aid: string; displayName: string; namespace: string };

/** Rows whose stored Manifest is not {@link SUPPORTED_MANIFEST_VERSION}
 * (including one with no `manifest.version`). `manifest_json` is text, and
 * every write passes `verifyManifestJson` first, so the cast cannot fail on a
 * row the CP wrote. Exported for the integration test. */
export const unsupportedManifestVersion = sql`(${agents.manifestJson}::jsonb #>> '{manifest,version}') is distinct from ${SUPPORTED_MANIFEST_VERSION}`;
type ExpiryReason = 'manifest_expired' | 'manifest_version_unsupported';

/** Sweep all currently-expired manifests, transition their rows to
 * status='expired', and emit `agent.expired` events. Returns the
 * number of rows transitioned.
 *
 * A second sweep retires active rows whose stored Manifest is not
 * {@link SUPPORTED_MANIFEST_VERSION} (`reason: 'manifest_version_unsupported'`).
 * After the aitp/0.3 cutover those rows are served to consumers that reject
 * them on `version_unknown`, and the CP cannot re-sign another agent's
 * Manifest. Reversible: re-enrolling sets the row back to `active`
 * (`upsertAgent`). It runs every tick rather than as a one-shot migration so
 * it also emits the audit/webhook events and catches a row registered with a
 * pre-cutover enrollment token.
 *
 * Concurrency-safe: a single `UPDATE ... RETURNING` atomically claims
 * the rows this caller transitioned. Concurrent callers' UPDATEs see
 * different (or zero) rows, so each `agent.expired` event fires exactly
 * once across the cluster. (Postgres serializes the row-level locks for
 * us — the SELECT-then-UPDATE pattern this replaced would double-emit
 * because each caller's SELECT would see the still-active rows.) */
export async function enforceManifestExpiry(): Promise<number> {
  const now = new Date().toISOString();
  const returning = {
    aid: agents.aid,
    displayName: agents.displayName,
    namespace: agents.namespace,
  };
  const expired = await db
    .update(agents)
    .set({ status: 'expired' })
    .where(
      and(
        eq(agents.status, 'active'),
        isNotNull(agents.manifestExpiresAt),
        lt(agents.manifestExpiresAt, now),
      ),
    )
    .returning(returning);
  await emitExpired(expired, 'manifest_expired', now);

  const unsupported = await db
    .update(agents)
    .set({ status: 'expired' })
    .where(
      and(
        eq(agents.status, 'active'),
        unsupportedManifestVersion,
      ),
    )
    .returning(returning);
  await emitExpired(unsupported, 'manifest_version_unsupported', now);

  const total = expired.length + unsupported.length;
  if (total > 0) {
    logger.info(
      { count: total, expired: expired.length, versionUnsupported: unsupported.length },
      'expiry-job marked agents expired',
    );
  }
  return total;
}

async function emitExpired(rows: ExpiredRow[], reason: ExpiryReason, now: string): Promise<void> {
  for (const agent of rows) {
    const event: AuditEventRecord = {
      id: randomUUID(),
      type: 'agent.expired',
      ts: now,
      aidA: agent.aid,
      payload: {
        displayName: agent.displayName,
        namespace: agent.namespace,
        reason,
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
