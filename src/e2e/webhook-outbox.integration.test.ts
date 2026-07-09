/**
 * Integration: webhook subscription + outbox against a real Postgres.
 *
 * Verifies:
 *   - POST /api/webhooks registers a subscription (public IP-literal
 *     target passes the SSRF guard with no DNS/network I/O) and GET
 *     lists it without leaking the secret
 *   - POST /api/webhooks rejects loopback targets (URL_NOT_ALLOWED)
 *   - reporting a deliverable event via POST /api/events creates a
 *     webhook_deliveries outbox row whose canonical body carries
 *     { deliveryId, eventType, payload, enqueuedAt } and whose stored
 *     signature is a correct HMAC-SHA256(secret, body) hex digest
 *   - the delivery-time SSRF guard terminally fails the delivery for a
 *     target that cannot resolve to a public address (no retry loop)
 *   - a webhook subscribed to other event types receives no delivery
 *   - attemptDelivery terminally fails a row whose webhook is inactive
 *
 * NOTE on live delivery: actually POSTing to an in-test 127.0.0.1 HTTP
 * server is impossible without production changes — the SSRF url-guard
 * rejects loopback/private addresses both at registration and again at
 * delivery time (the WEBHOOK_URL_ALLOWLIST does not bypass the IP range
 * check). So this suite verifies the outbox row + signature computation
 * and the guard's terminal behavior instead.
 *
 * The outbox webhook targets a `.invalid` hostname: DNS resolution fails
 * fast inside the guard, so no real network traffic ever leaves the test.
 */

