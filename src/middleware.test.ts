/**
 * Regression tests for middleware's public/private routing.
 *
 * The original `PUBLIC_GET_PREFIXES` array used startsWith() — that
 * accidentally exposed `/api/registry/agents/{aid}/export` (an admin
 * route added later) as public. The shape-anchored regex patterns fix
 * that. These tests lock the contract so the next "let's just add
 * another sub-route under /agents/" doesn't reintroduce the leak.
 */

import { isPublicRequest } from './middleware';

describe('isPublicRequest', () => {
  describe('explicit public collection paths', () => {
    const cases: Array<[string, string]> = [
      ['/api/health', 'GET'],
      ['/api/readyz', 'GET'],
      ['/api/well-known/aitp-manifest', 'GET'],
      ['/api/well-known/aitp-revocation-list', 'GET'],
      ['/api/registry/enroll', 'POST'],
      ['/api/registry/agents', 'GET'],
      ['/api/registry/agents', 'POST'], // enrollment-token gated inside handler
      ['/api/metrics', 'GET'],
    ];
    test.each(cases)('%s %s is public', (path, method) => {
      expect(isPublicRequest(path, method)).toBe(true);
    });
  });

  describe('public discovery under /api/registry/agents/', () => {
    it('GET /api/registry/agents/{aid} is public', () => {
      expect(
        isPublicRequest('/api/registry/agents/did:pubkey:z:abc', 'GET'),
      ).toBe(true);
    });
    it('GET /api/registry/agents/{aid}/manifest is public', () => {
      expect(
        isPublicRequest(
          '/api/registry/agents/did:pubkey:z:abc/manifest',
          'GET',
        ),
      ).toBe(true);
    });
    it('DELETE /api/registry/agents/{aid} is NOT public', () => {
      expect(
        isPublicRequest('/api/registry/agents/did:pubkey:z:abc', 'DELETE'),
      ).toBe(false);
    });
  });

  describe('admin sub-routes are NOT public (regression)', () => {
    // Each of these would have leaked under the old startsWith() prefix
    // check. They MUST be gated.
    const cases: Array<[string, string]> = [
      ['/api/registry/agents/aid:abc/export', 'GET'],
      ['/api/registry/agents/aid:abc/audit', 'GET'],
      ['/api/registry/agents/aid:abc/sessions', 'GET'],
      ['/api/registry/agents/aid:abc/anything-future', 'GET'],
    ];
    test.each(cases)('%s %s is gated', (path, method) => {
      expect(isPublicRequest(path, method)).toBe(false);
    });
  });

  describe('admin collections are NOT public', () => {
    const cases: Array<[string, string]> = [
      ['/api/tcts', 'GET'],
      ['/api/delegations', 'GET'],
      ['/api/trust-anchors', 'GET'],
      ['/api/trust-anchors', 'POST'],
      ['/api/pinned-keys', 'GET'],
      ['/api/pinned-keys', 'POST'],
      ['/api/sessions', 'GET'],
      ['/api/sessions/some-id/export', 'GET'],
      ['/api/sessions/some-id/replay', 'GET'],
      ['/api/audit', 'GET'],
      ['/api/webhooks', 'POST'],
      ['/api/webhooks/abc/circuit-breaker', 'GET'],
      ['/api/webhooks/abc/circuit-breaker/reset', 'POST'],
      ['/api/events', 'POST'],
      ['/api/events/history', 'GET'],
      ['/api/events/stream', 'GET'],
      ['/api/revocation/entries', 'POST'],
      ['/api/dashboard/overview', 'GET'],
    ];
    test.each(cases)('%s %s is gated', (path, method) => {
      expect(isPublicRequest(path, method)).toBe(false);
    });
  });
});
