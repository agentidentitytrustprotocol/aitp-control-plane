import { NextRequest } from 'next/server';
import { deleteWebhook, updateWebhook } from '@/lib/webhooks/service';
import {
  assertSafeWebhookUrl,
  UnsafeWebhookUrlError,
} from '@/lib/webhooks/url-guard';
import { writeAdminAudit } from '@/lib/audit-log/service';
import { badRequest, invalidId, isUuid, readJsonObject } from '@/lib/http/validate';
import { checkWebhookFields } from '@/lib/webhooks/validate-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // `webhooks.id` is a Postgres uuid: a non-UUID would fail to parse (22P02)
  // and surface as a 500. Checked before the body is read.
  if (!isUuid(id)) return invalidId();
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const fieldProblem = checkWebhookFields(body);
  if (fieldProblem) return badRequest(fieldProblem);
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
  // NEVER put the secret in the audit details: GET /api/audit returns them to
  // any API-key holder. Record only that it was rotated.
  const { secret, ...auditDetails } = patch;
  await writeAdminAudit({
    action: 'webhook.update',
    targetId: id,
    details: secret !== undefined ? { ...auditDetails, secretRotated: true } : auditDetails,
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
  if (!isUuid(id)) return invalidId();
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
