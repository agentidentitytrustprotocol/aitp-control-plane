// Unit tests for GET /api/trust-anchors/[id]/jwks.
//   • 400 ID_INVALID for a non-UUID :id, before any db access
//   • 404 for an unknown id, 503 JWKS_NOT_CACHED before the first refresh,
//     200 + freshness header once cached
//   • any UUID version is accepted syntactically (a v7-shaped id reaches the db)

import { jest } from '@jest/globals';

let selectResult: unknown[] = [];
let dbCalls = 0;

jest.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(selectResult);
  return {
    db: {
      select: () => {
        dbCalls++;
        return chain;
      },
    },
  };
});

import { GET } from './route';
import type { NextRequest } from 'next/server';

const V4 = '3f2b8c1e-5a47-4c0d-9a6e-1b2c3d4e5f60';
const V7 = '018f4e2a-7b3c-7d11-9a6e-1b2c3d4e5f60';

const call = (id: string) =>
  GET({} as NextRequest, { params: Promise.resolve({ id }) });

beforeEach(() => {
  selectResult = [];
  dbCalls = 0;
});

describe('GET /api/trust-anchors/:id/jwks', () => {
  it('400 ID_INVALID for a non-UUID id without touching the db', async () => {
    const res = await call('not-a-uuid');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ID_INVALID');
    expect(dbCalls).toBe(0);
  });

  it('404 when the anchor is unknown', async () => {
    const res = await call(V4);
    expect(res.status).toBe(404);
  });

  it('accepts a v7-shaped id syntactically', async () => {
    const res = await call(V7);
    expect(res.status).toBe(404);
    expect(dbCalls).toBe(1);
  });

  it('503 JWKS_NOT_CACHED with Retry-After before the first refresh', async () => {
    selectResult = [{ id: V4, issuerUrl: 'https://idp.example', jwksCache: null }];
    const res = await call(V4);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = await res.json();
    expect(body.code).toBe('JWKS_NOT_CACHED');
    expect(body.issuerUrl).toBe('https://idp.example');
  });

  it('200 with the cached keyset and freshness header', async () => {
    const jwks = { keys: [{ kty: 'OKP' }] };
    selectResult = [
      { id: V4, issuerUrl: 'https://idp.example', jwksCache: jwks, jwksCachedAt: '2026-10-10T00:00:00.000Z' },
    ];
    const res = await call(V4);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-JWKS-Cached-At')).toBe('2026-10-10T00:00:00.000Z');
    expect(await res.json()).toEqual(jwks);
  });
});
