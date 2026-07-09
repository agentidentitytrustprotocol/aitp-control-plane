// Unit tests for GET /api/delegations — verifies:
//   • root_jti / parent_jti UUID validation (400 BAD_REQUEST on garbage)
//   • root_jti takes the recursive-CTE path (db.execute) and maps the raw
//     snake_case rows to the camelCase wire shape
//   • filter combinations (parent_jti, delegator, delegatee, active=true)
//     reach the WHERE clause as the right eq()/sql fragments
//   • limit/offset clamping (default 100/0, max 1000, floor 1)
//   • list-path rows are mapped from drizzle camelCase columns.
//
// @/lib/db is mocked with a chained stub; drizzle's eq/and are spied so we
// can count which filters were combined. No database.

import { jest } from '@jest/globals';

const eqCalls: unknown[][] = [];
const andCalls: unknown[][] = [];
const whereArgs: unknown[] = [];
const limitArgs: number[] = [];
const offsetArgs: number[] = [];
const executeArgs: unknown[] = [];
let rowsToReturn: unknown[] = [];
let executeResult: { rows: unknown[] } = { rows: [] };

jest.mock('drizzle-orm', () => {
  const actual = jest.requireActual('drizzle-orm') as Record<string, unknown>;
  return {
    ...actual,
    eq: (...args: unknown[]) => {
      eqCalls.push(args);
      return { __eq: args };
    },
    and: (...args: unknown[]) => {
      andCalls.push(args);
      return { __and: args };
    },
  };
});

jest.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = (arg: unknown) => {
    whereArgs.push(arg);
    return chain;
  };
  chain.orderBy = () => chain;
  chain.limit = (n: number) => {
    limitArgs.push(n);
    return chain;
  };
  chain.offset = (n: number) => {
    offsetArgs.push(n);
    return Promise.resolve(rowsToReturn);
  };
  return {
    db: {
      select: () => chain,
      execute: (q: unknown) => {
        executeArgs.push(q);
        return Promise.resolve(executeResult);
      },
    },
  };
});

import { GET } from './route';
import { delegations } from '@/lib/db/schema';
import { NextRequest } from 'next/server';

const UUID = '3f1e9c1a-2b4d-4e6f-8a9b-0c1d2e3f4a5b';

