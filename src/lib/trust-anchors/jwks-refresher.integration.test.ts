/**
 * Integration test for the JWKS refresher against a real Postgres. `fetch` and
 * DNS are stubbed so no network egress is needed; the DB paths are real.
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
import { refreshStaleJwks } from './jwks-refresher';
import { GET as jwksGet } from '@/app/api/trust-anchors/[id]/jwks/route';

const realFetch = global.fetch;
const SAMPLE_JWKS = { keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'abc', kid: 'k1' }] };

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const fn = jest.fn(async (input: unknown) => handler(String(input)));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('integration: JWKS refresher', () => {
  const ids: string[] = [];

  afterEach(() => {
    global.fetch = realFetch;
  });

  afterAll(async () => {
    for (const id of ids) {
      await db.delete(trustAnchors).where(eq(trustAnchors.id, id));
    }
    await pool.end();
  });

  async function insertAnchor(jwksUrl: string | null, issuerUrl?: string): Promise<string> {
    const id = randomUUID();
    ids.push(id);
    await db.insert(trustAnchors).values({
      id,
      namespace: `jwks-it-${id.slice(0, 8)}`,
      issuerUrl: issuerUrl ?? `https://issuer-${id.slice(0, 8)}.example.com`,
      jwksUrl,
    });
    return id;
  }

  async function row(id: string) {
    const [r] = await db.select().from(trustAnchors).where(eq(trustAnchors.id, id));
    return r;
  }

  it('populates the cache for an anchor with an explicit jwks_url', async () => {
    const id = await insertAnchor('https://issuer.example.com/jwks.json');
    stubFetch(() => Response.json(SAMPLE_JWKS));

    expect(await refreshStaleJwks()).toBeGreaterThanOrEqual(1);

    const r = await row(id);
    expect(r.jwksCache).toEqual(SAMPLE_JWKS);
    expect(r.jwksCachedAt).not.toBeNull();
  });

  it('does OIDC discovery when the anchor has no jwks_url', async () => {
    const issuer = `https://disco-${randomUUID().slice(0, 8)}.example.com`;
    const id = await insertAnchor(null, issuer);
    const calls = stubFetch((url) =>
      url.endsWith('/.well-known/openid-configuration')
        ? Response.json({ jwks_uri: `${issuer}/keys` })
        : url === `${issuer}/keys`
          ? Response.json(SAMPLE_JWKS)
          : new Response('?', { status: 404 }),
    );
    await refreshStaleJwks();
    expect((await row(id)).jwksCache).toEqual(SAMPLE_JWKS);
    expect(calls.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([`${issuer}/.well-known/openid-configuration`, `${issuer}/keys`]),
    );
  });

  it('serves the cached JWKS via the endpoint, 503 before caching', async () => {
    const id = await insertAnchor('https://issuer2.example.com/jwks.json');
    const req = () =>
      jwksGet(new NextRequest(`http://localhost/api/trust-anchors/${id}/jwks`), {
        params: Promise.resolve({ id }),
      });

    const before = await req();
    expect(before.status).toBe(503);
    expect(((await before.json()) as { code: string }).code).toBe('JWKS_NOT_CACHED');

    stubFetch(() => Response.json(SAMPLE_JWKS));
    await refreshStaleJwks();

    const after = await req();
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual(SAMPLE_JWKS);
    expect(after.headers.get('x-jwks-cached-at')).toBeTruthy();
  });

  it('endpoint: 400 for a non-UUID id, 404 for an unknown one', async () => {
    const call = (id: string) =>
      jwksGet(new NextRequest(`http://localhost/api/trust-anchors/${id}/jwks`), {
        params: Promise.resolve({ id }),
      });
    expect((await call('nope')).status).toBe(400);
    expect((await call(randomUUID())).status).toBe(404);
  });

  it('does not cache when the JWKS response lacks a keys array', async () => {
    const id = await insertAnchor('https://issuer3.example.com/jwks.json');
    stubFetch(() => Response.json({ not: 'a keyset' }));
    await refreshStaleJwks();
    expect((await row(id)).jwksCache).toBeNull();
  });

  it('never fetches a private discovery target (SSRF), and leaves the cache empty', async () => {
    const issuer = `https://ssrf-${randomUUID().slice(0, 8)}.example.com`;
    const id = await insertAnchor(null, issuer);
    const calls = stubFetch((url) =>
      url.endsWith('/.well-known/openid-configuration')
        ? Response.json({ jwks_uri: 'http://169.254.169.254/latest/meta-data' })
        : new Response('secret', { status: 200 }),
    );
    await refreshStaleJwks();
    expect((await row(id)).jwksCache).toBeNull();
    expect(calls.mock.calls.map((c) => String(c[0]))).not.toContain(
      'http://169.254.169.254/latest/meta-data',
    );
  });
});
