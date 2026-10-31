import { NextRequest } from 'next/server';
import { asc, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { revocationEntries } from '@/lib/db/schema';
import { parsePagination } from '@/lib/pagination';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/revocation/issuers`: every issuer that has at least one revocation
 * entry, with its entry count, so an admin view can skip the issuers with
 * nothing to relay instead of pulling `GET /api/revocations?iss=` for each.
 *
 * Admin keys only: the gate (src/proxy.ts) accepts an issuer key on
 * `GET /api/revocations` alone, so one is `401` here. One aggregate over the
 * `iss` index, ordered by `iss` so offset pages are stable; entries with no
 * `iss` are relayed to nobody and are not listed. No total: a page shorter
 * than `limit` is the last one.
 */
export async function GET(req: NextRequest) {
  const { limit, offset } = parsePagination(req.nextUrl.searchParams, {
    defaultLimit: 100,
    maxLimit: 1000,
  });
  const rows = await db
    .select({
      iss: revocationEntries.iss,
      entries: sql<number>`count(*)::int`,
    })
    .from(revocationEntries)
    .where(isNotNull(revocationEntries.iss))
    .groupBy(revocationEntries.iss)
    .orderBy(asc(revocationEntries.iss))
    .limit(limit)
    .offset(offset);
  return Response.json(
    { issuers: rows.map((r) => ({ iss: r.iss, entries: Number(r.entries) })), limit, offset },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
