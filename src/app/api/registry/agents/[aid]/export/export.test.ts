// Unit tests for GET /api/registry/agents/[aid]/export.
//   • 404 NOT_FOUND when the agent row is missing
//   • format=json (default) — {agent, sessions, tcts, events, exportedAt}
//   • format=jsonl — one NDJSON line per record, kind-tagged, with
//     Content-Type: application/x-ndjson and an attachment filename
//   • eventLimit clamping — default 1000, capped at 10000, floored at 1
//
// @/lib/db is mocked with thenable chained stubs; the four queries run in
// a fixed order (agents, sessions, tcts, events) so results are queued.

import { jest } from '@jest/globals';

let selectResults: unknown[][] = [];
const limitArgs: number[] = [];

jest.mock('@/lib/db', () => {
  const makeSelectChain = () => {
    const result = selectResults.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = (n: number) => {
      limitArgs.push(n);
      return Promise.resolve(result);
    };
    chain.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected);
    return chain;
  };
  return { db: { select: () => makeSelectChain() } };
});

import { GET } from './route';
import { NextRequest } from 'next/server';

const AID = 'agent-42';

function makeReq(qs = ''): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:4000/api/registry/agents/${AID}/export${qs}`),
  );
}

function ctx() {
  return { params: Promise.resolve({ aid: AID }) };
}

const agentRow = { aid: AID, displayName: 'exporter', status: 'active' };
const sessionRow = { sessionId: 's1', aidA: AID, aidB: 'aid:pubkey:other' };
const tctRow = { jti: 'jti-1', issuerAid: AID };
const eventRow = { id: 'ev-1', type: 'handshake.completed', aidA: AID };

beforeEach(() => {
  selectResults = [];
  limitArgs.length = 0;
});

function queueFullExport() {
  selectResults = [[agentRow], [sessionRow], [tctRow], [eventRow]];
}

describe('GET /api/registry/agents/[aid]/export', () => {
  it('returns 404 NOT_FOUND when the agent row is missing', async () => {
    selectResults = [[]];
    const res = await GET(makeReq(), ctx());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('returns the JSON bundle by default', async () => {
    queueFullExport();
    const res = await GET(makeReq(), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: unknown;
      sessions: unknown[];
      tcts: unknown[];
      events: unknown[];
      exportedAt: string;
    };
    expect(body.agent).toEqual(agentRow);
    expect(body.sessions).toEqual([sessionRow]);
    expect(body.tcts).toEqual([tctRow]);
    expect(body.events).toEqual([eventRow]);
    expect(new Date(body.exportedAt).getTime()).not.toBeNaN();
  });

  it('emits kind-tagged NDJSON for ?format=jsonl', async () => {
    queueFullExport();
    const res = await GET(makeReq('?format=jsonl'), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="agent-${AID}.jsonl"`,
    );
    const text = await res.text();
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n').map((l) => JSON.parse(l) as {
      kind: string;
      record: unknown;
    });
    expect(lines.map((l) => l.kind)).toEqual(['agent', 'session', 'tct', 'event']);
    expect(lines[0].record).toEqual(agentRow);
    expect(lines[3].record).toEqual(eventRow);
  });

  it('percent-decodes the aid path param (real AIDs contain ":")', async () => {
    // Next 15 delivers path params percent-encoded. The handler must
    // decode before querying/re-encoding; a regression shows up here as
    // a double-encoded filename (agent-aid%253A... instead of %3A).
    queueFullExport();
    const encoded = encodeURIComponent('aid:pubkey:zAbc');
    const res = await GET(
      new NextRequest(
        new Request(
          `http://localhost:4000/api/registry/agents/${encoded}/export?format=jsonl`,
        ),
      ),
      { params: Promise.resolve({ aid: encoded }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="agent-${encoded}.jsonl"`,
    );
  });

  it('defaults the audit-event limit to 1000', async () => {
    queueFullExport();
    await GET(makeReq(), ctx());
    // limit(1) for the agent lookup, limit(1000) for events.
    expect(limitArgs).toEqual([1, 1000]);
  });

  it('clamps eventLimit into [1, 10000]', async () => {
    queueFullExport();
    await GET(makeReq('?eventLimit=50000'), ctx());
    expect(limitArgs[1]).toBe(10000);

    queueFullExport();
    await GET(makeReq('?eventLimit=-5'), ctx());
    expect(limitArgs[3]).toBe(1);
  });
});
