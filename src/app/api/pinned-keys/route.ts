/**
 * Pinned-key trust store management.
 *
 *   GET    /api/pinned-keys[?namespace=&aid=]   list / lookup
 *   POST   /api/pinned-keys                     upsert one
 *   DELETE /api/pinned-keys?namespace=&aid=     remove one
 *
 * Composite primary key is (namespace, aid), so we don't expose an
 * `id`-shaped subresource — operations are keyed by query params on the
 * collection URL.
 */

import { NextRequest } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { pinnedKeys } from '@/lib/db/schema';
import { writeAdminAudit } from '@/lib/audit-log/service';
import { withIdempotency } from '@/lib/idempotency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ED25519_PUBKEY_B64URL = /^[A-Za-z0-9_-]{43}$/;

interface CreateBody {
  namespace?: unknown;
  aid?: unknown;
  pubkey?: unknown;
  label?: unknown;
  expiresAt?: unknown;
}

function rowOut(r: typeof pinnedKeys.$inferSelect) {
  return {
    namespace: r.namespace,
    aid: r.aid,
    pubkey: r.pubkey,
    label: r.label,
    expiresAt: r.expiresAt,
    addedBy: r.addedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const namespace = sp.get('namespace');
  const aid = sp.get('aid');

  if (aid) {
    const ns = namespace ?? 'default';
    const rows = await db
      .select()
      .from(pinnedKeys)
      .where(and(eq(pinnedKeys.namespace, ns), eq(pinnedKeys.aid, aid)))
      .limit(1);
    if (!rows[0]) {
      return Response.json({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
    }
    return Response.json(rowOut(rows[0]));
  }

  const query = db.select().from(pinnedKeys);
  const rows = await (
    namespace ? query.where(eq(pinnedKeys.namespace, namespace)) : query
  ).orderBy(desc(pinnedKeys.createdAt));
  return Response.json({ pinnedKeys: rows.map(rowOut) });
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
  return withIdempotency(req, 'pinned-keys.upsert', async () => {
    if (typeof body.aid !== 'string' || body.aid.length === 0) {
      return {
        status: 400,
        body: { error: 'aid is required', code: 'BODY_INVALID' },
      };
    }
    if (typeof body.pubkey !== 'string' || !ED25519_PUBKEY_B64URL.test(body.pubkey)) {
      return {
        status: 400,
        body: {
          error: 'pubkey must be a 43-char base64url Ed25519 public key',
          code: 'BODY_INVALID',
        },
      };
    }
    const namespace =
      typeof body.namespace === 'string' && body.namespace.length > 0
        ? body.namespace
        : 'default';
    const label = typeof body.label === 'string' ? body.label : null;
    let expiresAt: string | null = null;
    if (typeof body.expiresAt === 'string') {
      const d = new Date(body.expiresAt);
      if (Number.isNaN(d.getTime())) {
        return {
          status: 400,
          body: { error: 'expiresAt must be a parseable date', code: 'BODY_INVALID' },
        };
      }
      expiresAt = d.toISOString();
    }

    await db
      .insert(pinnedKeys)
      .values({
        namespace,
        aid: body.aid,
        pubkey: body.pubkey,
        label,
        expiresAt,
        addedBy: req.headers.get('authorization')?.slice(7, 19) ?? null,
      })
      .onConflictDoUpdate({
        target: [pinnedKeys.namespace, pinnedKeys.aid],
        set: {
          pubkey: body.pubkey,
          label,
          expiresAt,
          updatedAt: new Date().toISOString(),
        },
      });
    await writeAdminAudit({
      action: 'pinned-key.upsert',
      targetId: body.aid,
      details: { namespace },
      requestId: req.headers.get('x-request-id') ?? undefined,
    });
    const rows = await db
      .select()
      .from(pinnedKeys)
      .where(and(eq(pinnedKeys.namespace, namespace), eq(pinnedKeys.aid, body.aid)))
      .limit(1);
    return { status: 201, body: rowOut(rows[0]!) };
  });
}

export async function DELETE(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const namespace = sp.get('namespace') ?? 'default';
  const aid = sp.get('aid');
  if (!aid) {
    return Response.json(
      { error: 'aid query param required', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }
  const deleted = await db
    .delete(pinnedKeys)
    .where(and(eq(pinnedKeys.namespace, namespace), eq(pinnedKeys.aid, aid)))
    .returning({ aid: pinnedKeys.aid });
  if (!deleted[0]) {
    return Response.json({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  await writeAdminAudit({
    action: 'pinned-key.delete',
    targetId: aid,
    details: { namespace },
    requestId: req.headers.get('x-request-id') ?? undefined,
  });
  return new Response(null, { status: 204 });
}
