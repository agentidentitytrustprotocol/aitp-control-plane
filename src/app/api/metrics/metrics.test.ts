// Unit tests for GET /api/metrics — verifies the Prometheus text
// exposition format:
//   • gauge/counter lines for agents, sessions, webhook deliveries and
//     per-type audit events (with label-quote escaping)
//   • aitp_control_plane_db_up 1/0 and the "# DB unavailable" comment on
//     DB failure — the scrape still returns 200
//   • process-local metrics (rate-limit drops, circuit-breaker states,
//     admin-audit insert failures, SSE backlog drops, enrollment
//     verification failures) are emitted even when the DB is down
//   • Content-Type: text/plain; version=0.0.4.
//
// @/lib/db is mocked with thenable select-chains resolved in call order;
// all in-process metric sources are stubbed. No database.

import { jest } from '@jest/globals';

let dbFail = false;
let queuedResults: unknown[][] = [];
let selectCallCount = 0;
let dropTotals: Record<string, number> = {};
let breakerSnaps: Record<string, { state: string }> = {};
let insertFailures = 0;
let droppedCount = 0;
let enrollFailures: Record<string, number> = {};

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
      const idx = selectCallCount++;
      const chain: Thenable = {
        from: () => chain,
        where: () => chain,
        groupBy: () => chain,
        then: (onFulfilled, onRejected) =>
          (dbFail
            ? Promise.reject(new Error('db down'))
            : Promise.resolve(queuedResults[idx] ?? [])
          ).then(onFulfilled, onRejected),
      };
      return chain;
    },
  },
}));
jest.mock('@/lib/rate-limit', () => ({
  rateLimiter: { getDropTotals: () => dropTotals },
}));
jest.mock('@/lib/webhooks/circuit-breaker', () => ({
  webhookBreaker: { getAllSnapshots: () => breakerSnaps },
}));
jest.mock('@/lib/audit-log/service', () => ({
  getAdminAuditInsertFailures: () => insertFailures,
}));
jest.mock('@/lib/audit/stream', () => ({
  eventBus: { getDroppedCount: () => droppedCount },
}));
jest.mock('@/lib/registry/enroll-metrics', () => ({
  getEnrollFailureTotals: () => enrollFailures,
}));

import { GET } from './route';

beforeEach(() => {
  dbFail = false;
  queuedResults = [];
  selectCallCount = 0;
  dropTotals = {};
  breakerSnaps = {};
  insertFailures = 0;
  droppedCount = 0;
  enrollFailures = {};
});

describe('GET /api/metrics — healthy DB', () => {
  it('emits all DB-derived gauges/counters plus process-local metrics', async () => {
    // Order matches the route's Promise.all: active agents, expired
    // agents, total sessions, pending deliveries, failed deliveries,
    // then the events-by-type group query.
    queuedResults = [
      [{ c: 3 }],
      [{ c: 1 }],
      [{ c: 7 }],
      [{ c: 2 }],
      [{ c: 4 }],
      [
        { type: 'handshake.complete', c: 5 },
        { type: 'ev"il', c: 2 }, // exercises label-quote escaping
      ],
    ];
    dropTotals = { events: 12, registry: 3 };
    breakerSnaps = {
      wh1: { state: 'open' },
      wh2: { state: 'half_open' },
      wh3: { state: 'closed' },
    };
    insertFailures = 6;
    droppedCount = 9;
    enrollFailures = { signature_invalid: 4, none: 2, other: 1, expired: 0 };

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    );
    const text = await res.text();
    expect(text.endsWith('\n')).toBe(true);

    expect(text).toContain('aitp_control_plane_agents_active 3');
    expect(text).toContain('aitp_control_plane_agents_expired 1');
    expect(text).toContain('aitp_control_plane_sessions_total 7');
    expect(text).toContain(
      'aitp_control_plane_webhook_deliveries{status="pending"} 2',
    );
    expect(text).toContain(
      'aitp_control_plane_webhook_deliveries{status="failed"} 4',
    );
    expect(text).toContain(
      'aitp_control_plane_audit_events{type="handshake.complete"} 5',
    );
    expect(text).toContain(
      'aitp_control_plane_audit_events{type="ev\\"il"} 2',
    );
    expect(text).toContain('aitp_control_plane_db_up 1');

    expect(text).toContain(
      'aitp_control_plane_rate_limit_drops{bucket="events"} 12',
    );
    expect(text).toContain(
      'aitp_control_plane_rate_limit_drops{bucket="registry"} 3',
    );
    expect(text).toContain(
      'aitp_control_plane_webhook_circuit_breaker_open{state="open"} 1',
    );
    expect(text).toContain(
      'aitp_control_plane_webhook_circuit_breaker_open{state="half_open"} 1',
    );
    expect(text).toContain(
      'aitp_control_plane_admin_audit_insert_failures 6',
    );
    expect(text).toContain('aitp_control_plane_event_backlog_dropped 9');

    expect(text).toContain(
      '# TYPE aitp_control_plane_enroll_verification_failures counter',
    );
    expect(text).toContain(
      'aitp_control_plane_enroll_verification_failures{code="signature_invalid"} 4',
    );
    // "none" = we rejected it, not the SDK; "other" = an unrecognized SDK code.
    expect(text).toContain(
      'aitp_control_plane_enroll_verification_failures{code="none"} 2',
    );
    expect(text).toContain(
      'aitp_control_plane_enroll_verification_failures{code="other"} 1',
    );
    // A zero series is still emitted — a missing one reads as "no data".
    expect(text).toContain(
      'aitp_control_plane_enroll_verification_failures{code="expired"} 0',
    );
  });

  it('escapes quotes in an enroll failure label', async () => {
    // Matches the quote-escaping the sibling label loops already do. Note what
    // actually bounds this metric: the ALLOWLIST in enroll-metrics.ts, not this
    // escaping — which covers `"` only, so a label containing a backslash or a
    // newline would still be malformed. Unreachable precisely because no
    // unallowlisted value can become a label in the first place.
    enrollFailures = { 'ev"il': 1 };
    const text = await (await GET()).text();
    expect(text).toContain(
      'aitp_control_plane_enroll_verification_failures{code="ev\\"il"} 1',
    );
  });
});

