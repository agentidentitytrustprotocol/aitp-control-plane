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
import { actorIdFromAuthHeader } from '@/lib/audit-log/actor';
import { withIdempotency } from '@/lib/idempotency';
import {
  badRequest,
  checkColumnString,
  checkQueryParam,
  isHttpUrl,
  isUniqueViolation,
  readJsonObject,
} from '@/lib/http/validate';
import {
  NAME_MAX,
  checkIssuerUrl,
  checkJwksUrl,
} from '@/lib/trust-anchors/columns';

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
    addedBy: r.addedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function GET(req: NextRequest) {
  const namespace = new URL(req.url).searchParams.get('namespace');
  const bad = checkQueryParam(namespace, 'namespace');
  if (bad) return badRequest(bad, 'BAD_REQUEST');
  const query = db.select().from(trustAnchors);
  const rows = await (
    namespace ? query.where(eq(trustAnchors.namespace, namespace)) : query
  ).orderBy(desc(trustAnchors.createdAt));
  return Response.json({ trustAnchors: rows.map(rowOut) });
}

export async function POST(req: NextRequest) {
  // Non-JSON and non-object bodies (incl. `null`) are answered before the
  // idempotency layer and never stored; field 400s below are inside it.
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  return withIdempotency(req, 'trust-anchors.create', async () => {
    const invalid = (error: string) => ({
      status: 400,
      body: { error, code: 'BODY_INVALID' },
    });
    const issuerUrl = body.issuerUrl;
    if (!isHttpUrl(issuerUrl)) {
      return invalid('issuerUrl must be an http(s) URL');
    }
    const issuerProblem = checkIssuerUrl(issuerUrl);
    if (issuerProblem) return invalid(issuerProblem);
    const namespace =
      typeof body.namespace === 'string' && body.namespace.length > 0
        ? body.namespace
        : 'default';
    const nsProblem = checkColumnString(namespace, { field: 'namespace', max: NAME_MAX });
    if (nsProblem) return invalid(nsProblem);
    // An empty string means "no explicit JWKS URL" (OIDC discovery), same as
    // null/absent — never stored as ''.
    const jwksUrl =
      typeof body.jwksUrl === 'string' && body.jwksUrl.length > 0 ? body.jwksUrl : null;
    if (jwksUrl !== null) {
      if (!isHttpUrl(jwksUrl)) return invalid('jwksUrl must be an http(s) URL');
      const jwksProblem = checkJwksUrl(jwksUrl);
      if (jwksProblem) return invalid(jwksProblem);
    }
    const label = typeof body.label === 'string' ? body.label : null;
    if (label !== null) {
      const labelProblem = checkColumnString(label, { field: 'label', max: NAME_MAX });
      if (labelProblem) return invalid(labelProblem);
    }

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
        issuerUrl,
        jwksUrl,
        label,
        addedBy: actorIdFromAuthHeader(req.headers.get('authorization')),
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await db
          .select({ id: trustAnchors.id })
          .from(trustAnchors)
          .where(
            and(
              eq(trustAnchors.namespace, namespace),
              eq(trustAnchors.issuerUrl, issuerUrl),
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
      details: { namespace, issuerUrl },
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