import { NextRequest } from 'next/server';
import { createHmac, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { POST as webhooksPost, GET as webhooksGet } from '@/app/api/webhooks/route';
import { POST as eventsPost } from '@/app/api/events/route';
import {
  attemptDelivery,
  createWebhook,
  signPayload,
} from '@/lib/webhooks/service';

import { db, pool } from '@/lib/db';
import {
  adminAuditLog,
  auditEvents,
  webhookDeliveries,
  webhooks,
  type WebhookDelivery,
} from '@/lib/db/schema';

function mkReq(
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(url, {
    method: init.method,
    body: init.body,
    headers: init.headers,
  });
}

async function poll<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error('poll timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const RUN_ID = `webhook-outbox-${randomUUID()}`;
const SECRET = `outbox-secret-${randomUUID().replace(/-/g, '')}`;

// Registered webhook ids collected for teardown (deliveries cascade).
const createdWebhookIds: string[] = [];

describe('integration: webhook registration + outbox HMAC', () => {
  afterAll(async () => {
    if (createdWebhookIds.length > 0) {
      await db.delete(webhooks).where(
        sql`${webhooks.id} in (${sql.join(
          createdWebhookIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    }
    await db.delete(auditEvents).where(sql`${auditEvents.runId} = ${RUN_ID}`);
    await db
      .delete(adminAuditLog)
      .where(
        sql`${adminAuditLog.action} = 'webhook.create' and ${adminAuditLog.targetId} in (${sql.join(
          createdWebhookIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    await pool.end();
  });

  it('registers a subscription via the route and lists it without the secret', async () => {
    // Public (TEST-NET-3) IP literal: passes the SSRF guard without DNS.
    // events=['tct.issued'] is never webhook-deliverable and active=false,
    // so no delivery can ever be attempted against this target.
    const res = await webhooksPost(
      mkReq('http://localhost/api/webhooks', {
        method: 'POST',
        body: JSON.stringify({
          url: 'http://203.0.113.10/aitp-outbox-test',
          events: ['tct.issued'],
          active: false,
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      url: string;
      events: string[];
      secret: string;
      active: boolean;
    };
    createdWebhookIds.push(created.id);
    expect(created.url).toBe('http://203.0.113.10/aitp-outbox-test');
    expect(created.events).toEqual(['tct.issued']);
    expect(created.active).toBe(false);
    expect(created.secret.length).toBeGreaterThan(0);

    const listRes = await webhooksGet();
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      webhooks: Record<string, unknown>[];
    };
    const mine = list.webhooks.find((w) => w.id === created.id);
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty('secret');
  });

  it('rejects a loopback registration target (SSRF guard at create time)', async () => {
    const res = await webhooksPost(
      mkReq('http://localhost/api/webhooks', {
        method: 'POST',
        body: JSON.stringify({
          url: 'http://127.0.0.1:8080/hook',
          events: [],
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('URL_NOT_ALLOWED');
  });

  it('creates an outbox row with a correct HMAC signature for a deliverable event', async () => {
    // Service-level creation: the route's create-time guard requires a
    // resolvable public host, and delivery is blocked for private hosts,
    // so use an unresolvable .invalid target — guaranteed no network.
    const subscriber = await createWebhook({
      url: `http://aitp-outbox-${randomUUID()}.invalid/hook`,
      events: ['handshake.complete'],
      secret: SECRET,
    });
    createdWebhookIds.push(subscriber.id);

    // A webhook subscribed to a never-emitted type must stay silent.
    const bystander = await createWebhook({
      url: `http://aitp-bystander-${randomUUID()}.invalid/hook`,
      events: ['aitp.test.never'],
      secret: 'bystander-secret',
    });
    createdWebhookIds.push(bystander.id);

    const sessionId = randomUUID();
    const ingest = await eventsPost(
      mkReq('http://localhost/api/events', {
        method: 'POST',
        body: JSON.stringify({
          events: [
            {
              type: 'handshake.complete',
              ts: new Date().toISOString(),
              aid_a: `aid:test:outbox-a-${RUN_ID}`,
              aid_b: `aid:test:outbox-b-${RUN_ID}`,
              session_id: sessionId,
              run_id: RUN_ID,
              grants: ['demo.echo'],
              payload: { boundary: 'intra-org' },
            },
            // Not in DELIVERABLE_EVENT_TYPES — must never reach the outbox.
            {
              type: 'capability.invoked',
              ts: new Date().toISOString(),
              session_id: sessionId,
              run_id: RUN_ID,
              payload: { capability: 'demo.echo' },
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(ingest.status).toBe(200);
    expect(await ingest.json()).toMatchObject({ ingested: 2 });

    // The enqueue is awaited by the route; find our delivery row.
    // (Parallel suites may fan other handshake.complete events into this
    // subscriber, so match on our session id.)
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, subscriber.id));
    const delivery = rows.find(
      (r) => (r.payload as { sessionId?: string }).sessionId === sessionId,
    );
    expect(delivery).toBeDefined();
    expect(delivery!.eventType).toBe('handshake.complete');

    // Canonical body: fixed shape, deliveryId matches the row id.
    expect(delivery!.body).toBeTruthy();
    const body = JSON.parse(delivery!.body!) as {
      deliveryId: string;
      eventType: string;
      payload: Record<string, unknown>;
      enqueuedAt: string;
    };
    expect(body.deliveryId).toBe(delivery!.id);
    expect(body.eventType).toBe('handshake.complete');
    expect(Number.isNaN(new Date(body.enqueuedAt).getTime())).toBe(false);
    expect(body.payload).toMatchObject({
      type: 'handshake.complete',
      sessionId,
      runId: RUN_ID,
      grants: ['demo.echo'],
      payload: { boundary: 'intra-org' },
    });

    // Signature: HMAC-SHA256(secret, exact body bytes), hex.
    const expected = createHmac('sha256', SECRET)
      .update(delivery!.body!)
      .digest('hex');
    expect(delivery!.signature).toBe(expected);
    expect(delivery!.signature).toMatch(/^[0-9a-f]{64}$/);
    // And the service's own signer agrees.
    expect(signPayload(SECRET, delivery!.body!)).toBe(expected);

    // The non-deliverable event and the non-matching subscriber got nothing.
    const bystanderRows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, bystander.id));
    expect(bystanderRows).toHaveLength(0);
    const capabilityRows = rows.filter((r) => r.eventType === 'capability.invoked');
    expect(capabilityRows).toHaveLength(0);

    // Delivery-time SSRF guard: the .invalid host can't resolve to a
    // public address, so the fire-and-forget attempt must terminally
    // fail the row (no retry schedule, no HTTP status).
    const settled = await poll<WebhookDelivery>(async () => {
      const [row] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, delivery!.id));
      return row && row.status === 'failed' ? row : undefined;
    });
    expect(settled.error).toContain('unsafe target');
    expect(settled.nextRetryAt).toBeNull();
    expect(settled.statusCode).toBeNull();
    expect(settled.attempts).toBeGreaterThanOrEqual(1);
    // Body/signature are immutable across attempts.
    expect(settled.body).toBe(delivery!.body);
    expect(settled.signature).toBe(delivery!.signature);
  });

  it('attemptDelivery terminally fails a pending row whose webhook is inactive', async () => {
    const inactive = await createWebhook({
      url: `http://aitp-inactive-${randomUUID()}.invalid/hook`,
      events: [],
      secret: 'inactive-secret',
      active: false,
    });
    createdWebhookIds.push(inactive.id);

    const deliveryId = randomUUID();
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      webhookId: inactive.id,
      eventType: 'handshake.complete',
      payload: { runId: RUN_ID },
      status: 'pending',
      attempts: 0,
    });

    await attemptDelivery(deliveryId);

    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));
    expect(row.status).toBe('failed');
    expect(row.error).toBe('webhook missing or inactive');
  });
});
