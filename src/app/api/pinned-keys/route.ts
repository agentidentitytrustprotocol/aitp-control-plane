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
import { actorIdFromAuthHeader } from '@/lib/audit-log/actor';
import { withIdempotency } from '@/lib/idempotency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ED25519_PUBKEY_B64URL = /^[A-Za-z0-9_-]{43}$/;

/**
 * The instants `expiresAt` may name, as millisecond bounds.
 *
 * Both ends are the same thing: what this route can WRITE. `expires_at` is
 * `timestamp with time zone` (drizzle/0005_aitp_depth.sql:36) and what we hand it is
 * `Date.prototype.toISOString()` output, which switches to the ISO-8601 expanded-year
 * form outside years 0000-9999 (`+010000-01-01T00:00:00.000Z`) — a form Postgres cannot
 * parse at all. Measured against a live server, sending the string as a bind parameter
 * the way drizzle does:
 *
 *   - `9999-12-31T23:59:59.999Z` stores; one millisecond later is `22009`.
 *   - `0001-01-01T00:00:00.000Z` stores; one millisecond EARLIER is `22008`, because
 *     Postgres has no year zero. So the floor is a year above "the lowest year
 *     toISOString() still renders with four digits" — `0000-…` renders fine and is
 *     rejected anyway. Below that, negative years are `22007`.
 *
 * `new Date(...)` accepts everything outside both ends happily (its own range runs to
 * ±275760), so the `Number.isNaN` check below does NOT subsume this one.
 *
 * Checked against the UTC INSTANT, not the written year, because the instant is what
 * gets serialized: `0001-01-01T00:00:00+14:00` reads as year 0001 but is UTC
 * `0000-12-31T10:00:00Z` and was measured to fail, and `9999-12-31T23:59:59.999-01:00`
 * is UTC year 10000 and likewise.
 *
 * Deliberately NOT the same floor as `MIN_REVOKED_AT_MS` in
 * src/app/api/revocation/entries/route.ts, and deliberately not shared with it. That one
 * floors at the Unix epoch for a reason that does not exist here: the signed revocation
 * list republishes `revoked_at` as seconds since the epoch and re-parses the driver's
 * text on the way out. `pinnedKeys.expiresAt` has no published form and no second reader
 * at all — nothing outside this file, its test and the schema references the table — so
 * the honest bound is the storage limit and nothing more. Two bounds that differ for
 * different reasons are not yet a helper (#115); the reasoning is the part worth keeping
 * next to each.
 *
 * Computed from the boundary literals rather than written as numbers so constant and
 * comment cannot drift; pinned-keys.test.ts pins both ends behaviourally, by asserting
 * the millisecond either side of each.
 */
const MIN_EXPIRES_AT_MS = Date.parse('0001-01-01T00:00:00.000Z'); // -62135596800000
const MAX_EXPIRES_AT_MS = Date.parse('9999-12-31T23:59:59.999Z'); // 253402300799999

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
      // Written as a negated conjunction, NOT as `ms < MIN || ms > MAX`. Both
      // bounds come from `Date.parse`, and if either were ever NaN then every
      // comparison against it is false — the disjunctive form would accept
      // *everything*, failing silently and completely open. This form rejects
      // everything instead, which is the safe direction for a guard whose whole
      // job is to keep a value away from the database.
      const ms = d.getTime();
      if (!(ms >= MIN_EXPIRES_AT_MS && ms <= MAX_EXPIRES_AT_MS)) {
        return {
          status: 400,
          body: {
            error:
              'expiresAt must be between 0001-01-01T00:00:00.000Z and 9999-12-31T23:59:59.999Z',
            code: 'BODY_INVALID',
          },
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
        addedBy: actorIdFromAuthHeader(req.headers.get('authorization')),
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
