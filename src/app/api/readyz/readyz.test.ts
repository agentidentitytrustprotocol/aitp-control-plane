// Unit tests for GET /api/readyz (readiness) — verifies:
//   • 200 { ready: true } when the DB probe succeeds
//   • 503 with the DB error message when the probe throws
//   • 503 { reason: 'shutting_down' } once SIGTERM drain has begun,
//     WITHOUT touching the database.
//
// db and the shutdown flag are mocked — no database.

import { jest } from '@jest/globals';

const executeMock = jest.fn(async (_q: unknown) => ({ rows: [] }));
const isShuttingDownMock = jest.fn(() => false);

jest.mock('@/lib/db', () => ({
  db: { execute: (q: unknown) => executeMock(q) },
}));
jest.mock('@/lib/shutdown', () => ({
  isShuttingDown: () => isShuttingDownMock(),
}));

import { GET } from './route';

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockResolvedValue({ rows: [] });
  isShuttingDownMock.mockReset();
  isShuttingDownMock.mockReturnValue(false);
});

describe('GET /api/readyz', () => {
  it('returns 200 { ready: true } when the DB responds', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      ready: true,
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('returns 503 with the error message when the DB probe throws', async () => {
    executeMock.mockRejectedValue(new Error('pool exhausted'));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; error: string };
    expect(body.ready).toBe(false);
    expect(body.error).toBe('pool exhausted');
  });

  it('returns 503 shutting_down without touching the DB during drain', async () => {
    isShuttingDownMock.mockReturnValue(true);
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; reason: string };
    expect(body.ready).toBe(false);
    expect(body.reason).toBe('shutting_down');
    expect(executeMock).not.toHaveBeenCalled();
  });
});
