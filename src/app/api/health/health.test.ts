// Unit tests for GET /api/health (DB-backed health; Railway's deploy-time
// healthcheck) — verifies:
//   • 200 with { ok: true, db: 'ok' } and the CP AID when SELECT 1 works
//   • 503 with { ok: false, db: 'error' } when the DB probe throws
//   • the AID comes from the identity itself — the signed manifest is never
//     built or read for a health probe.
//
// db and the CP identity module are mocked — no database, no keypair.

import { jest } from '@jest/globals';

const executeMock = jest.fn(async (_q: unknown) => ({ rows: [] }));
const getCpManifestJsonMock = jest.fn(() => {
  throw new Error('health must not build the manifest');
});

jest.mock('@/lib/db', () => ({
  db: { execute: (q: unknown) => executeMock(q) },
}));
jest.mock('@/lib/identity/cp-agent', () => ({
  getCpAgent: () => ({ aid: 'aid:pubkey:cp-test' }),
  getCpManifestJson: () => getCpManifestJsonMock(),
}));

import { GET } from './route';

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockResolvedValue({ rows: [] });
});

describe('GET /api/health', () => {
  it('returns 200 with db:ok and the CP AID when the DB responds', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      service: 'aitp-control-plane',
      aid: 'aid:pubkey:cp-test',
      db: 'ok',
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('returns 503 with db:error when the DB probe throws', async () => {
    executeMock.mockRejectedValue(new Error('connection refused'));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.db).toBe('error');
    // Identity is still reported even when the DB is down.
    expect(body.aid).toBe('aid:pubkey:cp-test');
  });

  it('never builds the signed manifest', async () => {
    await GET();
    executeMock.mockRejectedValue(new Error('down'));
    await GET();
    expect(getCpManifestJsonMock).not.toHaveBeenCalled();
  });
});
