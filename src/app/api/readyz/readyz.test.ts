// Unit tests for GET /api/readyz (readiness) — verifies:
//   • 200 { ready: true } when the DB probe succeeds
//   • 503 { ready: false, reason: 'db_unreachable' } when the probe throws —
//     with the thrown error logged through pino and NOTHING from it in the
//     body. That split is the contract from #112: this route is public and
//     rate-limit exempt, so the exception message (a pooled connection
//     attempt, i.e. internal hostnames and usernames) is the operator's, not
//     the caller's. Both halves are asserted, so the leak test cannot be
//     satisfied by deleting the diagnostic instead of the leak.
//   • 503 { reason: 'shutting_down' } once SIGTERM drain has begun,
//     WITHOUT touching the database.
//
// db, the shutdown flag and the logger are mocked — no database, no output.

import { jest } from '@jest/globals';

const executeMock = jest.fn(async (_q: unknown) => ({ rows: [] }));
const isShuttingDownMock = jest.fn(() => false);
const loggerWarnMock = jest.fn();

jest.mock('@/lib/db', () => ({
  db: { execute: (q: unknown) => executeMock(q) },
}));
jest.mock('@/lib/shutdown', () => ({
  isShuttingDown: () => isShuttingDownMock(),
}));
jest.mock('@/lib/logger', () => ({
  logger: { warn: (...a: unknown[]) => loggerWarnMock(...a) },
}));

import { GET } from './route';

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockResolvedValue({ rows: [] });
  isShuttingDownMock.mockReset();
  isShuttingDownMock.mockReturnValue(false);
  loggerWarnMock.mockReset();
});

describe('GET /api/readyz', () => {
  it('returns 200 { ready: true } when the DB responds', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      ready: true,
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('returns 503 { ready: false, reason: db_unreachable } when the probe throws', async () => {
    executeMock.mockRejectedValue(new Error('pool exhausted'));
    const res = await GET();
    expect(res.status).toBe(503);
    // Exact shape: an `error` field (or any other) re-added later fails here,
    // rather than only failing the substring sweep below.
    expect((await res.json()) as Record<string, unknown>).toEqual({
      ready: false,
      reason: 'db_unreachable',
    });
  });

  it('logs the thrown error through pino instead of answering with it', async () => {
    const dbError = new Error('pool exhausted');
    executeMock.mockRejectedValue(dbError);
    await GET();
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    const [bindings, msg] = loggerWarnMock.mock.calls[0] as [
      { err: unknown },
      string,
    ];
    // The REAL error object, not a copy or a message — the operator needs the
    // stack and any pg `code`/`errno` pino's serializer attaches.
    expect(bindings.err).toBe(dbError);
    expect(typeof msg).toBe('string');
  });

  it('leaks no connection detail from the 503 body', async () => {
    // One rejection carrying every tell the issue names at once. Asserted
    // against the raw body text rather than a parsed field, so a renamed or
    // nested field cannot smuggle it through.
    executeMock.mockRejectedValue(
      new Error(
        'getaddrinfo ENOTFOUND db.internal.cluster.local; ' +
          'password authentication failed for user "cp_prod"; ' +
          'database "aitp_control_plane" does not exist; ' +
          'connect ECONNREFUSED 10.2.0.9:5432',
      ),
    );
    const res = await GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    for (const tell of [
      'ENOTFOUND',
      'db.internal',
      'cp_prod',
      'authentication',
      'aitp_control_plane',
      'ECONNREFUSED',
      '10.2.0.9',
      '5432',
    ]) {
      expect(text).not.toContain(tell);
    }
    expect(text).toBe(JSON.stringify({ ready: false, reason: 'db_unreachable' }));
  });

  it('returns 503 shutting_down without touching the DB during drain', async () => {
    isShuttingDownMock.mockReturnValue(true);
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; reason: string };
    expect(body.ready).toBe(false);
    expect(body.reason).toBe('shutting_down');
    expect(executeMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });
});
