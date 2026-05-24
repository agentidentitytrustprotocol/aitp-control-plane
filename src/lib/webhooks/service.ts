import { and, eq, lte, or, sql } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import { db } from '../db';
import {
  webhookDeliveries,
  webhooks,
  type NewWebhook,
  type Webhook,
} from '../db/schema';
import type { AuditEventRecord } from '../audit/stream';
import { config } from '../config';

// Don't overwhelm a downstream receiver during recovery / catch-up.
const FLUSH_CONCURRENCY = 8;
const FLUSH_BATCH_LIMIT = 500;

// Event types eligible for webhook fan-out.
const DELIVERABLE_EVENT_TYPES = new Set<string>([
  'agent.registered',
  'agent.expired',
  'agent.deregistered',
  'handshake.complete',
  'handshake.failed',
  'tct.revoked',
]);

export interface CreateWebhookInput {
  url: string;
  events: string[];
  secret?: string;
  active?: boolean;
}

export interface UpdateWebhookInput {
  url?: string;
  events?: string[];
  secret?: string;
  active?: boolean;
}

export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export async function listWebhooks(): Promise<Webhook[]> {
  return db.select().from(webhooks);
}

/** Active-only variant for the hot dispatch path. Filters at the DB
 * level rather than pulling inactive webhooks + secrets into memory. */
export async function listActiveWebhooks(): Promise<Webhook[]> {
  return db.select().from(webhooks).where(eq(webhooks.active, true));
}

export async function createWebhook(
  input: CreateWebhookInput,
): Promise<Webhook> {
  const id = randomUUID();
  const secret = input.secret ?? randomUUID().replace(/-/g, '');
  const row: NewWebhook = {
    id,
    url: input.url,
    events: input.events,
    secret,
    active: input.active ?? true,
  };
  await db.insert(webhooks).values(row);
  const created = await db.select().from(webhooks).where(eq(webhooks.id, id));
  return created[0]!;
}

export async function updateWebhook(
  id: string,
  patch: UpdateWebhookInput,
): Promise<Webhook | undefined> {
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.events !== undefined) set.events = patch.events;
  if (patch.secret !== undefined) set.secret = patch.secret;
  if (patch.active !== undefined) set.active = patch.active;
  const updated = await db
    .update(webhooks)
    .set(set)
    .where(eq(webhooks.id, id))
    .returning();
  return updated[0];
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const deleted = await db
    .delete(webhooks)
    .where(eq(webhooks.id, id))
    .returning({ id: webhooks.id });
  return deleted.length > 0;
}

/** Build the canonical body bytes that get HMAC-signed and POSTed.
 * Computed once at enqueue, stored on the row, and re-sent verbatim on
 * every retry — that way the receiver sees the same signature for every
 * attempt of the same delivery (true idempotency-by-signature). */
function buildCanonicalBody(
  deliveryId: string,
  event: AuditEventRecord,
  enqueuedAt: string,
): string {
  // Key order is fixed by literal-construction; both V8 JSON.stringify
  // and jsonb storage are stable here. `enqueuedAt` (not `deliveredAt`)
  // is captured ONCE at enqueue so the body bytes don't drift on retry.
  return JSON.stringify({
    deliveryId,
    eventType: event.type,
    payload: event as unknown as Record<string, unknown>,
    enqueuedAt,
  });
}

async function enqueueDelivery(
  webhookId: string,
  event: AuditEventRecord,
  webhookSecret: string,
): Promise<void> {
  const id = randomUUID();
  const enqueuedAt = new Date().toISOString();
  const body = buildCanonicalBody(id, event, enqueuedAt);
  const signature = signPayload(webhookSecret, body);
  await db.insert(webhookDeliveries).values({
    id,
    webhookId,
    eventType: event.type,
    payload: event as unknown as Record<string, unknown>,
    body,
    signature,
    status: 'pending',
    attempts: 0,
  });
  void attemptDelivery(id).catch((err) =>
    console.warn('[webhooks] initial attempt failed:', err),
  );
}

/** Enqueue + immediately attempt deliveries for a given audit event.
 * Fetches active webhooks per call. Prefer `dispatchWebhooksWithList`
 * when fanning out a batch — pass the list in once to avoid N queries. */
export async function dispatchWebhooks(
  event: AuditEventRecord,
): Promise<void> {
  if (!DELIVERABLE_EVENT_TYPES.has(event.type)) return;
  const candidates = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.active, true));
  return dispatchWebhooksWithList(event, candidates);
}

/** Variant for batch ingestion: caller supplies the already-fetched
 * webhook list, so a 50-event batch issues 1 webhook lookup not 50. */
export async function dispatchWebhooksWithList(
  event: AuditEventRecord,
  candidates: Webhook[],
): Promise<void> {
  if (!DELIVERABLE_EVENT_TYPES.has(event.type)) return;
  const matching = candidates.filter(
    (w) =>
      w.active && (w.events.length === 0 || w.events.includes(event.type)),
  );
  if (matching.length === 0) return;
  await Promise.all(
    matching.map((w) => enqueueDelivery(w.id, event, w.secret)),
  );
}

/** Attempt a single delivery row. Idempotent under concurrent calls:
 * the row's `attempts` counter acts as an optimistic-lock token —
 * a second concurrent attempt sees `attempts` already advanced and
 * bails (returns without re-POSTing). */
