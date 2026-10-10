// Unit test for GET /api/sessions — verifies the ?aid filter covers
// BOTH initiator (aidA) and responder (aidB), the Plan Bug 1 fix.
//
// Approach: mock @/lib/db so the SELECT chain captures the WHERE arg
// passed to drizzle. We spy on drizzle-orm's `or` and `eq` to count how
// they're combined: for `?aid=X` we want exactly one `or(eq(aidA,X), eq(aidB,X))`.

import { jest } from '@jest/globals';

const recorded: { kind: string; args: unknown[] }[] = [];
const orCalls: unknown[][] = [];
let orderByArgs: unknown[] = [];
let lastLimit: number | undefined;
let lastOffset: number | undefined;
let sessionsToReturn: unknown[] = [];

jest.mock('drizzle-orm', () => {
  const actual = jest.requireActual('drizzle-orm') as Record<string, unknown>;
  return {
    ...actual,
    or: (...args: unknown[]) => {
      orCalls.push(args);
      // Return a marker the captured chain doesn't try to interpret.
      return { __or: args };
    },
  };
});

jest.mock('@/lib/db', () => {
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.where = (arg: unknown) => {
    recorded.push({ kind: 'select.where', args: [arg] });
    return selectChain;
  };
  selectChain.orderBy = (...args: unknown[]) => {
    orderByArgs = args;
    return selectChain;
  };
  selectChain.limit = (n: number) => {
    lastLimit = n;
    return selectChain;
  };
  selectChain.offset = (n: number) => {
    lastOffset = n;
    return Promise.resolve(sessionsToReturn);
  };
  return { db: { select: () => selectChain } };
});

import { GET } from './route';
import { NextRequest } from 'next/server';

function makeReq(qs: string): NextRequest {
  return new NextRequest(new Request(`http://localhost:4000/api/sessions${qs}`));
}

beforeEach(() => {
  recorded.length = 0;
  orCalls.length = 0;
  sessionsToReturn = [];
  lastLimit = undefined;
  lastOffset = undefined;
});

describe('GET /api/sessions (Plan Bug 1)', () => {
  it('?aid=<X> wraps both aidA and aidB checks in a single or(...) clause', async () => {
    sessionsToReturn = [
      { sessionId: 's1', aidA: 'aid:pubkey:A', aidB: 'aid:pubkey:X' },
    ];
    const res = await GET(makeReq('?aid=aid:pubkey:X'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions.length).toBe(1);

    // Exactly one `or(...)` invocation for the aid filter — with two args.
    expect(orCalls.length).toBe(1);
    expect(orCalls[0].length).toBe(2);
  });

  it('omits the or() altogether when no ?aid is given', async () => {
    sessionsToReturn = [];
    await GET(makeReq(''));
    expect(orCalls.length).toBe(0);
  });

  it('still applies the or() when other filters (status, run_id) are present', async () => {
    sessionsToReturn = [];
    await GET(makeReq('?aid=aid:pubkey:X&status=complete&run_id=abc'));
    expect(orCalls.length).toBe(1);
  });
});

describe('GET /api/sessions pagination and filter validation', () => {
  it.each([
    ['', 200, 0],
    ['?limit=50', 50, 0],
    ['?limit=5000', 1000, 0],
    ['?limit=abc', 200, 0],
    ['?limit=0', 1, 0],
    ['?limit=10&offset=30', 10, 30],
    ['?offset=-3', 200, 0],
    ['?offset=abc', 200, 0],
  ])('%s -> limit %i offset %i', async (qs, limit, offset) => {
    const res = await GET(makeReq(qs));
    expect(res.status).toBe(200);
    expect(lastLimit).toBe(limit);
    expect(lastOffset).toBe(offset);
  });

  it('orders by createdAt then sessionId (stable offset pages)', async () => {
    await GET(makeReq(''));
    expect(orderByArgs).toHaveLength(2);
  });

  it.each(['status', 'run_id', 'runId', 'aid'])(
    'answers 400 BAD_REQUEST for a NUL in %s without querying',
    async (name) => {
      const res = await GET(makeReq(`?${name}=a%00b`));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
      expect(lastLimit).toBeUndefined();
    },
  );
});
