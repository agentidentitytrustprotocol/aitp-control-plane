// Unit tests for GET /api/tcts — verifies:
//   • filter combinations (issuer, subject, audience, sessionId,
//     capability, active=true) reach the WHERE clause as the right
//     eq()/sql fragments
//   • capability uses a jsonb containment fragment, not eq()
//   • limit/offset clamping (default 100/0, max 1000, floor 1)
//   • rows are mapped to the documented camelCase wire shape.
//
// @/lib/db is mocked with a chained stub; drizzle's eq/and are spied so we
// can count which filters were combined. No database.

import { jest } from '@jest/globals';

const eqCalls: unknown[][] = [];
const andCalls: unknown[][] = [];
const whereArgs: unknown[] = [];
const limitArgs: number[] = [];
const offsetArgs: number[] = [];
let rowsToReturn: unknown[] = [];

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
  return { db: { select: () => chain } };
});

import { GET } from './route';
import { issuedTcts } from '@/lib/db/schema';
import { NextRequest } from 'next/server';

function makeReq(qs: string): NextRequest {
  return new NextRequest(new Request(`http://localhost:4000/api/tcts${qs}`));
}

beforeEach(() => {
  eqCalls.length = 0;
  andCalls.length = 0;
  whereArgs.length = 0;
  limitArgs.length = 0;
  offsetArgs.length = 0;
  rowsToReturn = [];
});

describe('GET /api/tcts — filters', () => {
  it('applies no WHERE and default limit/offset when unfiltered', async () => {
    const res = await GET(makeReq(''));
    expect(res.status).toBe(200);
    expect(whereArgs).toHaveLength(0);
    expect(limitArgs).toEqual([100]);
    expect(offsetArgs).toEqual([0]);
  });

  it('combines issuer + subject + audience + sessionId as four eq clauses', async () => {
    await GET(
      makeReq(
        '?issuer=aid:pubkey:I&subject=aid:pubkey:S&audience=aid:pubkey:A&sessionId=sess-1',
      ),
    );
    expect(whereArgs).toHaveLength(1);
    expect(andCalls).toHaveLength(1);
    expect(andCalls[0]).toHaveLength(4);
    expect(eqCalls).toHaveLength(4);
    expect(eqCalls[0][0]).toBe(issuedTcts.issuerAid);
    expect(eqCalls[0][1]).toBe('aid:pubkey:I');
    expect(eqCalls[1][0]).toBe(issuedTcts.subjectAid);
    expect(eqCalls[1][1]).toBe('aid:pubkey:S');
    expect(eqCalls[2][0]).toBe(issuedTcts.audienceAid);
    expect(eqCalls[2][1]).toBe('aid:pubkey:A');
    expect(eqCalls[3][0]).toBe(issuedTcts.sessionId);
    expect(eqCalls[3][1]).toBe('sess-1');
  });

  it('capability uses a jsonb containment fragment (no eq call)', async () => {
    await GET(makeReq('?capability=payments.execute'));
    expect(whereArgs).toHaveLength(1);
    expect(eqCalls).toHaveLength(0);
    expect(andCalls[0]).toHaveLength(1);
    // The single clause is a raw SQL fragment, not one of our eq markers.
    expect(
      (andCalls[0][0] as Record<string, unknown>).__eq,
    ).toBeUndefined();
  });

  it('active=true adds revoked=false eq plus an expiry sql fragment', async () => {
    await GET(makeReq('?active=true'));
    expect(andCalls[0]).toHaveLength(2);
    expect(eqCalls).toHaveLength(1);
    expect(eqCalls[0][0]).toBe(issuedTcts.revoked);
    expect(eqCalls[0][1]).toBe(false);
  });

  it('active with any other value adds no clauses', async () => {
    await GET(makeReq('?active=1'));
    expect(whereArgs).toHaveLength(0);
    expect(eqCalls).toHaveLength(0);
  });

  it('clamps limit to [1,1000] and offset to >=0', async () => {
    await GET(makeReq('?limit=5000&offset=42'));
    await GET(makeReq('?limit=0'));
    await GET(makeReq('?limit=abc&offset=-1'));
    // parseInt('0') is falsy so limit=0 falls back to the 100 default.
    expect(limitArgs).toEqual([1000, 100, 100]);
    expect(offsetArgs).toEqual([42, 0, 0]);
  });
});

describe('GET /api/tcts — response shape', () => {
  it('maps drizzle rows to the documented camelCase wire shape', async () => {
    rowsToReturn = [
      {
        jti: 'jti-1',
        issuerAid: 'aid:pubkey:I',
        subjectAid: 'aid:pubkey:S',
        audienceAid: 'aid:pubkey:A',
        grants: ['demo.echo'],
        bindingCnf: { jkt: 'thumb' },
        issuedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: null,
        sessionId: 'sess-1',
        revoked: false,
        revokedAt: null,
        // extra drizzle columns must NOT leak into the response
        rawToken: 'eyJ...',
      },
    ];
    const res = await GET(makeReq(''));
    const body = (await res.json()) as { tcts: unknown[] };
    expect(body.tcts).toEqual([
      {
        jti: 'jti-1',
        issuer: 'aid:pubkey:I',
        subject: 'aid:pubkey:S',
        audience: 'aid:pubkey:A',
        grants: ['demo.echo'],
        bindingCnf: { jkt: 'thumb' },
        issuedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: null,
        sessionId: 'sess-1',
        revoked: false,
        revokedAt: null,
      },
    ]);
  });
});
