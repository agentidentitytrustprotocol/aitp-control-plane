/**
 * Integration: the aitp/0.3 version sweep's predicate against real Postgres
 * (`manifest_json` is text; the jsonb path only runs in a real database).
 *
 * Read-only over the seeded rows: running the sweep itself here would retire
 * the active agents other suites seed concurrently.
 */

import { and, inArray } from 'drizzle-orm';
import { db, pool } from '@/lib/db';
import { agents } from '@/lib/db/schema';
import { upsertAgent } from '@/lib/registry/store';
import { unsupportedManifestVersion } from '@/lib/registry/expiry-job';

const tag = `expiry-it-${Date.now()}`;
const rows: Record<string, string> = {
  [`aid:test:${tag}:v03`]: JSON.stringify({ manifest: { version: 'aitp/0.3' }, signature: 's' }),
  [`aid:test:${tag}:v02`]: JSON.stringify({ manifest: { version: 'aitp/0.2' }, signature: 's' }),
  [`aid:test:${tag}:none`]: JSON.stringify({ manifest: {}, signature: 's' }),
  [`aid:test:${tag}:empty`]: '{}',
};
const aids = Object.keys(rows);

beforeAll(async () => {
  for (const aid of aids) {
    await upsertAgent({
      aid,
      displayName: aid,
      handshakeEndpoint: 'https://x.example/h',
      offeredCaps: [],
      manifestJson: rows[aid],
      manifestExpiresAt: null,
    });
  }
});

afterAll(async () => {
  await db.delete(agents).where(inArray(agents.aid, aids));
  await pool.end();
});

it('matches every active row whose Manifest is not aitp/0.3', async () => {
  const hit = await db
    .select({ aid: agents.aid })
    .from(agents)
    .where(and(inArray(agents.aid, aids), unsupportedManifestVersion));
  expect(hit.map((r) => r.aid).sort()).toEqual(
    [`aid:test:${tag}:v02`, `aid:test:${tag}:none`, `aid:test:${tag}:empty`].sort(),
  );
});
