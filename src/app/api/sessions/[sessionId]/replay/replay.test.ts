// Unit tests for GET /api/sessions/[sessionId]/replay — verifies:
//   • 400 BAD_REQUEST on an unparseable ?since / ?until
//   • limit clamping: default 1000, max 10000, floored to 1 for negative
//   • 200 response shape { sessionId, count, events } echoing the rows
//     the (mocked) query returned
//
// @/lib/db is mocked with a chained stub. No database.

import { jest } from '@jest/globals';

const whereArgs: unknown[] = [];
const limitArgs: number[] = [];
let rowsToReturn: unknown[] = [];

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
    return Promise.resolve(rowsToReturn);
  };
  return {
    db: { select: () => chain },
  };
});

import { GET } from './route';
import { NextRequest } from 'next/server';

function makeReq(sessionId: string, qs = ''): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:4000/api/sessions/${sessionId}/replay${qs}`),
  );
}
function ctx(sessionId: string) {
  return { params: Promise.resolve({ sessionId }) };
}

beforeEach(() => {
  whereArgs.length = 0;
  limitArgs.length = 0;
  rowsToReturn = [];
});

describe('GET /api/sessions/[sessionId]/replay', () => {
  it('rejects an unparseable ?since with 400 BAD_REQUEST', async () => {
    const res = await GET(makeReq('s-1', '?since=not-a-date'), ctx('s-1'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid since', code: 'BAD_REQUEST' });
    expect(limitArgs).toHaveLength(0);
  });

  it('rejects an unparseable ?until with 400 BAD_REQUEST', async () => {
    const res = await GET(makeReq('s-1', '?until=not-a-date'), ctx('s-1'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid until', code: 'BAD_REQUEST' });
  });

  it('defaults limit to 1000 when unspecified', async () => {
    await GET(makeReq('s-1'), ctx('s-1'));
    expect(limitArgs).toEqual([1000]);
  });

  it('clamps an over-large limit down to 10000', async () => {
    await GET(makeReq('s-1', '?limit=999999'), ctx('s-1'));
    expect(limitArgs).toEqual([10000]);
  });

  it('floors a negative limit up to 1', async () => {
    await GET(makeReq('s-1', '?limit=-5'), ctx('s-1'));
    expect(limitArgs).toEqual([1]);
  });

  it('accepts valid since/until and returns { sessionId, count, events }', async () => {
    rowsToReturn = [{ id: 'e-1' }, { id: 'e-2' }];
    const res = await GET(
      makeReq('s-1', '?since=2026-01-01T00:00:00Z&until=2026-01-02T00:00:00Z'),
      ctx('s-1'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: 's-1',
      count: 2,
      events: rowsToReturn,
    });
    // sessionId eq + since + until = 3 predicates and()-ed together.
    expect(whereArgs).toHaveLength(1);
  });
});
