/**
 * Regression tests for proxy's public/private routing.
 *
 * The original `PUBLIC_GET_PREFIXES` array used startsWith() — that
 * accidentally exposed `/api/registry/agents/{aid}/export` (an admin
 * route added later) as public. The shape-anchored regex patterns fix
 * that. These tests lock the contract so the next "let's just add
 * another sub-route under /agents/" doesn't reintroduce the leak.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isPublicRequest, isReadOnlyRoute } from './proxy';

describe('isPublicRequest', () => {
  describe('explicit public collection paths', () => {
    const cases: Array<[string, string]> = [
      ['/api/health', 'GET'],
      ['/api/readyz', 'GET'],
      ['/api/well-known/aitp-manifest', 'GET'],
      ['/api/registry/enroll', 'POST'],
      ['/api/registry/agents', 'GET'],
      ['/api/registry/agents', 'POST'], // enrollment-token gated inside handler
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

  it('the removed CP-signed revocation list is NOT public (CP1.1)', () => {
    expect(isPublicRequest('/api/well-known/aitp-revocation-list', 'GET')).toBe(false);
    expect(isPublicRequest('/api/revocations', 'GET')).toBe(false);
  });

  describe('admin collections are NOT public', () => {
    const cases: Array<[string, string]> = [
      ['/api/metrics', 'GET'], // wave 3: admin key required (counts are operator data)
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

describe('isReadOnlyRoute', () => {
  it.each([
    '/api/dashboard/agents',
    '/api/dashboard/overview',
    '/api/delegations',
    '/api/events/history',
    '/api/events/stream',
    '/api/pinned-keys',
    '/api/registry/agents',
    '/api/registry/agents/aid:pubkey:abc',
    '/api/registry/agents/aid:pubkey:abc/manifest',
    '/api/revocation/issuers',
    '/api/sessions',
    '/api/sessions/s-1',
    '/api/sessions/s-1/replay',
    '/api/sessions/s-1/export',
    '/api/tcts',
    '/api/trust-anchors',
    '/api/trust-anchors/ta-1',
    '/api/trust-anchors/ta-1/jwks',
  ])('allows %s', (path) => {
    expect(isReadOnlyRoute(path)).toBe(true);
  });

  it.each([
    '/api/audit',
    '/api/metrics',
    '/api/webhooks',
    '/api/webhooks/w-1',
    '/api/webhooks/w-1/circuit-breaker',
    '/api/revocations',
    '/api/revocation/entries',
    '/api/registry/agents/aid:x/export',
    '/api/registry/enroll',
    '/api/events',
    '/api/pinned-keys/',
    '/api/PINNED-KEYS',
    '/api/sessions//replay',
    '/api/sessions/s-1/replay/x',
    '/api/trust-anchors/ta-1/jwks/',
    '/api/dashboard',
  ])('refuses %s', (path) => {
    expect(isReadOnlyRoute(path)).toBe(false);
  });
});

// Every (route, method) the app exports, classified once. A new route file or a
// new exported method fails this test until it is added here, so nobody can
// ship a route without deciding who may call it. `read` = a READ_ONLY_API_KEYS
// key may call it (GET only); `admin` = API_KEYS only; `public` = no key.
describe('route inventory — every (route, method) is classified', () => {
  type Access = 'public' | 'read' | 'admin';
  const EXPECTED: Record<string, Access> = {
    'GET /api/audit': 'admin',
    'GET /api/dashboard/agents': 'read',
    'GET /api/dashboard/overview': 'read',
    'GET /api/delegations': 'read',
    'GET /api/events/history': 'read',
    'POST /api/events': 'admin',
    'GET /api/events/stream': 'read',
    'GET /api/health': 'public',
    'GET /api/metrics': 'admin',
    'GET /api/pinned-keys': 'read',
    'POST /api/pinned-keys': 'admin',
    'DELETE /api/pinned-keys': 'admin',
    'GET /api/readyz': 'public',
    'GET /api/registry/agents/[aid]/export': 'admin',
    'GET /api/registry/agents/[aid]/manifest': 'public',
    'GET /api/registry/agents/[aid]': 'public',
    'DELETE /api/registry/agents/[aid]': 'admin',
    'GET /api/registry/agents': 'public',
    'POST /api/registry/agents': 'public',
    'POST /api/registry/enroll': 'public',
    'POST /api/revocation/entries': 'admin',
    'GET /api/revocation/issuers': 'read',
    'GET /api/revocations': 'admin',
    'GET /api/sessions/[sessionId]/export': 'read',
    'GET /api/sessions/[sessionId]/replay': 'read',
    'GET /api/sessions/[sessionId]': 'read',
    'GET /api/sessions': 'read',
    'GET /api/tcts': 'read',
    'GET /api/trust-anchors/[id]/jwks': 'read',
    'GET /api/trust-anchors/[id]': 'read',
    'PATCH /api/trust-anchors/[id]': 'admin',
    'DELETE /api/trust-anchors/[id]': 'admin',
    'GET /api/trust-anchors': 'read',
    'POST /api/trust-anchors': 'admin',
    'POST /api/webhooks/[id]/circuit-breaker/reset': 'admin',
    'GET /api/webhooks/[id]/circuit-breaker': 'admin',
    'PATCH /api/webhooks/[id]': 'admin',
    'DELETE /api/webhooks/[id]': 'admin',
    'GET /api/webhooks': 'admin',
    'POST /api/webhooks': 'admin',
    'GET /api/well-known/aitp-manifest': 'public',
  };

  const API_DIR = join(__dirname, 'app', 'api');
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

  function routeFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return routeFiles(p);
      return e.name === 'route.ts' ? [p] : [];
    });
  }

  /** Exported HTTP methods: `export [async] function GET`, `export const GET`,
   * and `export { GET }` / `export { x as GET }` re-exports. */
  function exportedMethods(src: string): string[] {
    const found = new Set<string>();
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+([A-Z]+)\b/gm)) {
      found.add(m[1]);
    }
    for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop();
        if (name) found.add(name);
      }
    }
    return [...found].filter((n) => METHODS.includes(n));
  }

  // A concrete path for each dynamic segment, to drive the real gate helpers.
  const concrete = (route: string) =>
    route.replace(/\[[^\]]+\]/g, (seg) => `sample-${seg.slice(1, -1)}`);

  function classify(method: string, route: string): Access {
    const path = concrete(route);
    if (isPublicRequest(path, method)) return 'public';
    if (method === 'GET' && isReadOnlyRoute(path)) return 'read';
    return 'admin';
  }

  const discovered = routeFiles(API_DIR).flatMap((file) => {
    const route =
      '/api/' + relative(API_DIR, file).split(sep).slice(0, -1).join('/');
    return exportedMethods(readFileSync(file, 'utf8')).map(
      (method) => `${method} ${route.replace(/\/$/, '')}`,
    );
  });

  it('finds the route files (guards against a broken walk)', () => {
    expect(discovered.length).toBeGreaterThan(30);
  });

  it('classifies every exported (route, method) pair, and lists no stale ones', () => {
    expect([...discovered].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s is %s at the gate', (pair, access) => {
    const [method, route] = pair.split(' ');
    expect(classify(method, route)).toBe(access);
  });
});
