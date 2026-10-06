/**
 * Serve the CP-cached JWKS for a trust anchor.
 *
 *   GET /api/trust-anchors/:id/jwks
 *
 * Lets OIDC-mode agents that cannot reach the issuer directly fetch the keyset
 * from the CP. Returns 503 JWKS_NOT_CACHED until the background refresher has
 * populated the cache at least once. Behind the API key like the rest of
 * /api/trust-anchors (not in src/proxy.ts's public lists).
 */

import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { trustAnchors } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // A non-UUID would reach Postgres as an invalid uuid and surface as a 500.
  if (!UUID_RE.test(id)) {
    return Response.json({ error: 'id must be a UUID', code: 'ID_INVALID' }, { status: 400 });
  }

  const [anchor] = await db
    .select()
    .from(trustAnchors)
    .where(eq(trustAnchors.id, id))
    .limit(1);

  if (!anchor) {
    return Response.json({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  if (!anchor.jwksCache) {
    return Response.json(
      {
        error: 'JWKS not yet cached for this trust anchor',
        code: 'JWKS_NOT_CACHED',
        issuerUrl: anchor.issuerUrl,
      },
      { status: 503, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } },
    );
  }

  return Response.json(anchor.jwksCache, {
    headers: {
      'Cache-Control': 'max-age=300',
      // Surface freshness so clients can apply their own staleness policy.
      'X-JWKS-Cached-At': anchor.jwksCachedAt ?? '',
    },
  });
}
