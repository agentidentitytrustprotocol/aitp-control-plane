/**
 * GET /api/tcts — query observed TCTs.
 *
 * Records are derived from `tct.issued` and `handshake.complete`
 * events; the CP never mints a TCT.
 *
 * Filters:
 *   ?issuer=<aid>      issuer AID exact match
 *   ?subject=<aid>     subject AID exact match
 *   ?audience=<aid>    audience AID exact match
 *   ?capability=<str>  TCT must include the grant
 *   ?active=true       (default false) only TCTs not revoked and not expired
 *   ?sessionId=<id>    handshake session that produced this TCT
 *   ?limit=<n>         max 1000, default 100
 *   ?offset=<n>        default 0
 */

import { NextRequest } from 'next/server';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { issuedTcts } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const wheres: SQL[] = [];
  const issuer = sp.get('issuer');
  if (issuer) wheres.push(eq(issuedTcts.issuerAid, issuer));
  const subject = sp.get('subject');
  if (subject) wheres.push(eq(issuedTcts.subjectAid, subject));
  const audience = sp.get('audience');
  if (audience) wheres.push(eq(issuedTcts.audienceAid, audience));
  const capability = sp.get('capability');
  if (capability) {
    // `grants` is jsonb; the GIN index supports the @> containment op.
    wheres.push(sql`${issuedTcts.grants} @> ${JSON.stringify([capability])}::jsonb`);
  }
  const sessionId = sp.get('sessionId');
  if (sessionId) wheres.push(eq(issuedTcts.sessionId, sessionId));
  if (sp.get('active') === 'true') {
    wheres.push(eq(issuedTcts.revoked, false));
    wheres.push(
      sql`(${issuedTcts.expiresAt} is null or ${issuedTcts.expiresAt} > now())`,
    );
  }
  const limit = Math.min(
    Math.max(parseInt(sp.get('limit') ?? '100', 10) || 100, 1),
    1000,
  );
  const offset = Math.max(parseInt(sp.get('offset') ?? '0', 10) || 0, 0);

  const query = db.select().from(issuedTcts);
  const rows = await (
    wheres.length > 0 ? query.where(and(...wheres)) : query
  )
    .orderBy(desc(issuedTcts.issuedAt))
    .limit(limit)
    .offset(offset);

  return Response.json({
    tcts: rows.map((r) => ({
      jti: r.jti,
      issuer: r.issuerAid,
      subject: r.subjectAid,
      audience: r.audienceAid,
      grants: r.grants,
      bindingCnf: r.bindingCnf,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      sessionId: r.sessionId,
      revoked: r.revoked,
      revokedAt: r.revokedAt,
    })),
  });
}
