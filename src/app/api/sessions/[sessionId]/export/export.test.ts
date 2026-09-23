// Unit tests for GET /api/sessions/[sessionId]/export — verifies:
//   • 404 NOT_FOUND when the session doesn't exist (no events/tcts queried)
//   • default (json) format returns { session, tcts, events, exportedAt }
//   • ?format=jsonl streams one NDJSON line per record (session, tcts,
//     events, in that order) with the download headers set
//
// @/lib/db is mocked with a chained stub, one shape per query in call
// order (session lookup -> events -> tcts). No database.

import { jest } from '@jest/globals';

let sessionRows: unknown[] = [];
let eventRows: unknown[] = [];
let tctRows: unknown[] = [];
let selectCallCount = 0;

jest.mock('@/lib/db', () => {
  return {
    db: {
      select: () => {
        selectCallCount += 1;
        const call = selectCallCount;
        const chain: Record<string, unknown> = {};
        chain.from = () => chain;
        if (call === 1) {
          // session lookup: .where().limit(1)
          chain.where = () => chain;
          chain.limit = () => Promise.resolve(sessionRows);
        } else if (call === 2) {
          // events: .where().orderBy(asc(...))
          chain.where = () => chain;
          chain.orderBy = () => Promise.resolve(eventRows);
        } else {
          // tcts: .where() is terminal
          chain.where = () => Promise.resolve(tctRows);
        }
        return chain;
      },
    },
  };
});

import { GET } from './route';
import { NextRequest } from 'next/server';

function makeReq(sessionId: string, qs = ''): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:4000/api/sessions/${sessionId}/export${qs}`),
  );
}
function ctx(sessionId: string) {
  return { params: Promise.resolve({ sessionId }) };
}

beforeEach(() => {
  sessionRows = [];
  eventRows = [];
  tctRows = [];
  selectCallCount = 0;
});

describe('GET /api/sessions/[sessionId]/export', () => {
  it('returns 404 NOT_FOUND when the session does not exist', async () => {
    const res = await GET(makeReq('missing'), ctx('missing'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'session not found',
      code: 'NOT_FOUND',
    });
    // Only the session lookup ran — no events/tcts queries.
    expect(selectCallCount).toBe(1);
  });

  it('defaults to json format: { session, tcts, events, exportedAt }', async () => {
    sessionRows = [{ sessionId: 's-1' }];
    eventRows = [{ id: 'e-1' }];
    tctRows = [{ jti: 't-1' }];
    const res = await GET(makeReq('s-1'), ctx('s-1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.session).toEqual(sessionRows[0]);
    expect(body.tcts).toEqual(tctRows);
    expect(body.events).toEqual(eventRows);
    expect(typeof body.exportedAt).toBe('string');
  });

  it('?format=jsonl streams one NDJSON line per record with download headers', async () => {
    sessionRows = [{ sessionId: 's-1' }];
    eventRows = [{ id: 'e-1' }, { id: 'e-2' }];
    tctRows = [{ jti: 't-1' }];
    const res = await GET(makeReq('s-1', '?format=jsonl'), ctx('s-1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="session-s-1.jsonl"',
    );
    const text = await res.text();
    const lines = text.trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { kind: 'session', record: { sessionId: 's-1' } },
      { kind: 'tct', record: { jti: 't-1' } },
      { kind: 'event', record: { id: 'e-1' } },
      { kind: 'event', record: { id: 'e-2' } },
    ]);
  });
});
