// Unit tests for GET /api/events/history — verifies:
//   • every query param (type, aid, session_id/sessionId, run_id/runId,
//     since, until) is forwarded into queryHistory
//   • limit/offset go through parsePagination (defaults 100/0, clamps to
//     [1,1000] / >=0, malformed input falls back to defaults)
//   • response shape { events, count }
//   • InvalidFilterError from the store maps to 400 FILTER_INVALID; any
//     other error propagates.
//
// The event store is mocked — no database.

import { jest } from '@jest/globals';

const queryHistoryMock = jest.fn(async (_f: unknown) => [] as unknown[]);

jest.mock('@/lib/audit/event-store', () => {
  class InvalidFilterError extends Error {}
  return {
    InvalidFilterError,
    queryHistory: (f: unknown) => queryHistoryMock(f),
  };
});

import { GET } from './route';
import { InvalidFilterError } from '@/lib/audit/event-store';
import { NextRequest } from 'next/server';

function makeReq(qs: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:4000/api/events/history${qs}`),
  );
}

beforeEach(() => {
  queryHistoryMock.mockReset();
  queryHistoryMock.mockResolvedValue([]);
});

describe('GET /api/events/history', () => {
  it('forwards all snake_case filters into queryHistory', async () => {
    await GET(
      makeReq(
        '?type=tct.issued&aid=aid:pubkey:X&session_id=s1&run_id=r1' +
          '&since=2026-01-01T00:00:00Z&until=2026-02-01T00:00:00Z&limit=50&offset=10',
      ),
    );
    expect(queryHistoryMock).toHaveBeenCalledTimes(1);
    expect(queryHistoryMock.mock.calls[0][0]).toEqual({
      type: 'tct.issued',
      aid: 'aid:pubkey:X',
      sessionId: 's1',
      runId: 'r1',
      since: '2026-01-01T00:00:00Z',
      until: '2026-02-01T00:00:00Z',
      limit: 50,
      offset: 10,
    });
  });

  it('accepts camelCase aliases sessionId / runId', async () => {
    await GET(makeReq('?sessionId=s9&runId=r9'));
    const f = queryHistoryMock.mock.calls[0][0] as {
      sessionId: string;
      runId: string;
    };
    expect(f.sessionId).toBe('s9');
    expect(f.runId).toBe('r9');
  });

  it('defaults to limit=100, offset=0 and undefined filters', async () => {
    await GET(makeReq(''));
    expect(queryHistoryMock.mock.calls[0][0]).toEqual({
      type: undefined,
      aid: undefined,
      sessionId: undefined,
      runId: undefined,
      since: undefined,
      until: undefined,
      limit: 100,
      offset: 0,
    });
  });

  it('clamps limit to 1000, floors offset at 0, and survives malformed numbers', async () => {
    await GET(makeReq('?limit=99999&offset=-4'));
    let f = queryHistoryMock.mock.calls[0][0] as { limit: number; offset: number };
    expect(f.limit).toBe(1000);
    expect(f.offset).toBe(0);

    await GET(makeReq('?limit=abc&offset=xyz'));
    f = queryHistoryMock.mock.calls[1][0] as { limit: number; offset: number };
    expect(f.limit).toBe(100);
    expect(f.offset).toBe(0);
  });

  it('returns { events, count } with the store rows', async () => {
    queryHistoryMock.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }]);
    const res = await GET(makeReq(''));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; count: number };
    expect(body.events).toEqual([{ id: 'e1' }, { id: 'e2' }]);
    expect(body.count).toBe(2);
  });

  it('maps InvalidFilterError to 400 FILTER_INVALID', async () => {
    queryHistoryMock.mockRejectedValue(
      new InvalidFilterError('since must be an ISO timestamp'),
    );
    const res = await GET(makeReq('?since=banana'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('FILTER_INVALID');
    expect(body.error).toBe('since must be an ISO timestamp');
  });

  it('rethrows non-filter errors', async () => {
    queryHistoryMock.mockRejectedValue(new Error('connection reset'));
    await expect(GET(makeReq(''))).rejects.toThrow('connection reset');
  });
});
