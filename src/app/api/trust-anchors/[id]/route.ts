import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { trustAnchors } from '@/lib/db/schema';
import { writeAdminAudit } from '@/lib/audit-log/service';
import {
  badRequest,
  checkColumnString,
  invalidId,
  isUuid,
  readJsonObject,
} from '@/lib/http/validate';
import { NAME_MAX, checkIssuerUrl, checkJwksUrl } from '@/lib/trust-anchors/columns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function rowOut(r: typeof trustAnchors.$inferSelect) {
  return {
    id: r.id,
    namespace: r.namespace,
    issuerUrl: r.issuerUrl,
    jwksUrl: r.jwksUrl,
    label: r.label,
    jwksCachedAt: r.jwksCachedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // `id` is a Postgres uuid column: a non-UUID would fail to parse (22P02)
  // and surface as a 500. Checked before any database access.
  if (!isUuid(id)) return invalidId();
  const rows = await db
    .select()
    .from(trustAnchors)
    .where(eq(trustAnchors.id, id))
    .limit(1);
  if (!rows[0]) {
    return Response.json({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  return Response.json(rowOut(rows[0]));
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return invalidId();
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  // Column checks only (storability). URL-scheme and duplicate-issuer rules
  // for PATCH are not applied here.
  if (typeof body.issuerUrl === 'string') {
    const problem = checkIssuerUrl(body.issuerUrl);
    if (problem) return badRequest(problem);
    patch.issuerUrl = body.issuerUrl;
  }
  if (typeof body.jwksUrl === 'string' || body.jwksUrl === null) {
    // '' clears the explicit JWKS URL (back to OIDC discovery), like null.
    const jwksUrl = body.jwksUrl === '' ? null : body.jwksUrl;
    if (jwksUrl !== null) {
      const problem = checkJwksUrl(jwksUrl);
      if (problem) return badRequest(problem);
    }
    patch.jwksUrl = jwksUrl;
  }
  if (typeof body.label === 'string') {
    const problem = checkColumnString(body.label, { field: 'label', max: NAME_MAX });
    if (problem) return badRequest(problem);
    patch.label = body.label;
  } else if (body.label === null) {
    patch.label = null;
  }
  const updated = await db
    .update(trustAnchors)
    .set(patch)
    .where(eq(trustAnchors.id, id))
    .returning();
  if (!updated[0]) {
    return Response.json({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  await writeAdminAudit({
    action: 'trust-anchor.update',
    targetId: id,
    details: patch,
    requestId: req.headers.get('x-request-id') ?? undefined,
  });
  return Response.json(rowOut(updated[0]));
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return invalidId();
  const deleted = await db
    .delete(trustAnchors)
    .where(eq(trustAnchors.id, id))
    .returning({ id: trustAnchors.id });
  if (!deleted[0]) {
    return Response.json({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  await writeAdminAudit({
    action: 'trust-anchor.delete',
    targetId: id,
    requestId: req.headers.get('x-request-id') ?? undefined,
  });
  return new Response(null, { status: 204 });
}
