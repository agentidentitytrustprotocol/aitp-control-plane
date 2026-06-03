import { NextRequest } from 'next/server';
import { deleteWebhook, updateWebhook } from '@/lib/webhooks/service';
import {
  assertSafeWebhookUrl,
  UnsafeWebhookUrlError,
} from '@/lib/webhooks/url-guard';
import { writeAdminAudit } from '@/lib/audit-log/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PatchBody {
  url?: unknown;
  events?: unknown;
  secret?: unknown;
  active?: unknown;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return Response.json(
      { error: 'body must be JSON', code: 'BODY_INVALID' },
      { status: 400 },
    );
  }
  const patch: {
    url?: string;
    events?: string[];
    secret?: string;
    active?: boolean;
  } = {};
  if (typeof body.url === 'string') {
    try {
      await assertSafeWebhookUrl(body.url);
    } catch (err) {
      if (err instanceof UnsafeWebhookUrlError) {
        return Response.json(
          { error: err.message, code: 'URL_NOT_ALLOWED' },
          { status: 400 },
        );
      }
      throw err;
    }
    patch.url = body.url;
  }
  if (Array.isArray(body.events)) {
    patch.events = body.events.filter((e): e is string => typeof e === 'string');
  }
  if (typeof body.secret === 'string') patch.secret = body.secret;
  if (typeof body.active === 'boolean') patch.active = body.active;

  const updated = await updateWebhook(id, patch);
  if (!updated) {
    return Response.json(
      { error: 'webhook not found', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }
  await writeAdminAudit({
    action: 'webhook.update',
    targetId: id,
    details: patch,
    requestId: req.headers.get('x-request-id') ?? undefined,
  });
  return Response.json({
    id: updated.id,
    url: updated.url,
    events: updated.events,
    active: updated.active,
    updatedAt: updated.updatedAt,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = await deleteWebhook(id);
  if (!ok) {
    return Response.json(
      { error: 'webhook not found', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }
  await writeAdminAudit({
    action: 'webhook.delete',
    targetId: id,
    requestId: req.headers.get('x-request-id') ?? undefined,
  });
  return Response.json({ id, deleted: true });
}
