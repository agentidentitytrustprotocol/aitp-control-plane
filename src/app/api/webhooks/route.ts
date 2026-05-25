import { NextRequest } from 'next/server';
import {
  createWebhook,
  listWebhooks,
} from '@/lib/webhooks/service';
import { writeAdminAudit } from '@/lib/audit-log/service';

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

interface CreateBody {
  url?: unknown;
  events?: unknown;
  secret?: unknown;
  active?: unknown;
}

export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return Response.json(
      { error: 'body must be JSON', code: 'BODY_INVALID' },
      { status: 400 },
    );
  }
  if (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url)) {
    return Response.json(
      { error: 'url must be an http(s) URL', code: 'BODY_INVALID' },
      { status: 400 },
    );
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
  return Response.json(
    {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      secret: webhook.secret,
      active: webhook.active,
      createdAt: webhook.createdAt,
    },
    { status: 201 },
  );
}
