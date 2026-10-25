import { NextRequest } from 'next/server';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { revocationEntries } from '@/lib/db/schema';
import { AID_RE } from '@/lib/api-keys';
import { KEY_ISSUER_HEADER, KEY_LABEL_HEADER } from '@/lib/audit-log/actor';
import { recordIssuerPull } from '@/lib/revocation/relay-metrics';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/revocations?iss=<aid>`: the revocation entries recorded for TCTs
 * that `iss` issued, for that issuer to sign and serve as its own list.
 *
 * The CP is a registry and relay, never a revocation authority: RFC-AITP-0008
 * §1.5 makes a list valid only for tokens its own signer issued, and a
 * verifier discards a third-party-signed one (spec fixture rev-011). So the CP
 * signs nothing here. The issuing agent pulls this, signs the entries with its
 * own key (`signRevocationList` / `sign_revocation_list`) and serves the list
 * at its Manifest's revocation endpoint. Each answer is the issuer's FULL
 * entry set, not a delta, so a pull can replace the previous snapshot.
 *
 * Who may ask: an issuer key (`ISSUER_KEYS`) for its own AID only, and any
 * other `iss` is `403 ISSUER_MISMATCH`. An admin key (`API_KEYS`) may read any
 * `iss` (operators already write these entries). The gate (src/proxy.ts) sets
 * KEY_ISSUER_HEADER for an issuer key and strips any client-supplied copy.
 */
export async function GET(req: NextRequest) {
  const iss = req.nextUrl.searchParams.get('iss');
  if (iss === null || !AID_RE.test(iss)) {
    return Response.json(
      { error: 'iss must be an issuer AID (aid:...)', code: 'ISS_INVALID' },
      { status: 400 },
    );
  }

  const boundIssuer = req.headers.get(KEY_ISSUER_HEADER);
  if (boundIssuer !== null && boundIssuer !== iss) {
    return Response.json(
      { error: 'this key may only read its own issuer', code: 'ISSUER_MISMATCH' },
      { status: 403 },
    );
  }

  let rows: { jti: string; revokedAt: number; reason: string | null }[];
  try {
    rows = await db
      .select({
        jti: revocationEntries.jti,
        // Epoch seconds computed by Postgres, not parsed from the driver's
        // timestamp text with `new Date` (which mis-reads years 0001-0099 via
        // V8's two-digit-year rule). Exact for any timestamptz (< 2^53).
        revokedAt: sql<number>`floor(extract(epoch from ${revocationEntries.revokedAt}))::double precision`,
        reason: revocationEntries.reason,
      })
      .from(revocationEntries)
      .where(eq(revocationEntries.iss, iss))
      .orderBy(asc(revocationEntries.revokedAt), asc(revocationEntries.jti));
  } catch (err) {
    // Fail closed and say so: an empty 200 would tell the issuer "nothing is
    // revoked", and it would publish that. A 503 makes it keep its last list.
    logger.error({ err, iss }, 'revocation relay read failed');
    return Response.json(
      { error: 'revocation entries temporarily unavailable', code: 'REVOCATION_UNAVAILABLE' },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } },
    );
  }

  if (boundIssuer !== null) {
    const label = req.headers.get(KEY_LABEL_HEADER);
    if (label) recordIssuerPull(label);
  }

  return Response.json(
    {
      iss,
      // RFC-AITP-0008 entry shape, ready to sign: `reason` only when set.
      entries: rows.map((r) => ({
        jti: r.jti,
        revoked_at: Number(r.revokedAt),
        ...(r.reason !== null ? { reason: r.reason } : {}),
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
