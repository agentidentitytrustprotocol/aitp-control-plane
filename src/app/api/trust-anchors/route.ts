/**
 * OIDC trust-anchor management.
 *
 *   GET  /api/trust-anchors            list (optionally by ?namespace=)
 *   POST /api/trust-anchors            create
 *
 * Per-anchor routes live at /api/trust-anchors/[id].
 *
 * AITP supports OIDC as one identity mode. This endpoint lets operators
 * centrally manage the trusted issuer set for a namespace so agents
 * don't each ship their own static config.
 */

import { NextRequest } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { trustAnchors } from '@/lib/db/schema';
import { writeAdminAudit } from '@/lib/audit-log/service';
import { withIdempotency } from '@/lib/idempotency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CreateBody {
  namespace?: unknown;
  issuerUrl?: unknown;
  jwksUrl?: unknown;
  label?: unknown;
}

function rowOut(r: typeof trustAnchors.$inferSelect) {
  return {
    id: r.id,
    namespace: r.namespace,
    issuerUrl: r.issuerUrl,
    jwksUrl: r.jwksUrl,
    label: r.label,
    jwksCachedAt: r.jwksCachedAt,
    addedBy: r.addedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function GET(req: NextRequest) {
  const namespace = new URL(req.url).searchParams.get('namespace');
  const query = db.select().from(trustAnchors);
  const rows = await (
    namespace ? query.where(eq(trustAnchors.namespace, namespace)) : query
  ).orderBy(desc(trustAnchors.createdAt));
  return Response.json({ trustAnchors: rows.map(rowOut) });
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

  return withIdempotency(req, 'trust-anchors.create', async () => {
    if (typeof body.issuerUrl !== 'string' || !/^https?:\/\//.test(body.issuerUrl)) {
      return {
        status: 400,
        body: { error: 'issuerUrl must be an http(s) URL', code: 'BODY_INVALID' },
      };
    }
    const namespace =
      typeof body.namespace === 'string' && body.namespace.length > 0
        ? body.namespace
        : 'default';
    const jwksUrl = typeof body.jwksUrl === 'string' ? body.jwksUrl : null;
    const label = typeof body.label === 'string' ? body.label : null;

    // Uniqueness is enforced by the `trust_anchors_namespace_issuer_uniq`
    // index (migration 0006). A check-then-insert here would race;
    // instead we attempt the insert and translate the constraint
    // violation into a 409. The PG driver surfaces it as error code
    // 23505 (unique_violation).
    const id = randomUUID();
    try {
      await db.insert(trustAnchors).values({
        id,
        namespace,
        issuerUrl: body.issuerUrl,
        jwksUrl,
        label,
        addedBy: req.headers.get('authorization')?.slice(7, 19) ?? null,
      });
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        const existing = await db
          .select({ id: trustAnchors.id })
          .from(trustAnchors)
          .where(
            and(
              eq(trustAnchors.namespace, namespace),
              eq(trustAnchors.issuerUrl, body.issuerUrl),
            ),
          )
          .limit(1);
        return {
          status: 409,
          body: {
            error:
              'trust anchor already exists for this (namespace, issuerUrl) — PATCH the existing id to update',
            code: 'ALREADY_EXISTS',
            existing: existing[0] ? { id: existing[0].id } : undefined,
          },
        };
      }
      throw err;
    }
    await writeAdminAudit({
      action: 'trust-anchor.create',
      targetId: id,
      details: { namespace, issuerUrl: body.issuerUrl },
      requestId: req.headers.get('x-request-id') ?? undefined,
    });
    const created = await db
      .select()
      .from(trustAnchors)
      .where(eq(trustAnchors.id, id))
      .limit(1);
    return { status: 201, body: rowOut(created[0]!) };
  });
}
