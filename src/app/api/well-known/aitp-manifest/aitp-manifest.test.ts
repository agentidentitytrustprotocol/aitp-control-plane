// Unit test for GET /api/well-known/aitp-manifest.
// Verifies the route returns the CP manifest JSON verbatim with
// Content-Type: application/json and a 1-hour cache header.
// The underlying cp-agent identity service is mocked (no key generation).

import { jest } from '@jest/globals';

const MANIFEST_JSON = JSON.stringify({
  manifest: { aid: 'aid:pubkey:cp-test', display_name: 'cp' },
  sig: 'fake-sig',
});

const getCpManifestJsonMock = jest.fn(() => MANIFEST_JSON);
jest.mock('@/lib/identity/cp-agent', () => ({
  getCpManifestJson: () => getCpManifestJsonMock(),
}));

import { GET } from './route';

describe('GET /api/well-known/aitp-manifest', () => {
  it('returns the CP manifest JSON verbatim with cache + content-type headers', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('max-age=3600');
    expect(await res.text()).toBe(MANIFEST_JSON);
    expect(getCpManifestJsonMock).toHaveBeenCalledTimes(1);
  });
});
