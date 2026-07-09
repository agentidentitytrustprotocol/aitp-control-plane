// Unit tests for the dashboard read-model. We mock `../db` with a
// generic awaitable select chain fed from a per-test queue (results are
// consumed in the order the queries appear in the source's Promise.all)
// and stub db.execute for the two raw-SQL chart queries. We also spy on
// drizzle's sql.raw to verify the date_trunc bucket granularity picked
// per range (minute/hour/day) — the value that is interpolated as a SQL
// literal. Verifies: KPI/row/chart mapping, empty-DB zero fallbacks,
// `rows`-wrapped vs bare execute results, and getAgentMetrics joins.

import { jest } from '@jest/globals';

const rawCalls: string[] = [];
jest.mock('drizzle-orm', () => {
  const actual = jest.requireActual('drizzle-orm') as Record<string, unknown>;
  const actualSql = actual.sql as ((...a: unknown[]) => unknown) & {
    raw: (s: string) => unknown;
  };
  const wrappedSql = Object.assign(
    (...args: unknown[]) => actualSql(...args),
    actualSql,
    {
      raw: (s: string) => {
        rawCalls.push(s);
        return actualSql.raw(s);
      },
    },
  );
  return { ...actual, sql: wrappedSql };
});

let selectQueue: unknown[][] = [];
let executeQueue: unknown[] = [];
let selectCallCount = 0;

jest.mock('../db', () => ({
  db: {
    select: () => {
      selectCallCount += 1;
      const result = selectQueue.shift() ?? [];
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => chain;
      chain.groupBy = () => chain;
      chain.offset = () => chain;
      // Awaitable at any point in the chain.
      (chain as { then?: unknown }).then = (
        resolve: (v: unknown) => unknown,
      ) => resolve(result);
      return chain;
    },
    execute: () => Promise.resolve(executeQueue.shift() ?? { rows: [] }),
  },
}));

import { getAgentMetrics, getDashboardOverview } from './service';

const ts = '2026-07-07T09:00:00.000Z';

beforeEach(() => {
  selectQueue = [];
  executeQueue = [];
  selectCallCount = 0;
  rawCalls.length = 0;
});

describe('getDashboardOverview', () => {
  it('maps counts, recent sessions and charts into the overview shape', async () => {
    const session = {
      sessionId: 'sess-1',
      aidA: 'aid:pubkey:A',
      aidB: 'aid:pubkey:B',
      status: 'complete',
      grants: ['demo.echo'],
      boundary: 'org-a<->org-b',
      startedAt: ts,
      completedAt: ts,
      // Extra DB columns the projection must NOT leak through.
      error: null,
      runId: 'run-1',
      createdAt: ts,
      updatedAt: ts,
    };
    selectQueue = [
      [{ count: 5 }], // agents registered
      [{ count: 100 }], // handshakes total
      [{ count: 40 }], // handshakes in range
      [{ count: 30 }], // successful in range
      [{ count: 3 }], // active sessions
      [session], // recent sessions
      [
        { boundary: 'org-a<->org-b', count: 7 },
        { boundary: null, count: 2 },
      ],
      [{ count: 12 }], // capability invocations
      [{ count: 4 }], // pending webhook deliveries
    ];
    executeQueue = [
      // First execute result comes back pg-style ({ rows }), second as a
      // bare array — the service must handle both shapes.
      { rows: [{ bucket: '2026-07-07 09:00:00', count: 6 }] },
      [{ capability: 'demo.echo', count: 9 }],
    ];

    const overview = await getDashboardOverview('24h');

    expect(overview.range).toBe('24h');
    expect(overview.kpis).toEqual({
      agentsRegistered: 5,
      handshakesTotal: 100,
      handshakesInRange: 40,
      handshakesSuccessInRange: 30,
      capabilityInvocationsInRange: 12,
      activeSessions: 3,
      pendingWebhookDeliveries: 4,
    });
    expect(overview.recentSessions).toEqual([
      {
        sessionId: 'sess-1',
        aidA: 'aid:pubkey:A',
        aidB: 'aid:pubkey:B',
        status: 'complete',
        grants: ['demo.echo'],
        boundary: 'org-a<->org-b',
        startedAt: ts,
        completedAt: ts,
      },
    ]);
    expect(overview.charts.handshakesByBoundary).toEqual([
      { boundary: 'org-a<->org-b', count: 7 },
      { boundary: 'unknown', count: 2 }, // null boundary → 'unknown'
    ]);
    expect(overview.charts.handshakesOverTime).toEqual([
      { bucket: '2026-07-07 09:00:00', count: 6 },
    ]);
    expect(overview.charts.topCapabilities).toEqual([
      { capability: 'demo.echo', count: 9 },
    ]);
  });

  it('returns zeroed KPIs and empty lists when every query comes back empty', async () => {
    // selectQueue left empty → every count row is missing.
    executeQueue = [{ rows: [] }, { rows: [] }];
    const overview = await getDashboardOverview();
    expect(overview.range).toBe('24h');
    expect(overview.kpis).toEqual({
      agentsRegistered: 0,
      handshakesTotal: 0,
      handshakesInRange: 0,
      handshakesSuccessInRange: 0,
      capabilityInvocationsInRange: 0,
      activeSessions: 0,
      pendingWebhookDeliveries: 0,
    });
    expect(overview.recentSessions).toEqual([]);
    expect(overview.charts.handshakesByBoundary).toEqual([]);
    expect(overview.charts.handshakesOverTime).toEqual([]);
    expect(overview.charts.topCapabilities).toEqual([]);
  });

  it.each([
    ['1h', "'minute'"],
    ['24h', "'hour'"],
    ['7d', "'day'"],
    ['30d', "'day'"],
  ] as const)(
    'buckets the time series by the right date_trunc field for %s',
    async (range, expectedLiteral) => {
      executeQueue = [{ rows: [] }, { rows: [] }];
      await getDashboardOverview(range);
      expect(rawCalls).toEqual([expectedLiteral]);
    },
  );
});

describe('getAgentMetrics', () => {
  it('returns [] without issuing the per-agent count queries when no agents exist', async () => {
    selectQueue = [[]];
    const metrics = await getAgentMetrics();
    expect(metrics).toEqual([]);
    expect(selectCallCount).toBe(1);
  });

  it('joins initiator/responder/invocation counts per agent, defaulting to 0', async () => {
    selectQueue = [
      [
        {
          aid: 'aid:pubkey:A',
          displayName: 'Agent A',
          status: 'active',
          registeredAt: ts,
          lastSeenAt: ts,
        },
        {
          aid: 'aid:pubkey:B',
          displayName: 'Agent B',
          status: 'deregistered',
          registeredAt: ts,
          lastSeenAt: null,
        },
      ],
      [{ aid: 'aid:pubkey:A', count: 3 }], // initiator counts
      [{ aid: 'aid:pubkey:B', count: 2 }], // responder counts
      [{ aid: 'aid:pubkey:A', count: 5 }], // capability invocations
    ];

    const metrics = await getAgentMetrics();

    expect(metrics).toEqual([
      {
        aid: 'aid:pubkey:A',
        displayName: 'Agent A',
        status: 'active',
        registeredAt: ts,
        lastSeenAt: ts,
        handshakesAsInitiator: 3,
        handshakesAsResponder: 0,
        capabilityInvocations: 5,
      },
      {
        aid: 'aid:pubkey:B',
        displayName: 'Agent B',
        status: 'deregistered',
        registeredAt: ts,
        lastSeenAt: null,
        handshakesAsInitiator: 0,
        handshakesAsResponder: 2,
        capabilityInvocations: 0,
      },
    ]);
  });
});
