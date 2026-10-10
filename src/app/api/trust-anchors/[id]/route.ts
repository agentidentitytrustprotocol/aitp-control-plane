import { NextRequest } from 'next/server';
import { type SQL, eq, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { trustAnchors } from '@/lib/db/schema';
import { writeAdminAudit } from '@/lib/audit-log/service';
import {
  badRequest,
  checkColumnString,
  invalidId,
  isHttpUrl,
  isUniqueViolation,
  isUuid,
  readJsonObject,
} from '@/lib/http/validate';
import { NAME_MAX, checkIssuerUrl, checkJwksUrl } from '@/lib/trust-anchors/columns';
import { alreadyExistsBody, findAnchorIdByIssuer } from '@/lib/trust-anchors/existing';

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

/**
 * SQL that is true when the PATCH changes issuer_url or jwks_url, evaluated
 * against the row's current values; `undefined` when neither URL is in the
 * patch (nothing to compare, cache untouched). Explicit `::text` casts keep
 * a NULL parameter typed.
 */
function urlChangedSql(changes: {
  issuerUrl?: string;
  jwksUrl?: string | null;
}): SQL | undefined {
  const parts: SQL[] = [];
  if (changes.issuerUrl !== undefined) {
    parts.push(sql`${trustAnchors.issuerUrl} IS DISTINCT FROM ${changes.issuerUrl}::text`);
  }
  if (changes.jwksUrl !== undefined) {
    parts.push(sql`${trustAnchors.jwksUrl} IS DISTINCT FROM ${changes.jwksUrl}::text`);
  }
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : or(...parts);
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
  // `changes` is what the caller asked for (also the audit details); `patch`
  // is what goes to SET, which may add the cache-clear expressions below.
  const changes: {
    issuerUrl?: string;
    jwksUrl?: string | null;
    label?: string | null;
  } = {};
  if (typeof body.issuerUrl === 'string') {
    // Same rule as POST: an http(s) URL (a non-string is ignored, as for
    // every PATCH field; issuer_url is NOT NULL). Syntax only — the scheme policy
    // (https in production) and SSRF checks run at fetch time in the
    // JWKS refresher.
    if (!isHttpUrl(body.issuerUrl)) return badRequest('issuerUrl must be an http(s) URL');
    const problem = checkIssuerUrl(body.issuerUrl);
    if (problem) return badRequest(problem);
    changes.issuerUrl = body.issuerUrl;
  }
  if (typeof body.jwksUrl === 'string' || body.jwksUrl === null) {
    // '' clears the explicit JWKS URL (back to OIDC discovery), like null.
    const jwksUrl = body.jwksUrl === '' ? null : body.jwksUrl;
    if (jwksUrl !== null) {
      if (!isHttpUrl(jwksUrl)) return badRequest('jwksUrl must be an http(s) URL');
      const problem = checkJwksUrl(jwksUrl);
      if (problem) return badRequest(problem);
    }
    changes.jwksUrl = jwksUrl;
  }
  if (typeof body.label === 'string') {
    const problem = checkColumnString(body.label, { field: 'label', max: NAME_MAX });
    if (problem) return badRequest(problem);
    changes.label = body.label;
  } else if (body.label === null) {
    changes.label = null;
  }

  const patch: Record<string, unknown> = {
    ...changes,
    updatedAt: new Date().toISOString(),
  };
  const urlChanged = urlChangedSql(changes);
  if (urlChanged) {
    // The cached keyset belongs to the issuer it was fetched from. Drop it
    // when — and only when — issuer_url or jwks_url actually changes. Decided
    // in SQL against the row being updated (SET expressions see the OLD row),
    // so it is atomic with the URL write and a label-only edit, or an edit
    // that resends the current URLs (ui-console sends both on every save),
    // keeps the cache. GET /jwks then answers 503 JWKS_NOT_CACHED until the
    // refresher's next pass; there is deliberately no route-triggered refresh.
    patch.jwksCache = sql`CASE WHEN ${urlChanged} THEN NULL ELSE ${trustAnchors.jwksCache} END`;
    patch.jwksCachedAt = sql`CASE WHEN ${urlChanged} THEN NULL ELSE ${trustAnchors.jwksCachedAt} END`;
  }

  let updated: (typeof trustAnchors.$inferSelect)[];
  try {
    updated = await db
      .update(trustAnchors)
      .set(patch)
      .where(eq(trustAnchors.id, id))
      .returning();
  } catch (err) {
    // A new issuerUrl that another anchor in the same namespace already uses
    // (trust_anchors_namespace_issuer_uniq). namespace is not patchable, so
    // it comes from this anchor's row.
    if (isUniqueViolation(err) && changes.issuerUrl !== undefined) {
      const [row] = await db
        .select({ namespace: trustAnchors.namespace })
        .from(trustAnchors)
        .where(eq(trustAnchors.id, id))
        .limit(1);
      const existingId = row
        ? await findAnchorIdByIssuer(row.namespace, changes.issuerUrl)
        : undefined;
      return Response.json(alreadyExistsBody(existingId), { status: 409 });
    }
    throw err;
  }
  if (!updated[0]) {
    return Response.json({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  await writeAdminAudit({
    action: 'trust-anchor.update',
    targetId: id,
    details: { ...changes, updatedAt: patch.updatedAt },
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
