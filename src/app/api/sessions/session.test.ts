// Unit test for GET /api/sessions — verifies the ?aid filter covers
// BOTH initiator (aidA) and responder (aidB), the Plan Bug 1 fix.
//
// Approach: mock @/lib/db so the SELECT chain captures the WHERE arg
// passed to drizzle. We spy on drizzle-orm's `or` and `eq` to count how
// they're combined: for `?aid=X` we want exactly one `or(eq(aidA,X), eq(aidB,X))`.

import { jest } from '@jest/globals';

const recorded: { kind: string; args: unknown[] }[] = [];
const orCalls: unknown[][] = [];
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
  selectChain.orderBy = () => selectChain;
  selectChain.limit = () => Promise.resolve(sessionsToReturn);
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