function makeReq(qs: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:4000/api/delegations${qs}`),
  );
}

beforeEach(() => {
  eqCalls.length = 0;
  andCalls.length = 0;
  whereArgs.length = 0;
  limitArgs.length = 0;
  offsetArgs.length = 0;
  executeArgs.length = 0;
  rowsToReturn = [];
  executeResult = { rows: [] };
});

describe('GET /api/delegations — root_jti tree path', () => {
  it('rejects a non-UUID root_jti with 400 BAD_REQUEST', async () => {
    const res = await GET(makeReq('?root_jti=not-a-uuid'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
    expect(executeArgs).toHaveLength(0);
  });

  it('runs the recursive CTE and maps snake_case rows to the wire shape', async () => {
    executeResult = {
      rows: [
        {
          jti: UUID,
          parent_jti: '00000000-0000-4000-8000-000000000000',
          delegator_aid: 'aid:pubkey:root',
          delegatee_aid: 'aid:pubkey:child',
          scope: ['demo.echo'],
          issued_at: '2026-06-01T00:00:00.000Z',
          expires_at: null,
          revoked: false,
          revoked_at: null,
          revoked_reason: null,
        },
      ],
    };
    const res = await GET(makeReq(`?root_jti=${UUID}`));
    expect(res.status).toBe(200);
    expect(executeArgs).toHaveLength(1);
    const body = (await res.json()) as { delegations: unknown[] };
    expect(body.delegations).toEqual([
      {
        jti: UUID,
        parentJti: '00000000-0000-4000-8000-000000000000',
        delegator: 'aid:pubkey:root',
        delegatee: 'aid:pubkey:child',
        scope: ['demo.echo'],
        issuedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: null,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      },
    ]);
  });

  it('accepts the camelCase alias ?rootJti=', async () => {
    await GET(makeReq(`?rootJti=${UUID}`));
    expect(executeArgs).toHaveLength(1);
  });
});

describe('GET /api/delegations — list path filters', () => {
  it('applies no WHERE and default limit/offset when unfiltered', async () => {
    const res = await GET(makeReq(''));
    expect(res.status).toBe(200);
    expect(whereArgs).toHaveLength(0);
    expect(limitArgs).toEqual([100]);
    expect(offsetArgs).toEqual([0]);
  });

  it('rejects a non-UUID parent_jti with 400', async () => {
    const res = await GET(makeReq('?parent_jti=xyz'));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_REQUEST');
    expect(whereArgs).toHaveLength(0);
  });

  it('filters by parent_jti via eq on the parentJti column', async () => {
    await GET(makeReq(`?parent_jti=${UUID}`));
    expect(whereArgs).toHaveLength(1);
    expect(eqCalls).toHaveLength(1);
    expect(eqCalls[0][0]).toBe(delegations.parentJti);
    expect(eqCalls[0][1]).toBe(UUID);
  });

  it('combines delegator + delegatee + active=true into one and(...) of 4 clauses', async () => {
    await GET(
      makeReq('?delegator=aid:pubkey:D&delegatee=aid:pubkey:E&active=true'),
    );
    expect(whereArgs).toHaveLength(1);
    expect(andCalls).toHaveLength(1);
    // 2 aid eq's + revoked eq + expiry sql fragment
    expect(andCalls[0]).toHaveLength(4);
    expect(eqCalls).toHaveLength(3);
    expect(eqCalls[0][0]).toBe(delegations.delegatorAid);
    expect(eqCalls[0][1]).toBe('aid:pubkey:D');
    expect(eqCalls[1][0]).toBe(delegations.delegateeAid);
    expect(eqCalls[1][1]).toBe('aid:pubkey:E');
    expect(eqCalls[2][0]).toBe(delegations.revoked);
    expect(eqCalls[2][1]).toBe(false);
  });

  it('does not apply the active clauses when active is absent or not "true"', async () => {
    await GET(makeReq('?delegator=aid:pubkey:D&active=false'));
    expect(eqCalls).toHaveLength(1);
    expect(andCalls[0]).toHaveLength(1);
  });

  it('clamps limit to [1,1000] and offset to >=0', async () => {
    await GET(makeReq('?limit=5000&offset=25'));
    await GET(makeReq('?limit=-3'));
    await GET(makeReq('?limit=abc&offset=-9'));
    expect(limitArgs).toEqual([1000, 1, 100]);
    expect(offsetArgs).toEqual([25, 0, 0]);
  });

  it('maps drizzle camelCase rows to the wire shape', async () => {
    rowsToReturn = [
      {
        jti: UUID,
        parentJti: null,
        delegatorAid: 'aid:pubkey:D',
        delegateeAid: 'aid:pubkey:E',
        scope: ['a.b'],
        issuedAt: '2026-06-02T00:00:00.000Z',
        expiresAt: '2026-06-03T00:00:00.000Z',
        revoked: true,
        revokedAt: '2026-06-02T12:00:00.000Z',
        revokedReason: 'compromised',
      },
    ];
    const res = await GET(makeReq(''));
    const body = (await res.json()) as { delegations: unknown[] };
    expect(body.delegations).toEqual([
      {
        jti: UUID,
        parentJti: null,
        delegator: 'aid:pubkey:D',
        delegatee: 'aid:pubkey:E',
        scope: ['a.b'],
        issuedAt: '2026-06-02T00:00:00.000Z',
        expiresAt: '2026-06-03T00:00:00.000Z',
        revoked: true,
        revokedAt: '2026-06-02T12:00:00.000Z',
        revokedReason: 'compromised',
      },
    ]);
  });
});
