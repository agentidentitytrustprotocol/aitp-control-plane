// End-to-end unit tests for the proxy() request gate: auth, rate
// limiting, client-IP resolution and the x-request-id contract. config and
// the rate limiter are mocked per-scenario so we drive each branch
// deterministically without env juggling or a real bucket store.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import {
  parseApiKeys,
  parseIssuerKeys,
  parseReadOnlyApiKeys,
  type ApiKeyEntry,
} from './lib/api-keys';

interface MockConfig {
  /** Raw API_KEYS entries (`key` or `label:key`), parsed like config.ts does. */
  apiKeys: string[];
  /** Raw ISSUER_KEYS entries (`label@aid=key`). */
  issuerKeys: string[];
  /** Raw READ_ONLY_API_KEYS entries (`label:key`). */
  readOnlyKeys: string[];
  isProduction: boolean;
  rateLimitEnabled: boolean;
  rateLimitWindowMs: number;
  clientIpHeader: string;
  trustedProxyHops: number;
  rateLimitEnrollPerIpMin: number;
  rateLimitPublicPerIpMin: number;
  rateLimitApiKeyMin: number;
  rateLimitReadKeyMin: number;
  corsOrigin: string;
}

const DEFAULTS: MockConfig = {
  apiKeys: [],
  issuerKeys: [],
  readOnlyKeys: [],
  isProduction: false,
  rateLimitEnabled: true,
  rateLimitWindowMs: 60_000,
  clientIpHeader: '',
  trustedProxyHops: 0,
  rateLimitEnrollPerIpMin: 5,
  rateLimitPublicPerIpMin: 60,
  rateLimitApiKeyMin: 600,
  rateLimitReadKeyMin: 1200,
  corsOrigin: 'https://console.example.com',
};

type Decision = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
};

/** (Re)load proxy with a fresh mocked config + rate limiter. The
 * check spy records (bucketName, key, limit) so IP/bucket selection can be
 * asserted without exporting the private helpers. */
function load(
  cfg: Partial<MockConfig> = {},
  decision: Decision = { allowed: true, remaining: 9, resetAt: 0, limit: 60 },
) {
  jest.resetModules();
  const merged = { ...DEFAULTS, ...cfg };
  // Same parse as src/lib/config.ts, so `label:key` entries are exercised
  // through the real parser rather than a hand-built entries list.
  const apiKeyEntries: ApiKeyEntry[] = parseApiKeys(merged.apiKeys.join(',')).entries;
  const issuerKeyEntries = parseIssuerKeys(
    merged.issuerKeys.join(','),
    apiKeyEntries.map((e) => e.key),
  ).entries;
  const config = {
    ...merged,
    apiKeys: apiKeyEntries.map((e) => e.key),
    apiKeyEntries,
    issuerKeyEntries,
    readOnlyKeyEntries: parseReadOnlyApiKeys(
      merged.readOnlyKeys.join(','),
      apiKeyEntries.map((e) => e.key),
      issuerKeyEntries.map((e) => e.key),
      apiKeyEntries.map((e) => e.label),
    ).entries,
  };
  const check =
    jest.fn<(b: string, k: string, l: number, w: number) => Decision>(
      () => decision,
    );
  jest.doMock('./lib/config', () => ({ config }));
  jest.doMock('./lib/rate-limit', () => ({ rateLimiter: { check } }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { proxy } = require('./proxy') as {
    proxy: (r: NextRequest) => Response;
  };
  return { proxy, check };
}

function req(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
  });
}

