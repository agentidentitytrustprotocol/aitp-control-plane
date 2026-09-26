// End-to-end test of the SSE observability loop: the REAL stream route drives
// the REAL counter module, and the REAL /api/metrics handler reports them.
//
// WHY THIS FILE EXISTS SEPARATELY. `stream.test.ts` asserts the counters via
// getSseMetrics(), and `metrics.test.ts` asserts the exposition lines with
// `@/lib/audit/sse-metrics` MOCKED. Both pass if the two halves disagree —
// nothing in either file proves that opening a stream is what makes
// `aitp_control_plane_sse_streams_open 1` appear in a scrape. That claim is
// acceptance criterion 2 of this work, and an operator reading the gauge during
// an incident is relying on exactly it, so it gets its own test.
//
// The DB is mocked to FAIL throughout, which also pins acceptance criterion 4:
// the SSE series must survive a database outage, because the stream endpoint has
// no database coupling and an SSE incident can easily coincide with a DB one.
// That is why these three lines are emitted outside the metrics route's
// try/catch, and this is the assertion that notices if they move back inside.

import { jest } from '@jest/globals';

interface Thenable {
  from: () => Thenable;
  where: () => Thenable;
  groupBy: () => Thenable;
  then: (
    onFulfilled?: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise<unknown>;
}

jest.mock('@/lib/db', () => ({
  db: {
    select: (): Thenable => {
      const chain: Thenable = {
        from: () => chain,
        where: () => chain,
        groupBy: () => chain,
        then: (onFulfilled, onRejected) =>
          Promise.reject(new Error('db down')).then(onFulfilled, onRejected),
      };
      return chain;
    },
  },
}));
// Trimmed to what /api/metrics needs; everything SSE-related is left REAL.
jest.mock('@/lib/rate-limit', () => ({
  rateLimiter: { getDropTotals: () => ({}) },
}));
jest.mock('@/lib/webhooks/circuit-breaker', () => ({
  webhookBreaker: { getAllSnapshots: () => ({}) },
}));
jest.mock('@/lib/audit-log/service', () => ({
  getAdminAuditInsertFailures: () => 0,
}));

import { NextRequest } from 'next/server';
import { GET as streamGET } from './route';
import { GET as metricsGET } from '../../metrics/route';
import { resetSseMetrics } from '@/lib/audit/sse-metrics';

function makeReq(qs = ''): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:4000/api/events/stream${qs}`),
  );
}

async function scrape(): Promise<string> {
  const res = await metricsGET();
  expect(res.status).toBe(200);
  return res.text();
}

beforeEach(() => {
  resetSseMetrics();
});

afterEach(() => {
  resetSseMetrics();
});

describe('SSE metrics, end to end through /api/metrics', () => {
  it('goes 0 -> 1 -> 0 as a real stream opens and disconnects, with the DB down throughout', async () => {
    const before = await scrape();
    expect(before).toContain('aitp_control_plane_db_up 0');
    expect(before).toContain('aitp_control_plane_sse_streams_open 0');
    expect(before).toContain('aitp_control_plane_sse_streams_opened_total 0');
    expect(before).toContain('aitp_control_plane_sse_streams_rejected_total 0');
    // The DB-derived series really are absent, so the assertions above are
    // about the outside-the-try placement and not about a DB that silently
    // answered anyway.
    expect(before).not.toContain('aitp_control_plane_agents_active');

    const res = streamGET(makeReq());
    expect(res.status).toBe(200);

    const during = await scrape();
    expect(during).toContain('aitp_control_plane_sse_streams_open 1');
    expect(during).toContain('aitp_control_plane_sse_streams_opened_total 1');
    expect(during).toContain('aitp_control_plane_db_up 0');

    // Disconnect, which is the path that runs the route's cleanup().
    await res.body!.cancel();

    const after = await scrape();
    expect(after).toContain('aitp_control_plane_sse_streams_open 0');
    // Cumulative: the gauge falls back, the counter must not.
    expect(after).toContain('aitp_control_plane_sse_streams_opened_total 1');
    expect(after).toContain('aitp_control_plane_sse_streams_rejected_total 0');
  });

  it('reports a capacity rejection as rejected_total, without counting an open', async () => {
    // Drive the real cap rather than poking the global: this is the only test
    // that exercises refusal -> scrape as one path.
    //
    // The previous value is saved and put back, not deleted: this file loads the
    // REAL @/lib/config, so an ambient MAX_SSE_CONNECTIONS in the environment is
    // part of the state this test borrows, and deleting it would change the
    // behaviour of anything that ran afterwards in this worker.
    const previousCap = process.env.MAX_SSE_CONNECTIONS;
    process.env.MAX_SSE_CONNECTIONS = '1';
    jest.resetModules();
    const freshStream = (
      await import('./route')
    ).GET as typeof streamGET;
    try {
      const first = freshStream(makeReq());
      expect(first.status).toBe(200);
      const second = freshStream(makeReq());
      expect(second.status).toBe(503);
      expect(await second.json()).toMatchObject({ code: 'SSE_CAPACITY' });

      const text = await scrape();
      expect(text).toContain('aitp_control_plane_sse_streams_open 1');
      expect(text).toContain('aitp_control_plane_sse_streams_opened_total 1');
      expect(text).toContain('aitp_control_plane_sse_streams_rejected_total 1');

      await first.body!.cancel();
    } finally {
      if (previousCap === undefined) delete process.env.MAX_SSE_CONNECTIONS;
      else process.env.MAX_SSE_CONNECTIONS = previousCap;
      jest.resetModules();
    }
  });
});
