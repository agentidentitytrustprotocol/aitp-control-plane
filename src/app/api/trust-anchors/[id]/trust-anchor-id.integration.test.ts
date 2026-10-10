/**
 * Integration test (real Postgres) for PATCH /api/trust-anchors/:id URL
 * semantics: the JWKS cache is cleared atomically when — and only when —
 * issuer_url or jwks_url actually changes; a duplicate (namespace, issuerUrl)
 * is a 409; and a refresher pass that read the OLD URLs cannot repopulate the
 * cache after the change. `fetch` and DNS are stubbed; the DB paths are real.
 */

import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

jest.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34' }],
}));

import { db, pool } from '@/lib/db';
import { trustAnchors } from '@/lib/db/schema';
import { refreshStaleJwks } from '@/lib/trust-anchors/jwks-refresher';
import { PATCH } from './route';
import { GET as jwksGet } from './jwks/route';
import { POST } from '../route';

const realFetch = global.fetch;
const OLD_JWKS = { keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'old', kid: 'old' }] };
const NEW_JWKS = { keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'new', kid: 'new' }] };
const CACHED_AT = '2026-01-01T00:00:00.000Z';

afterAll(async () => {
  await pool.end();
});

describe('integration: PATCH /api/trust-anchors/:id URL changes vs the JWKS cache', () => {
  const ids: string[] = [];

  afterEach(() => {
    global.fetch = realFetch;
  });

  afterAll(async () => {
    for (const id of ids) {
      await db.delete(trustAnchors).where(eq(trustAnchors.id, id));
    }
  });

  /** An anchor with a populated (old-issuer) cache. */
  async function insertCachedAnchor(opts: { namespace?: string; jwksUrl?: string | null } = {}) {
    const id = randomUUID();
    ids.push(id);
    const tag = id.slice(0, 8);
    const issuerUrl = `https://issuer-${tag}.example.com`;
    const jwksUrl =
      opts.jwksUrl === undefined ? `https://issuer-${tag}.example.com/jwks.json` : opts.jwksUrl;
    await db.insert(trustAnchors).values({
      id,
      namespace: opts.namespace ?? `ta-patch-it-${tag}`,
      issuerUrl,
      jwksUrl,
      label: 'before',
      jwksCache: OLD_JWKS,
      jwksCachedAt: CACHED_AT,
    });
    return { id, issuerUrl, jwksUrl };
  }

  async function row(id: string) {
    const [r] = await db.select().from(trustAnchors).where(eq(trustAnchors.id, id));
    return r;
  }

  function patch(id: string, body: unknown) {
    return PATCH(
      new NextRequest(`http://localhost/api/trust-anchors/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  function getJwks(id: string) {
    return jwksGet(new NextRequest(`http://localhost/api/trust-anchors/${id}/jwks`), {
      params: Promise.resolve({ id }),
    });
  }

  it('keeps the cache for a label-only edit and when both URLs are resent unchanged', async () => {
    const a = await insertCachedAnchor();
    // ui-console sends both URLs on every edit.
    const res = await patch(a.id, { issuerUrl: a.issuerUrl, jwksUrl: a.jwksUrl, label: 'after' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { label: string }).label).toBe('after');
    let r = await row(a.id);
    expect(r.jwksCache).toEqual(OLD_JWKS);
    expect(new Date(r.jwksCachedAt!).toISOString()).toBe(CACHED_AT);

    expect((await patch(a.id, { label: 'again' })).status).toBe(200);
    r = await row(a.id);
    expect(r.jwksCache).toEqual(OLD_JWKS);
    expect((await getJwks(a.id)).status).toBe(200);
  });

  it('keeps the cache when a null jwksUrl is resent as null or ""', async () => {
    const a = await insertCachedAnchor({ jwksUrl: null });
    expect((await patch(a.id, { issuerUrl: a.issuerUrl, jwksUrl: '' })).status).toBe(200);
    expect((await row(a.id)).jwksCache).toEqual(OLD_JWKS);
    expect((await patch(a.id, { jwksUrl: null })).status).toBe(200);
    expect((await row(a.id)).jwksCache).toEqual(OLD_JWKS);
  });

  it('a changed jwksUrl clears the cache; GET /jwks is 503 JWKS_NOT_CACHED', async () => {
    const a = await insertCachedAnchor();
    const res = await patch(a.id, {
      issuerUrl: a.issuerUrl,
      jwksUrl: `${a.issuerUrl}/rotated.json`,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { jwksCachedAt: unknown }).jwksCachedAt).toBeNull();
    const r = await row(a.id);
    expect(r.jwksUrl).toBe(`${a.issuerUrl}/rotated.json`);
    expect(r.jwksCache).toBeNull();
    expect(r.jwksCachedAt).toBeNull();

    const jwks = await getJwks(a.id);
    expect(jwks.status).toBe(503);
    expect(((await jwks.json()) as { code: string }).code).toBe('JWKS_NOT_CACHED');
  });

  it('a changed issuerUrl, and jwksUrl -> null (back to discovery), each clear the cache', async () => {
    const a = await insertCachedAnchor();
    expect((await patch(a.id, { issuerUrl: `${a.issuerUrl}/v2` })).status).toBe(200);
    expect((await row(a.id)).jwksCache).toBeNull();

    const b = await insertCachedAnchor();
    expect((await patch(b.id, { jwksUrl: null })).status).toBe(200);
    expect((await row(b.id)).jwksCache).toBeNull();
  });

  it('a refresher write computed against the old URLs is a no-op after the URL change', async () => {
    // Stale (never cached) anchor, so the refresher picks it up.
    const id = randomUUID();
    ids.push(id);
    const tag = id.slice(0, 8);
    const oldJwksUrl = `https://race-${tag}.example.com/old.json`;
    const newJwksUrl = `https://race-${tag}.example.com/new.json`;
    await db.insert(trustAnchors).values({
      id,
      namespace: `ta-race-it-${tag}`,
      issuerUrl: `https://race-${tag}.example.com`,
      jwksUrl: oldJwksUrl,
    });

    // The PATCH lands while the refresher's fetch of the OLD URL is in flight.
    let patched = false;
    global.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url === oldJwksUrl) {
        const res = await patch(id, { jwksUrl: newJwksUrl });
        expect(res.status).toBe(200);
        patched = true;
        return Response.json(OLD_JWKS);
      }
      return Response.json({ keys: [] });
    }) as typeof fetch;

    await refreshStaleJwks();
    expect(patched).toBe(true);
    let r = await row(id);
    expect(r.jwksUrl).toBe(newJwksUrl);
    expect(r.jwksCache).toBeNull();
    expect(r.jwksCachedAt).toBeNull();
    expect((await getJwks(id)).status).toBe(503);

    // The next pass fetches the NEW URL and caches its keys.
    global.fetch = (async (input: unknown) =>
      String(input) === newJwksUrl
        ? Response.json(NEW_JWKS)
        : Response.json({ keys: [] })) as typeof fetch;
    await refreshStaleJwks();
    r = await row(id);
    expect(r.jwksCache).toEqual(NEW_JWKS);
  });

  it('a duplicate (namespace, issuerUrl) is 409 ALREADY_EXISTS with existing.id; row unchanged', async () => {
    const namespace = `ta-dup-it-${randomUUID().slice(0, 8)}`;
    const a = await insertCachedAnchor({ namespace });
    const b = await insertCachedAnchor({ namespace });
    const res = await patch(b.id, { issuerUrl: a.issuerUrl, label: 'clash' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; existing: { id: string } };
    expect(body.code).toBe('ALREADY_EXISTS');
    expect(body.existing).toEqual({ id: a.id });
    const r = await row(b.id);
    expect(r.issuerUrl).toBe(b.issuerUrl);
    expect(r.label).toBe('before');
    expect(r.jwksCache).toEqual(OLD_JWKS);
  });

  it('the same issuerUrl in a different namespace is allowed', async () => {
    const a = await insertCachedAnchor();
    const b = await insertCachedAnchor();
    expect((await patch(b.id, { issuerUrl: a.issuerUrl })).status).toBe(200);
  });
});

describe('integration: POST /api/trust-anchors duplicate', () => {
  it('a duplicate (namespace, issuerUrl) is 409 ALREADY_EXISTS with existing.id (drizzle-wrapped 23505)', async () => {
    const namespace = `ta-post-dup-${randomUUID().slice(0, 8)}`;
    const issuerUrl = `https://${namespace}.example.com`;
    const post = () =>
      POST(
        new NextRequest('http://localhost/api/trust-anchors', {
          method: 'POST',
          body: JSON.stringify({ namespace, issuerUrl }),
        }),
      );
    const first = await post();
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    try {
      const dup = await post();
      expect(dup.status).toBe(409);
      expect(await dup.json()).toMatchObject({ code: 'ALREADY_EXISTS', existing: { id } });
    } finally {
      await db.delete(trustAnchors).where(eq(trustAnchors.id, id));
    }
  });
});