describe('proxy — routing & request id', () => {
  it('ignores non-/api paths entirely', () => {
    const { proxy, check } = load();
    const res = proxy(req('/dashboard'));
    expect(res.status).toBe(200);
    expect(check).not.toHaveBeenCalled();
  });

  it('stamps x-request-id on a passed-through public request', () => {
    const { proxy } = load();
    const res = proxy(req('/api/health'));
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('preserves a caller-supplied x-request-id', () => {
    const { proxy } = load();
    const res = proxy(
      req('/api/health', { headers: { 'x-request-id': 'trace-abc' } }),
    );
    expect(res.headers.get('x-request-id')).toBe('trace-abc');
  });

  // The two assertions above prove the CLIENT sees the request id. Nothing
  // proved the id actually reaches the route handler — a different contract,
  // and the one that matters for correlating a downstream log line.
  //
  // `NextResponse.next({ request: { headers } })` encodes forwarded headers as
  // `x-middleware-override-headers` (the allowlist) plus one
  // `x-middleware-request-<name>` per value. Next's own router consumes exactly
  // those to rewrite the downstream request, so asserting them here is the real
  // contract rather than a stand-in for it. Rejected alternative: adding an echo
  // route to the app so an HTTP-level test could observe the id arriving — that
  // is a permanent unauthenticated reflection endpoint on the auth path, added
  // for test convenience.
  it('forwards x-request-id downstream to the route handler, not just to the client', () => {
    const { proxy } = load();
    const res = proxy(
      req('/api/health', { headers: { 'x-request-id': 'trace-abc' } }),
    );
    expect(res.headers.get('x-middleware-override-headers')).toContain(
      'x-request-id',
    );
    expect(res.headers.get('x-middleware-request-x-request-id')).toBe(
      'trace-abc',
    );
  });

  it('answers OPTIONS preflight with 204 + CORS headers, no auth or rate limiting', () => {
    const { proxy, check } = load({ apiKeys: ['k1'] });
    const res = proxy(req('/api/sessions', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://console.example.com',
    );
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(check).not.toHaveBeenCalled();
  });

  it('stamps the runtime CORS origin on passed-through API responses', () => {
    const { proxy } = load();
    const res = proxy(req('/api/health'));
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://console.example.com',
    );
  });
});

describe('proxy — auth', () => {
  it('returns 401 INVALID_API_KEY when keys are set but token is missing', async () => {
    const { proxy } = load({ apiKeys: ['secret-key'] });
    const res = proxy(req('/api/sessions'));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_API_KEY' });
  });

  it('returns 401 for a wrong token', async () => {
    const { proxy } = load({ apiKeys: ['secret-key'] });
    const res = proxy(
      req('/api/sessions', { headers: { authorization: 'Bearer nope' } }),
    );
    expect(res.status).toBe(401);
  });

  it('admits a valid Bearer token', () => {
    const { proxy } = load({ apiKeys: ['secret-key'] });
    const res = proxy(
      req('/api/sessions', {
        headers: { authorization: 'Bearer secret-key' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('returns 503 SERVER_MISCONFIGURED for a protected route in prod with no keys', async () => {
    const { proxy } = load({ apiKeys: [], isProduction: true });
    const res = proxy(req('/api/sessions'));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: 'SERVER_MISCONFIGURED',
    });
  });

  it('falls through (dev) for a protected route with no keys configured', () => {
    const { proxy } = load({ apiKeys: [], isProduction: false });
    const res = proxy(req('/api/sessions'));
    expect(res.status).toBe(200);
  });

  it('treats GET /api/registry/agents/{aid} as public discovery', () => {
    const { proxy } = load({ apiKeys: ['k'] });
    const res = proxy(req('/api/registry/agents/aid:pubkey:z:abc'));
    expect(res.status).toBe(200);
  });
});

describe('proxy — per-consumer key labels', () => {
  const LABEL = 'x-middleware-request-x-aitp-key-label';

  it('forwards the label of the key that authenticated the request', () => {
    const { proxy } = load({ apiKeys: ['console:key-a-secret', 'ops:key-b-secret'] });
    const a = proxy(req('/api/sessions', { headers: { authorization: 'Bearer key-a-secret' } }));
    const b = proxy(req('/api/sessions', { headers: { authorization: 'Bearer key-b-secret' } }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers.get(LABEL)).toBe('console');
    expect(b.headers.get(LABEL)).toBe('ops');
  });

  it('labels a bare key unlabelled-<n> by list position (backward compatible)', () => {
    const { proxy } = load({ apiKeys: ['console:key-a-secret', 'bare-key-secret'] });
    const res = proxy(req('/api/sessions', { headers: { authorization: 'Bearer bare-key-secret' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get(LABEL)).toBe('unlabelled-2');
  });

  it('a `label:key` entry authenticates with the key alone, not the whole entry', () => {
    const { proxy } = load({ apiKeys: ['console:key-a-secret'] });
    const whole = proxy(
      req('/api/sessions', { headers: { authorization: 'Bearer console:key-a-secret' } }),
    );
    expect(whole.status).toBe(401);
  });

  it('drops a client-supplied label / client-ip header instead of forwarding it', () => {
    const { proxy } = load({ apiKeys: ['console:key-a-secret'] });
    const gated = proxy(
      req('/api/sessions', {
        headers: {
          authorization: 'Bearer key-a-secret',
          'x-aitp-key-label': 'spoofed',
          'x-aitp-client-ip': '203.0.113.9',
        },
      }),
    );
    expect(gated.headers.get(LABEL)).toBe('console');
    expect(gated.headers.get('x-middleware-request-x-aitp-client-ip')).toBeNull();
    const pub = proxy(req('/api/health', { headers: { 'x-aitp-key-label': 'spoofed' } }));
    expect(pub.headers.get(LABEL)).toBeNull();
  });

  it('forwards the resolved client IP for the audit log', () => {
    const { proxy } = load({ apiKeys: ['console:key-a-secret'] });
    const res = proxy(
      req('/api/sessions', {
        headers: { authorization: 'Bearer key-a-secret', 'x-real-ip': '198.51.100.7' },
      }),
    );
    expect(res.headers.get('x-middleware-request-x-aitp-client-ip')).toBe('198.51.100.7');
  });

  // The rotation shape from H0.1: old key O and new key N side by side, then O
  // removed from API_KEYS. N keeps working; O is refused at the gate.
  it('two keys, one removed: the removed key answers 401 and the other still works', async () => {
    const both = load({ apiKeys: ['console-old:key-old-secret', 'console-new:key-new-secret'] });
    for (const k of ['key-old-secret', 'key-new-secret']) {
      const r = both.proxy(req('/api/sessions', { headers: { authorization: `Bearer ${k}` } }));
      expect(r.status).toBe(200);
    }

    const after = load({ apiKeys: ['console-new:key-new-secret'] });
    const old = after.proxy(
      req('/api/sessions', { headers: { authorization: 'Bearer key-old-secret' } }),
    );
    expect(old.status).toBe(401);
    await expect(old.json()).resolves.toMatchObject({ code: 'INVALID_API_KEY' });
    const kept = after.proxy(
      req('/api/sessions', { headers: { authorization: 'Bearer key-new-secret' } }),
    );
    expect(kept.status).toBe(200);
    expect(kept.headers.get(LABEL)).toBe('console-new');
  });

  it('rate-limits per key, not per label: two keys sharing a label get separate buckets', () => {
    const { proxy, check } = load({ apiKeys: ['console:aaaa-first-key', 'console:bbbb-second-key'] });
    proxy(req('/api/sessions', { headers: { authorization: 'Bearer aaaa-first-key' } }));
    proxy(req('/api/sessions', { headers: { authorization: 'Bearer bbbb-second-key' } }));
    const keys = check.mock.calls.filter((c) => c[0] === 'api-key').map((c) => c[1]);
    expect(keys).toEqual(['aaaa-first-key', 'bbbb-second-key']);
  });
});

describe('proxy — rate limiting', () => {
  it('returns 429 with Retry-After and X-RateLimit headers when denied', async () => {
    const resetAt = Date.now() + 30_000;
    const { proxy } = load(
      { apiKeys: [] },
      { allowed: false, remaining: 0, resetAt, limit: 60 },
    );
    const res = proxy(req('/api/sessions'));
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('does not rate-limit exempt probe paths', () => {
    const { proxy, check } = load();
    proxy(req('/api/readyz'));
    expect(check).not.toHaveBeenCalled();
  });

  it('skips rate limiting entirely when disabled', () => {
    const { proxy, check } = load({ rateLimitEnabled: false });
    proxy(req('/api/health'));
    expect(check).not.toHaveBeenCalled();
  });

  it('uses the strict enroll-ip bucket for /api/registry/enroll', () => {
    const { proxy, check } = load();
    proxy(req('/api/registry/enroll', { method: 'POST' }));
    expect(check).toHaveBeenCalledWith('enroll-ip', expect.any(String), 5, 60_000);
  });

  it('buckets authenticated traffic by api-key prefix', () => {
    const { proxy, check } = load({ apiKeys: ['secret-key-value'] });
    proxy(
      req('/api/sessions', {
        headers: { authorization: 'Bearer secret-key-value' },
      }),
    );
    expect(check).toHaveBeenCalledWith(
      'api-key',
      'secret-key-value'.slice(0, 24),
      600,
      60_000,
    );
  });
});

describe('proxy — client IP resolution', () => {
  it('trusts a configured platform header over XFF', () => {
    const { proxy, check } = load({ clientIpHeader: 'cf-connecting-ip' });
    proxy(
      req('/api/registry/enroll', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '1.1.1.1',
        },
      }),
    );
    expect(check).toHaveBeenCalledWith('enroll-ip', '203.0.113.7', 5, 60_000);
  });

  it('reads XFF from the right by trusted-proxy hop count', () => {
    const { proxy, check } = load({ trustedProxyHops: 1 });
    proxy(
      req('/api/registry/enroll', {
        method: 'POST',
        // client, edge → with 1 trusted hop the real client is 1 from the end.
        headers: { 'x-forwarded-for': 'evil-spoof, 198.51.100.9' },
      }),
    );
    expect(check).toHaveBeenCalledWith('enroll-ip', '198.51.100.9', 5, 60_000);
  });

  it('does not trust XFF at all with 0 hops, falling back to x-real-ip', () => {
    const { proxy, check } = load({ trustedProxyHops: 0 });
    proxy(
      req('/api/registry/enroll', {
        method: 'POST',
        headers: {
          'x-forwarded-for': 'spoofed-client',
          'x-real-ip': '198.51.100.50',
        },
      }),
    );
    expect(check).toHaveBeenCalledWith('enroll-ip', '198.51.100.50', 5, 60_000);
  });

  it('buckets under "unknown" when no IP headers are present', () => {
    const { proxy, check } = load();
    proxy(req('/api/registry/enroll', { method: 'POST' }));
    expect(check).toHaveBeenCalledWith('enroll-ip', 'unknown', 5, 60_000);
  });
});

// Issuer keys (ISSUER_KEYS, CP1.1) open exactly one door, GET
// /api/revocations, and the gate tells the route which AID the key is bound
// to. Everywhere else such a key is an unknown key.
describe('proxy — issuer keys', () => {
  const ISSUER_AID = 'aid:pubkey:O4nSX0IWKDbZqISunQN2NnEba2AnDIlxY2jjSmqMCMs';
  const ADMIN_KEY = 'admin-key-0123456789abcdef';
  const ISSUER_KEY = 'issuer-key-0123456789abcdef';
  const ROUTE = `/api/revocations?iss=${encodeURIComponent(ISSUER_AID)}`;
  const cfg = {
    apiKeys: [`ops:${ADMIN_KEY}`],
    issuerKeys: [`researcher@${ISSUER_AID}=${ISSUER_KEY}`],
  };
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
  /** A request header the gate forwards to the handler. */
  const forwarded = (res: Response, name: string) =>
    res.headers.get(`x-middleware-request-${name}`);

  it('admits an issuer key on GET /api/revocations and forwards its AID and label', () => {
    const { proxy } = load(cfg);
    const res = proxy(req(ROUTE, { headers: bearer(ISSUER_KEY) }));
    expect(res.status).toBe(200);
    expect(forwarded(res, 'x-aitp-key-issuer')).toBe(ISSUER_AID);
    expect(forwarded(res, 'x-aitp-key-label')).toBe('researcher');
  });

  it.each([
    ['/api/revocation/entries', 'POST'],
    ['/api/revocation/entries', 'GET'],
    ['/api/revocation/issuers', 'GET'],
    ['/api/registry/agents/aid:abc/export', 'GET'],
    ['/api/revocations', 'POST'],
  ])('is an unknown key on %s %s (401)', (path, method) => {
    const { proxy } = load(cfg);
    expect(proxy(req(path, { method, headers: bearer(ISSUER_KEY) })).status).toBe(401);
  });

  it('admits an admin key on the route without binding an issuer', () => {
    const { proxy } = load(cfg);
    const res = proxy(req(ROUTE, { headers: bearer(ADMIN_KEY) }));
    expect(res.status).toBe(200);
    expect(forwarded(res, 'x-aitp-key-issuer')).toBeNull();
    expect(forwarded(res, 'x-aitp-key-label')).toBe('ops');
  });

  it('refuses the route with no key', () => {
    const { proxy } = load(cfg);
    expect(proxy(req(ROUTE)).status).toBe(401);
  });

  it('strips a client-supplied issuer header', () => {
    const { proxy } = load(cfg);
    const res = proxy(
      req(ROUTE, { headers: { ...bearer(ADMIN_KEY), 'x-aitp-key-issuer': 'aid:pubkey:forged' } }),
    );
    expect(res.status).toBe(200);
    expect(forwarded(res, 'x-aitp-key-issuer')).toBeNull();
  });

  it('rate-limits an issuer key in its own per-key bucket', () => {
    const { proxy, check } = load(cfg);
    proxy(req(ROUTE, { headers: bearer(ISSUER_KEY) }));
    expect(check).toHaveBeenCalledWith('api-key', ISSUER_KEY.slice(0, 24), 600, 60_000);
  });

  it('no longer treats the removed CP-signed list path as public', () => {
    const { proxy } = load(cfg);
    expect(proxy(req('/api/well-known/aitp-revocation-list')).status).toBe(401);
  });
});

// Wave 3 (P1): /api/metrics needs an API_KEYS (admin) key. It stays exempt
// from rate limiting so a scraper is never throttled, but only after auth.
describe('proxy — /api/metrics requires an admin key', () => {
  const ADMIN = 'admin-metrics-key-0123456789';
  const ISSUER_AID = 'aid:pubkey:O4nSX0IWKDbZqISunQN2NnEba2AnDIlxY2jjSmqMCMs';
  const ISSUER_KEY = 'issuer-metrics-key-0123456789';
  const cfg = {
    apiKeys: [`ops:${ADMIN}`],
    issuerKeys: [`researcher@${ISSUER_AID}=${ISSUER_KEY}`],
  };

  it('401 INVALID_API_KEY with no key', async () => {
    const { proxy, check } = load(cfg);
    const res = proxy(req('/api/metrics'));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_API_KEY' });
    expect(check).not.toHaveBeenCalled();
  });

  it('401 for HEAD with no key (every method goes through the admin branch)', () => {
    const { proxy } = load(cfg);
    expect(proxy(req('/api/metrics', { method: 'HEAD' })).status).toBe(401);
  });

  it('401 with an unknown key', () => {
    const { proxy } = load(cfg);
    const res = proxy(
      req('/api/metrics', { headers: { authorization: 'Bearer not-a-key' } }),
    );
    expect(res.status).toBe(401);
  });

  it('401 with an issuer key (issuer keys only open GET /api/revocations)', () => {
    const { proxy } = load(cfg);
    const res = proxy(
      req('/api/metrics', { headers: { authorization: `Bearer ${ISSUER_KEY}` } }),
    );
    expect(res.status).toBe(401);
  });

  it('admits an admin key, forwards its label and skips the rate limiter', () => {
    const { proxy, check } = load(cfg);
    const res = proxy(
      req('/api/metrics', { headers: { authorization: `Bearer ${ADMIN}` } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-request-x-aitp-key-label')).toBe('ops');
    expect(check).not.toHaveBeenCalled();
  });

  it('never 429s an admin scraper even when every bucket is exhausted', () => {
    const { proxy, check } = load(cfg, {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
      limit: 1,
    });
    for (let i = 0; i < 100; i++) {
      const res = proxy(
        req('/api/metrics', { headers: { authorization: `Bearer ${ADMIN}` } }),
      );
      expect(res.status).toBe(200);
    }
    expect(check).not.toHaveBeenCalled();
  });

  it('503 SERVER_MISCONFIGURED in prod with no API_KEYS', async () => {
    const { proxy } = load({ apiKeys: [], isProduction: true });
    const res = proxy(req('/api/metrics'));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'SERVER_MISCONFIGURED' });
  });

  it('stays open in dev with no API_KEYS', () => {
    const { proxy } = load({ apiKeys: [], isProduction: false });
    expect(proxy(req('/api/metrics')).status).toBe(200);
  });
});

// Wave 3 (P2): READ_ONLY_API_KEYS. A read key opens GET on an anchored
// allowlist only; everything else it presents is a 403 READ_ONLY_KEY. It has its
// own per-key rate bucket so visitor reads never drain an admin key's budget.
describe('proxy — read-only keys', () => {
  const ISSUER_AID = 'aid:pubkey:O4nSX0IWKDbZqISunQN2NnEba2AnDIlxY2jjSmqMCMs';
  const ADMIN_KEY = 'admin-key-0123456789abcdef';
  const READ_KEY = 'read-key-0123456789abcdefgh';
  const ISSUER_KEY = 'issuer-key-0123456789abcdef';
  const cfg = {
    apiKeys: [`ops:${ADMIN_KEY}`],
    readOnlyKeys: [`console-ro:${READ_KEY}`],
    issuerKeys: [`researcher@${ISSUER_AID}=${ISSUER_KEY}`],
  };
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
  const forwarded = (res: Response, name: string) =>
    res.headers.get(`x-middleware-request-${name}`);
  const DENY: Decision = { allowed: false, remaining: 0, resetAt: Date.now() + 30_000, limit: 1200 };
  const ALLOW: Decision = { allowed: true, remaining: 9, resetAt: 0, limit: 600 };

  const ALLOWED = [
    '/api/dashboard/agents',
    '/api/dashboard/overview',
    '/api/delegations',
    '/api/events/history',
    '/api/events/stream',
    '/api/pinned-keys',
    '/api/revocation/issuers',
    '/api/sessions',
    '/api/sessions/s-1',
    '/api/sessions/s-1/replay',
    '/api/sessions/s-1/export',
    '/api/tcts',
    '/api/trust-anchors',
    '/api/trust-anchors/ta-1',
    '/api/trust-anchors/ta-1/jwks',
  ];

  it.each(ALLOWED)('admits GET %s and forwards label + kind=read', (path) => {
    const { proxy, check } = load(cfg);
    const res = proxy(req(path, { headers: bearer(READ_KEY) }));
    expect(res.status).toBe(200);
    expect(forwarded(res, 'x-aitp-key-label')).toBe('console-ro');
    expect(forwarded(res, 'x-aitp-key-kind')).toBe('read');
    expect(check).toHaveBeenCalledWith('read-key', READ_KEY.slice(0, 24), 1200, 60_000);
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'])(
    'refuses %s on an allowlisted path with 403 READ_ONLY_KEY, before the limiter',
    async (method) => {
      const { proxy, check } = load(cfg);
      const res = proxy(req('/api/pinned-keys', { method, headers: bearer(READ_KEY) }));
      expect(res.status).toBe(403);
      if (method !== 'HEAD') {
        expect(await res.json()).toEqual({
          error: 'Forbidden: read-only key',
          code: 'READ_ONLY_KEY',
        });
      }
      expect(check).not.toHaveBeenCalled();
    },
  );

  it.each([
    '/api/audit',
    '/api/metrics',
    '/api/webhooks',
    '/api/webhooks/x/circuit-breaker',
    `/api/revocations?iss=${encodeURIComponent(ISSUER_AID)}`,
    '/api/registry/agents/a/export',
    '/api/revocation/entries',
    '/api/pinned-keys/',
    '/api/Pinned-Keys',
    '/api/sessions/s-1/replay/extra',
    '/api/trust-anchors/ta-1/jwks/x',
  ])('refuses GET %s with 403 READ_ONLY_KEY', async (path) => {
    const { proxy } = load(cfg);
    const res = proxy(req(path, { headers: bearer(READ_KEY) }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('READ_ONLY_KEY');
  });

  it('accepts a raw (no Bearer) read key like Bearer, and refuses lowercase bearer as unknown', () => {
    const { proxy } = load(cfg);
    expect(proxy(req('/api/tcts', { headers: { authorization: READ_KEY } })).status).toBe(200);
    expect(
      proxy(req('/api/tcts', { headers: { authorization: `bearer ${READ_KEY}` } })).status,
    ).toBe(401);
  });

  it('keeps an unknown key a 401 (not 403) on allowlisted and forbidden routes', () => {
    const { proxy } = load(cfg);
    expect(proxy(req('/api/tcts', { headers: bearer('nope-nope-nope') })).status).toBe(401);
    expect(proxy(req('/api/audit', { headers: bearer('nope-nope-nope') })).status).toBe(401);
  });

  it('does not let an issuer key use the read allowlist', () => {
    const { proxy } = load(cfg);
    expect(proxy(req('/api/tcts', { headers: bearer(ISSUER_KEY) })).status).toBe(401);
  });

  it('forwards kind=admin for an admin key and kind=issuer for an issuer key', () => {
    const { proxy } = load(cfg);
    const admin = proxy(req('/api/audit', { headers: bearer(ADMIN_KEY) }));
    expect(forwarded(admin, 'x-aitp-key-kind')).toBe('admin');
    const issuer = proxy(
      req(`/api/revocations?iss=${encodeURIComponent(ISSUER_AID)}`, {
        headers: bearer(ISSUER_KEY),
      }),
    );
    expect(forwarded(issuer, 'x-aitp-key-kind')).toBe('issuer');
  });

  it('strips a client-supplied kind header everywhere, including public routes', () => {
    const { proxy } = load(cfg);
    const gated = proxy(
      req('/api/tcts', { headers: { ...bearer(READ_KEY), 'x-aitp-key-kind': 'admin' } }),
    );
    expect(forwarded(gated, 'x-aitp-key-kind')).toBe('read');
    const pub = proxy(req('/api/health', { headers: { 'x-aitp-key-kind': 'admin' } }));
    expect(forwarded(pub, 'x-aitp-key-kind')).toBeNull();
    const pubKeyed = proxy(
      req('/api/registry/agents', { headers: { ...bearer(ADMIN_KEY), 'x-aitp-key-kind': 'x' } }),
    );
    expect(forwarded(pubKeyed, 'x-aitp-key-kind')).toBeNull();
    expect(forwarded(pubKeyed, 'x-aitp-key-label')).toBeNull();
  });

  it('a 429 on the read-key bucket does not throttle the admin key', async () => {
    const { proxy, check } = load(cfg);
    check.mockImplementation((bucket) => (bucket === 'read-key' ? DENY : ALLOW));
    const read = proxy(req('/api/tcts', { headers: bearer(READ_KEY) }));
    expect(read.status).toBe(429);
    expect(read.headers.get('Retry-After')).toBeTruthy();
    expect((await read.json()).bucket).toBe('read-key');
    const admin = proxy(req('/api/tcts', { headers: bearer(ADMIN_KEY) }));
    expect(admin.status).toBe(200);
    expect(check).toHaveBeenLastCalledWith('api-key', ADMIN_KEY.slice(0, 24), 600, 60_000);
  });

  it('puts a keyed public GET in that key bucket, never public-ip', () => {
    const { proxy, check } = load({ ...cfg, rateLimitPublicPerIpMin: 5 });
    check.mockImplementation((bucket) => (bucket === 'public-ip' ? DENY : ALLOW));
    for (let i = 0; i < 100; i++) {
      expect(
        proxy(req('/api/registry/agents', { headers: bearer(READ_KEY) })).status,
      ).toBe(200);
    }
    expect(check).toHaveBeenCalledWith('read-key', READ_KEY.slice(0, 24), 1200, 60_000);
    expect(check).not.toHaveBeenCalledWith('public-ip', expect.anything(), 5, 60_000);
    proxy(req('/api/registry/agents/aid:x', { headers: bearer(ADMIN_KEY) }));
    expect(check).toHaveBeenLastCalledWith('api-key', ADMIN_KEY.slice(0, 24), 600, 60_000);
  });

  it('keeps junk keys, issuer keys, public writes and enroll on the per-IP buckets', () => {
    const { proxy, check } = load(cfg);
    proxy(req('/api/registry/agents', { headers: bearer('junk-junk-junk') }));
    expect(check).toHaveBeenLastCalledWith('public-ip', 'unknown', 60, 60_000);
    proxy(req('/api/registry/agents', { headers: bearer(ISSUER_KEY) }));
    expect(check).toHaveBeenLastCalledWith('public-ip', 'unknown', 60, 60_000);
    proxy(req('/api/registry/agents', { method: 'POST', headers: bearer(READ_KEY) }));
    expect(check).toHaveBeenLastCalledWith('public-ip', 'unknown', 60, 60_000);
    proxy(req('/api/registry/agents', { method: 'POST', headers: bearer(ADMIN_KEY) }));
    expect(check).toHaveBeenLastCalledWith('public-ip', 'unknown', 60, 60_000);
    proxy(req('/api/registry/enroll', { method: 'POST', headers: bearer(ADMIN_KEY) }));
    expect(check).toHaveBeenLastCalledWith('enroll-ip', 'unknown', 5, 60_000);
  });

  it('treats a read key on a public route as public (POST /api/registry/agents still reaches the handler)', () => {
    const { proxy } = load(cfg);
    const res = proxy(req('/api/registry/agents', { method: 'POST', headers: bearer(READ_KEY) }));
    expect(res.status).toBe(200);
    expect(forwarded(res, 'x-aitp-key-label')).toBeNull();
  });

  it('drops a read entry that reuses an admin key: that key stays admin', () => {
    const { proxy } = load({ ...cfg, readOnlyKeys: [`dup:${ADMIN_KEY}`] });
    const res = proxy(req('/api/audit', { headers: bearer(ADMIN_KEY) }));
    expect(res.status).toBe(200);
    expect(forwarded(res, 'x-aitp-key-kind')).toBe('admin');
  });

  it('in dev with no API_KEYS stays open, and read keys alone do not close it', () => {
    const { proxy } = load({ apiKeys: [], readOnlyKeys: [`console-ro:${READ_KEY}`] });
    expect(proxy(req('/api/audit')).status).toBe(200);
    expect(proxy(req('/api/audit', { method: 'POST' })).status).toBe(200);
  });

  it('in prod with no API_KEYS answers 503 even to a read key', () => {
    const { proxy } = load({
      apiKeys: [],
      readOnlyKeys: [`console-ro:${READ_KEY}`],
      isProduction: true,
    });
    expect(proxy(req('/api/tcts', { headers: bearer(READ_KEY) })).status).toBe(503);
  });
});