describe('GET /api/metrics — enrollment failures with a fresh counter', () => {
  it('emits HELP and TYPE even when no failure has happened', async () => {
    // Takes the map from the REAL module rather than rebuilding it here — a
    // fabricated zero map would test only the emitter, against input this test
    // wrote, and would keep passing if the module's pre-seed were deleted.
    const actual = jest.requireActual<
      typeof import('@/lib/registry/enroll-metrics')
    >('@/lib/registry/enroll-metrics');
    const { ENROLL_FAILURE_LABELS } = actual;
    enrollFailures = actual.getEnrollFailureTotals();
    const text = await (await GET()).text();
    expect(text).toContain(
      '# HELP aitp_control_plane_enroll_verification_failures',
    );
    expect(text).toContain(
      '# TYPE aitp_control_plane_enroll_verification_failures counter',
    );
    for (const label of ENROLL_FAILURE_LABELS) {
      expect(text).toContain(
        `aitp_control_plane_enroll_verification_failures{code="${label}"} 0`,
      );
    }
    // Ten series, no more: the cardinality bound observed at the endpoint.
    const emitted = text
      .split('\n')
      .filter((l) =>
        l.startsWith('aitp_control_plane_enroll_verification_failures{'),
      );
    expect(emitted).toHaveLength(10);
  });
});

describe('GET /api/metrics — DB unavailable', () => {
  it('still scrapes 200, flags db_up 0, and keeps process-local metrics', async () => {
    dbFail = true;
    dropTotals = { events: 1 };
    enrollFailures = { signature_invalid: 3, none: 0 };
    const res = await GET();
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain('# DB unavailable: db down');
    expect(text).toContain('aitp_control_plane_db_up 0');
    // No DB-derived series when the scrape failed…
    expect(text).not.toContain('aitp_control_plane_agents_active');
    expect(text).not.toContain('aitp_control_plane_sessions_total');
    // …but process-local metrics are still emitted.
    expect(text).toContain(
      'aitp_control_plane_rate_limit_drops{bucket="events"} 1',
    );
    expect(text).toContain(
      'aitp_control_plane_webhook_circuit_breaker_open{state="open"} 0',
    );
    expect(text).toContain('aitp_control_plane_admin_audit_insert_failures 0');
    expect(text).toContain('aitp_control_plane_event_backlog_dropped 0');
    // Enrollment failures are in-process, so a dead DB must not hide them —
    // an enrollment incident and a DB outage can easily coincide.
    expect(text).toContain(
      'aitp_control_plane_enroll_verification_failures{code="signature_invalid"} 3',
    );
    expect(text).toContain(
      '# TYPE aitp_control_plane_enroll_verification_failures counter',
    );
  });
});
