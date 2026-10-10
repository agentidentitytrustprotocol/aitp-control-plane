import { NextRequest } from 'next/server';
import {
  createWebhook,
  listWebhooks,
} from '@/lib/webhooks/service';
import {
  assertSafeWebhookUrl,
  UnsafeWebhookUrlError,
} from '@/lib/webhooks/url-guard';
import { writeAdminAudit } from '@/lib/audit-log/service';
import { withIdempotency } from '@/lib/idempotency';
import { readJsonObject } from '@/lib/http/validate';
import { checkWebhookFields } from '@/lib/webhooks/validate-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const all = await listWebhooks();
  return Response.json({
    webhooks: all.map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events,
      active: w.active,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  // Non-JSON and non-object bodies (incl. `null`) are answered before the
  // idempotency layer and never stored; field 400s below are inside it.
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  return withIdempotency(req, 'webhooks.create', async () => {
    if (typeof body.url !== 'string') {
      return {
        status: 400,
        body: { error: 'url must be an http(s) URL', code: 'BODY_INVALID' },
      };
    }
    const fieldProblem = checkWebhookFields(body);
    if (fieldProblem) {
      return { status: 400, body: { error: fieldProblem, code: 'BODY_INVALID' } };
    }
    try {
      await assertSafeWebhookUrl(body.url);
    } catch (err) {
      if (err instanceof UnsafeWebhookUrlError) {
        return {
          status: 400,
          body: { error: err.message, code: 'URL_NOT_ALLOWED' },
        };
      }
      throw err;
    }
    const events = Array.isArray(body.events)
      ? body.events.filter((e): e is string => typeof e === 'string')
      : [];
    const webhook = await createWebhook({
      url: body.url,
      events,
      secret: typeof body.secret === 'string' ? body.secret : undefined,
      active: typeof body.active === 'boolean' ? body.active : true,
    });
    await writeAdminAudit({
      action: 'webhook.create',
      targetId: webhook.id,
      details: { url: webhook.url, events: webhook.events },
      requestId: req.headers.get('x-request-id') ?? undefined,
    });
    return {
      status: 201,
      body: {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        secret: webhook.secret,
        active: webhook.active,
        createdAt: webhook.createdAt,
      },
    };
  });
}
