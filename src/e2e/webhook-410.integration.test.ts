/**
 * Integration: a 410 Gone response unsubscribes the webhook (real Postgres).
 *
 * The SSRF url-guard is stubbed and fetch returns 410, because a live
 * receiver on loopback cannot pass the guard (see webhook-outbox). What
 * runs for real is the SQL: the delivery fails, the webhook goes
 * inactive, its other queued deliveries fail without a POST, and one
 * `webhook.unsubscribed` admin-audit row is written.
 */

jest.mock('@/lib/webhooks/url-guard', () => ({
  UnsafeWebhookUrlError: class extends Error {},
  assertSafeWebhookUrl: async () => undefined,
}));

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { attemptDelivery, createWebhook } from '@/lib/webhooks/service';
import { db, pool } from '@/lib/db';
import { adminAuditLog, webhookDeliveries, webhooks } from '@/lib/db/schema';

const fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
const realFetch = global.fetch;

async function enqueue(webhookId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(webhookDeliveries).values({
    id,
    webhookId,
    eventType: 'tct.revoked',
    payload: {},
    body: `{"deliveryId":"${id}"}`,
    signature: 'sig',
    status: 'pending',
  });
  return id;
}

describe('integration: 410 Gone unsubscribes a webhook', () => {
  let webhookId: string;

  beforeAll(() => {
    global.fetch = fetchMock as never;
  });

  afterAll(async () => {
    global.fetch = realFetch;
    if (webhookId) {
      await db.delete(webhooks).where(eq(webhooks.id, webhookId));
      await db
        .delete(adminAuditLog)
        .where(
          and(eq(adminAuditLog.action, 'webhook.unsubscribed'), eq(adminAuditLog.targetId, webhookId)),
        );
    }
    await pool.end();
  });

  it('disables the webhook, fails its queue without posting, and audits once', async () => {
    const hook = await createWebhook({
      url: `https://aitp-410-${randomUUID()}.example.com/webhooks/cp/run`,
      events: [],
    });
    webhookId = hook.id;
    const first = await enqueue(hook.id);
    const queued = await enqueue(hook.id);
    fetchMock.mockResolvedValue(new Response('unknown run', { status: 410 }));

    await attemptDelivery(first);

    const [w] = await db.select().from(webhooks).where(eq(webhooks.id, hook.id));
    expect(w.active).toBe(false);
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hook.id));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[first]).toMatchObject({ status: 'failed', statusCode: 410, attempts: 1, nextRetryAt: null });
    expect(byId[queued]).toMatchObject({
      status: 'failed',
      attempts: 0,
      error: 'webhook unsubscribed (410 Gone)',
    });

    // A later attempt on the queued row is a no-op: no POST, no second audit.
    await attemptDelivery(queued);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const audits = await db
      .select()
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.action, 'webhook.unsubscribed'), eq(adminAuditLog.targetId, hook.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: 'system:webhook-delivery',
      details: { url: hook.url, deliveryId: first, statusCode: 410 },
    });
  });
});
