/**
 * GET /api/delegations — query observed delegation chains.
 *
 * Filters:
 *   ?root_jti=<uuid>    return the full descendant tree rooted at this JTI
 *   ?parent_jti=<uuid>  direct children only
 *   ?delegator=<aid>
 *   ?delegatee=<aid>
 *   ?active=true        (default false) only non-revoked, not-expired
 *   ?limit=<n>          max 1000, default 100
 *   ?offset=<n>         default 0
 */

import { NextRequest } from 'next/server';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { delegations } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DelegationRow {
  jti: string;
  parent_jti: string;
  delegator_aid: string;
  delegatee_aid: string;
  scope: string[];
  issued_at: string;
  expires_at: string | null;
  revoked: boolean;
  revoked_at: string | null;
  revoked_reason: string | null;
}

function rowOut(r: DelegationRow) {
  return {
    jti: r.jti,
    parentJti: r.parent_jti,
    delegator: r.delegator_aid,
    delegatee: r.delegatee_aid,
    scope: r.scope,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    revoked: r.revoked,
    revokedAt: r.revoked_at,
    revokedReason: r.revoked_reason,
  };
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;

  // Root-rooted descendant tree query — recursive CTE.
  const rootJti = sp.get('root_jti') ?? sp.get('rootJti');
  if (rootJti) {
    if (!UUID_RE.test(rootJti)) {
      return Response.json(
        { error: 'root_jti must be a UUID', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }
    const result = await db.execute(sql`
      with recursive tree as (
        select * from ${delegations} where jti = ${rootJti}
        union
        select d.* from ${delegations} d
        join tree on d.parent_jti = tree.jti
      )
      select * from tree
      order by issued_at asc
    `);
    const rows = (result as unknown as { rows: DelegationRow[] }).rows;
    return Response.json({ delegations: rows.map(rowOut) });
  }

  const wheres: SQL[] = [];
  const parentJti = sp.get('parent_jti') ?? sp.get('parentJti');
  if (parentJti) {
    if (!UUID_RE.test(parentJti)) {
      return Response.json(
        { error: 'parent_jti must be a UUID', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }
    wheres.push(eq(delegations.parentJti, parentJti));
  }
  const delegator = sp.get('delegator');
  if (delegator) wheres.push(eq(delegations.delegatorAid, delegator));
  const delegatee = sp.get('delegatee');
  if (delegatee) wheres.push(eq(delegations.delegateeAid, delegatee));
  if (sp.get('active') === 'true') {
    wheres.push(eq(delegations.revoked, false));
    wheres.push(
      sql`(${delegations.expiresAt} is null or ${delegations.expiresAt} > now())`,
    );
  }
  const limit = Math.min(
    Math.max(parseInt(sp.get('limit') ?? '100', 10) || 100, 1),
    1000,
  );
  const offset = Math.max(parseInt(sp.get('offset') ?? '0', 10) || 0, 0);

  const query = db.select().from(delegations);
  const rows = await (
    wheres.length > 0 ? query.where(and(...wheres)) : query
  )
    .orderBy(desc(delegations.issuedAt))
    .limit(limit)
    .offset(offset);

  return Response.json({
    delegations: rows.map((r) => ({
      jti: r.jti,
      parentJti: r.parentJti,
      delegator: r.delegatorAid,
      delegatee: r.delegateeAid,
      scope: r.scope,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      revoked: r.revoked,
      revokedAt: r.revokedAt,
      revokedReason: r.revokedReason,
    })),
  });
}
