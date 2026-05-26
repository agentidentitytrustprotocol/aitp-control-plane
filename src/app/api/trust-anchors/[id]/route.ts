import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { trustAnchors } from '@/lib/db/schema';
import { writeAdminAudit } from '@/lib/audit-log/service';

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

interface PatchBody {
  issuerUrl?: unknown;
  jwksUrl?: unknown;
  label?: unknown;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return Response.json(
      { error: 'body must be JSON', code: 'BODY_INVALID' },
      { status: 400 },
    );
  }
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (typeof body.issuerUrl === 'string') patch.issuerUrl = body.issuerUrl;
  if (typeof body.jwksUrl === 'string' || body.jwksUrl === null)
    patch.jwksUrl = body.jwksUrl;
  if (typeof body.label === 'string' || body.label === null) patch.label = body.label;
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
