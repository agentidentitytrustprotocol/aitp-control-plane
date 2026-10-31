// Unit tests for GET /api/revocation/issuers. The database is mocked; the
// real-Postgres aggregate is in src/e2e/revocation-flow.integration.test.ts.
//   • one aggregate: non-null iss, grouped, ordered by iss
//   • limit/offset defaults (100/0), clamped to 1..1000, echoed back
//   • counts are numbers, no-store

import { jest } from '@jest/globals';

let rows: { iss: string; entries: number | string }[] = [];
const calls: Record<string, unknown[]> = {};

jest.mock('@/lib/db', () => {
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ['select', 'from', 'where', 'groupBy', 'orderBy', 'limit']) {
    chain[m] = (...a: unknown[]) => {
      calls[m] = a;
      return chain;
    };
  }
  chain.offset = (...a: unknown[]) => {
    calls.offset = a;
    return Promise.resolve(rows);
  };
  return { db: chain };
});

import { NextRequest } from 'next/server';
import { GET } from './route';

const get = (q = '') => GET(new NextRequest(`http://localhost/api/revocation/issuers${q}`));

beforeEach(() => {
  rows = [];
  for (const k of Object.keys(calls)) delete calls[k];
});

describe('GET /api/revocation/issuers', () => {
  it('lists each issuer with its entry count', async () => {
    rows = [
      { iss: 'aid:pubkey:a', entries: 3 },
      { iss: 'aid:pubkey:b', entries: '1' },
    ];
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      issuers: [
        { iss: 'aid:pubkey:a', entries: 3 },
        { iss: 'aid:pubkey:b', entries: 1 },
      ],
      limit: 100,
      offset: 0,
    });
    expect(calls.groupBy).toHaveLength(1);
    expect(calls.where).toHaveLength(1);
  });

  it('pages with limit and offset', async () => {
    const res = await get('?limit=2&offset=4');
    expect(calls.limit).toEqual([2]);
    expect(calls.offset).toEqual([4]);
    expect(await res.json()).toMatchObject({ issuers: [], limit: 2, offset: 4 });
  });

  it.each([
    ['?limit=5000', 1000, 0],
    ['?limit=0&offset=-3', 1, 0],
    ['?limit=x&offset=y', 100, 0],
  ])('clamps %s', async (q, limit, offset) => {
    await get(q);
    expect(calls.limit).toEqual([limit]);
    expect(calls.offset).toEqual([offset]);
  });
});
