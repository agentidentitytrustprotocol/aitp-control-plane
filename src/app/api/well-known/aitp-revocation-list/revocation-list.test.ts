// Unit test for GET /api/well-known/aitp-revocation-list.
// Verifies the route returns the producer's signed envelope JSON verbatim
// with Content-Type: application/json and a 60s cache header.
// The revocation producer is mocked (no DB, no signing keys).

import { jest } from '@jest/globals';

const ENVELOPE_JSON = JSON.stringify({
  revoked: ['3f1d2c4b-1a2b-4c3d-8e4f-5a6b7c8d9e0f'],
  issued_at: 1780000000,
  sig: 'fake-sig',
});

const getEnvelopeJsonMock = jest.fn(async () => ENVELOPE_JSON);
class MockUnavailable extends Error {
  readonly code = 'REVOCATION_UNAVAILABLE';
  constructor() {
    super('revocation list temporarily unavailable');
  }
}
jest.mock('@/lib/revocation/producer', () => ({
  revocationProducer: { getEnvelopeJson: () => getEnvelopeJsonMock() },
  RevocationUnavailableError: MockUnavailable,
}));

import { GET } from './route';

describe('GET /api/well-known/aitp-revocation-list', () => {
  it('returns the producer envelope verbatim with cache + content-type headers', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('max-age=60');
    expect(await res.text()).toBe(ENVELOPE_JSON);
    expect(getEnvelopeJsonMock).toHaveBeenCalledTimes(1);
  });

  it('maps RevocationUnavailableError to a coded 503 with no-store and Retry-After', async () => {
    getEnvelopeJsonMock.mockRejectedValueOnce(new MockUnavailable());
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({
      error: 'revocation list temporarily unavailable',
      code: 'REVOCATION_UNAVAILABLE',
    });
  });

  it('rethrows anything else (framework 500, no body detail)', async () => {
    getEnvelopeJsonMock.mockRejectedValueOnce(new Error('relation "x" does not exist'));
    await expect(GET()).rejects.toThrow('does not exist');
  });
});