export async function attemptDelivery(deliveryId: string): Promise<void> {
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);
  const delivery = rows[0];
  if (!delivery || delivery.status === 'delivered') return;

  const webhookRows = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.id, delivery.webhookId))
    .limit(1);
  const webhook = webhookRows[0];
  if (!webhook || !webhook.active) {
    await db
      .update(webhookDeliveries)
      .set({ status: 'failed', error: 'webhook missing or inactive' })
      .where(eq(webhookDeliveries.id, deliveryId));
    return;
  }

  // Optimistic claim: atomically bump `attempts` so concurrent callers
  // can't both POST the same delivery. The WHERE clause pins on the
  // attempt count we just read; if another caller raced ahead, the
  // returning() rowset is empty and we bail.
  const previousAttempts = delivery.attempts;
  const claim = await db
    .update(webhookDeliveries)
    .set({ attempts: previousAttempts + 1, status: 'pending' })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.attempts, previousAttempts),
        // Don't re-claim a row another caller has already marked
        // 'delivered' or 'failed' between our SELECT and UPDATE.
        eq(webhookDeliveries.status, 'pending'),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  if (claim.length === 0) return;
  const attempts = previousAttempts + 1;

  // Prefer the canonical body + signature persisted at enqueue time.
  // Falling back to per-attempt construction keeps pre-v0.3 rows
  // (enqueued before the body/signature columns existed) deliverable.
  let body: string;
  let signature: string;
  if (delivery.body && delivery.signature) {
    body = delivery.body;
    signature = delivery.signature;
  } else {
    console.warn(
      `[webhooks] delivery ${deliveryId} predates the body/signature columns; signing on the fly (signature will differ per retry)`,
    );
    body = buildCanonicalBody(
      delivery.id,
      delivery.payload as unknown as AuditEventRecord,
      delivery.createdAt,
    );
    signature = signPayload(webhook.secret, body);
  }

  let statusCode: number | null = null;
  let error: string | null = null;
  let ok = false;

  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aitp-Event': delivery.eventType,
        'X-Aitp-Delivery': delivery.id,
        'X-Aitp-Signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    statusCode = res.status;
    ok = res.ok;
    if (!ok) {
      const text = await res.text().catch(() => '');
      error = `non-2xx (${res.status}): ${text.slice(0, 200)}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (ok) {
    await db
      .update(webhookDeliveries)
      .set({
        status: 'delivered',
        statusCode,
        error: null,
        deliveredAt: new Date().toISOString(),
        nextRetryAt: null,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    return;
  }

  if (attempts >= config.webhookRetryAttempts) {
    await db
      .update(webhookDeliveries)
      .set({ status: 'failed', statusCode, error, nextRetryAt: null })
      .where(eq(webhookDeliveries.id, deliveryId));
    return;
  }

  // Exponential backoff: 30s, 2m, 8m, ...  We persist nextRetryAt so
  // the periodic reaper (`flushDueRetries`) picks the row up even if
  // this process dies before the setTimeout fires.
  const backoffMs = 30_000 * Math.pow(4, attempts - 1);
  const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
  await db
    .update(webhookDeliveries)
    .set({ status: 'pending', statusCode, error, nextRetryAt })
    .where(eq(webhookDeliveries.id, deliveryId));

  setTimeout(() => {
    void attemptDelivery(deliveryId).catch((e) =>
      console.warn('[webhooks] retry failed:', e),
    );
  }, backoffMs).unref?.();
}

/** Reaper for retries — picks up pending deliveries whose nextRetryAt
 * is due (or null, meaning enqueue-but-never-attempted-yet from a
 * previous process). Bounded fan-out so we don't dump a 10k-deep queue
 * onto a recovering receiver. */
export async function flushDueRetries(): Promise<number> {
  const now = new Date().toISOString();
  const due = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, 'pending'),
        or(
          lte(webhookDeliveries.nextRetryAt, now),
          sql`${webhookDeliveries.nextRetryAt} IS NULL`,
        ),
      ),
    )
    .limit(FLUSH_BATCH_LIMIT);

  for (let i = 0; i < due.length; i += FLUSH_CONCURRENCY) {
    const slice = due.slice(i, i + FLUSH_CONCURRENCY);
    await Promise.all(
      slice.map((d) =>
        attemptDelivery(d.id).catch((err) =>
          console.warn('[webhooks] reaper attempt failed:', err),
        ),
      ),
    );
  }
  return due.length;
}

declare global {
  // eslint-disable-next-line no-var
  var __webhookReaperInterval: ReturnType<typeof setInterval> | undefined;
}

/** Start the periodic reaper. Idempotent — safe to call from a hot
 * route handler. Without this, deliveries scheduled by a previous
 * process restart sit in `pending` forever, since the in-process
 * `setTimeout` retry from the original attempt is gone with the
 * old process. */
export function startWebhookReaper(intervalMs = 60_000): void {
  if (globalThis.__webhookReaperInterval) return;
  // First pass on boot.
  void flushDueRetries().catch((err) =>
    console.warn('[webhooks] reaper boot flush failed:', err),
  );
  globalThis.__webhookReaperInterval = setInterval(() => {
    flushDueRetries().catch((err) =>
      console.warn('[webhooks] reaper tick failed:', err),
    );
  }, intervalMs);
  globalThis.__webhookReaperInterval.unref?.();
}
