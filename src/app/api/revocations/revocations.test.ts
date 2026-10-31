// Unit tests for GET /api/revocations (the per-issuer relay, CP1.1). The
// database is mocked; the real-Postgres flow is in
// src/e2e/revocation-flow.integration.test.ts.
//   • 400 ISS_INVALID for a missing or malformed iss
//   • 403 ISSUER_MISMATCH when an issuer key asks for another iss (no DB read)
//   • 200 with RFC-AITP-0008 entries (reason only when set), no-store
//   • 503 REVOCATION_UNAVAILABLE on a DB fault, never an empty 200
//   • the last-pull gauge moves only for a successful issuer-key pull

import { jest } from '@jest/globals';

let rows: { jti: string; revokedAt: number; reason: string | null }[] = [];
let readError: unknown = null;
const selectMock = jest.fn();

jest.mock('@/lib/db', () => ({
  db: {
    select: (...a: unknown[]) => {
      selectMock(...a);
      return {
        from: () => ({
          where: () => ({
            orderBy: () => (readError ? Promise.reject(readError) : Promise.resolve(rows)),
          }),
        }),
      };
    },
  },
}));

const loggerErrorMock = jest.fn();
jest.mock('@/lib/logger', () => ({
  logger: { error: (...a: unknown[]) => loggerErrorMock(...a) },
}));

import { NextRequest } from 'next/server';
import { GET } from './route';
import { getIssuerLastPulls, resetIssuerPulls } from '@/lib/revocation/relay-metrics';

const AID = 'aid:pubkey:O4nSX0IWKDbZqISunQN2NnEba2AnDIlxY2jjSmqMCMs';
const OTHER = 'aid:pubkey:Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';

function get(iss: string | null, headers: Record<string, string> = {}) {
  const q = iss === null ? '' : `?iss=${encodeURIComponent(iss)}`;
  return GET(new NextRequest(`http://localhost/api/revocations${q}`, { headers }));
}
const asIssuer = (aid: string) => ({ 'x-aitp-key-issuer': aid, 'x-aitp-key-label': 'researcher' });

beforeEach(() => {
  rows = [];
  readError = null;
  selectMock.mockReset();
  loggerErrorMock.mockReset();
  resetIssuerPulls();
});

describe('GET /api/revocations', () => {
  it.each([null, '', 'did:web:x', 'aid:has space'])('answers 400 ISS_INVALID for iss=%p', async (iss) => {
    const res = await get(iss);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('ISS_INVALID');
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('answers 403 ISSUER_MISMATCH when an issuer key asks for another issuer', async () => {
    const res = await get(OTHER, asIssuer(AID));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('ISSUER_MISMATCH');
    expect(selectMock).not.toHaveBeenCalled();
    expect(getIssuerLastPulls().size).toBe(0);
  });

  it('answers the entries in RFC-AITP-0008 shape, reason only when set', async () => {
    rows = [
      { jti: 'j1', revokedAt: 100, reason: 'compromised' },
      { jti: 'j2', revokedAt: 200, reason: null },
    ];
    const res = await get(AID, asIssuer(AID));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      iss: AID,
      entries: [
        { jti: 'j1', revoked_at: 100, reason: 'compromised' },
        { jti: 'j2', revoked_at: 200 },
      ],
    });
  });

  it('records the pull for an issuer key, and not for an admin key', async () => {
    await get(AID, { 'x-aitp-key-label': 'ops' });
    expect(getIssuerLastPulls().size).toBe(0);
    await get(AID, asIssuer(AID));
    const pull = getIssuerLastPulls().get('researcher');
    expect(pull?.secs).toBeGreaterThan(0);
    expect(pull?.aid).toBe(AID);
  });

  it('fails closed with 503 on a database fault, and records no pull', async () => {
    readError = new Error('connection refused');
    const res = await get(AID, asIssuer(AID));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('REVOCATION_UNAVAILABLE');
    expect(body.error).not.toContain('connection refused');
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(getIssuerLastPulls().size).toBe(0);
  });
});
