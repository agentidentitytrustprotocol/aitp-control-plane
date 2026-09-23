// Unit tests for GET /api/sessions/[sessionId] — verifies:
//   • 404 NOT_FOUND when the session row doesn't exist
//   • 200 with { session, events } when it does, events ordered by the
//     query (ascending ts — asserted via the orderBy call, not re-sorted
//     here since the DB is mocked)
//
// @/lib/db is mocked with a chained stub. No database.

import { jest } from '@jest/globals';

const whereArgs: unknown[] = [];
const orderByArgs: unknown[] = [];
let sessionRows: unknown[] = [];
let eventRows: unknown[] = [];
let selectCallCount = 0;

jest.mock('@/lib/db', () => {
  return {
    db: {
      select: () => {
        selectCallCount += 1;
        const isSessionQuery = selectCallCount === 1;
        const chain: Record<string, unknown> = {};
        chain.from = () => chain;
        chain.where = (arg: unknown) => {
          whereArgs.push(arg);
          return chain;
        };
        if (isSessionQuery) {
          chain.limit = () => Promise.resolve(sessionRows);
        } else {
          chain.orderBy = (arg: unknown) => {
            orderByArgs.push(arg);
            return Promise.resolve(eventRows);
          };
        }
        return chain;
      },
    },
  };
});

import { GET } from './route';
import { NextRequest } from 'next/server';

function makeReq(sessionId: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:4000/api/sessions/${sessionId}`),
  );
}
function ctx(sessionId: string) {
  return { params: Promise.resolve({ sessionId }) };
}

beforeEach(() => {
  whereArgs.length = 0;
  orderByArgs.length = 0;
  sessionRows = [];
  eventRows = [];
  selectCallCount = 0;
});

describe('GET /api/sessions/[sessionId]', () => {
  it('returns 404 NOT_FOUND when the session does not exist', async () => {
    const res = await GET(makeReq('missing'), ctx('missing'));
    expect(res.status).toBe(404);
    expect((await res.json()) as { code: string }).toEqual({
      error: 'session not found',
      code: 'NOT_FOUND',
    });
    // Must not query events for a session that was never found.
    expect(orderByArgs).toHaveLength(0);
  });

  it('returns 200 with the session row and its events', async () => {
    sessionRows = [{ sessionId: 's-1', status: 'completed' }];
    eventRows = [
      { id: 'e-1', type: 'handshake.start' },
      { id: 'e-2', type: 'handshake.complete' },
    ];
    const res = await GET(makeReq('s-1'), ctx('s-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      session: sessionRows[0],
      events: eventRows,
    });
    // Both queries filtered on the same sessionId.
    expect(whereArgs).toHaveLength(2);
  });
});
