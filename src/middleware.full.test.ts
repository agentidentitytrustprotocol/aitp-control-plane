// End-to-end unit tests for the middleware() request gate: auth, rate
// limiting, client-IP resolution and the x-request-id contract. config and
// the rate limiter are mocked per-scenario so we drive each branch
// deterministically without env juggling or a real bucket store.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

interface MockConfig {
  apiKeys: string[];
  isProduction: boolean;
  rateLimitEnabled: boolean;
  rateLimitWindowMs: number;
  clientIpHeader: string;
  trustedProxyHops: number;
  rateLimitEnrollPerIpMin: number;
  rateLimitPublicPerIpMin: number;
  rateLimitApiKeyMin: number;
  corsOrigin: string;
}

const DEFAULTS: MockConfig = {
  apiKeys: [],
  isProduction: false,
  rateLimitEnabled: true,
  rateLimitWindowMs: 60_000,
  clientIpHeader: '',
  trustedProxyHops: 0,
  rateLimitEnrollPerIpMin: 5,
  rateLimitPublicPerIpMin: 60,
  rateLimitApiKeyMin: 600,
  corsOrigin: 'https://console.example.com',
};

type Decision = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
};

/** (Re)load middleware with a fresh mocked config + rate limiter. The
 * check spy records (bucketName, key, limit) so IP/bucket selection can be
 * asserted without exporting the private helpers. */
function load(
  cfg: Partial<MockConfig> = {},
  decision: Decision = { allowed: true, remaining: 9, resetAt: 0, limit: 60 },
) {
  jest.resetModules();
  const config = { ...DEFAULTS, ...cfg };
  const check =
    jest.fn<(b: string, k: string, l: number, w: number) => Decision>(
      () => decision,
    );
  jest.doMock('./lib/config', () => ({ config }));
  jest.doMock('./lib/rate-limit', () => ({ rateLimiter: { check } }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { middleware } = require('./middleware') as {
    middleware: (r: NextRequest) => Response;
  };
  return { middleware, check };
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

describe('middleware — routing & request id', () => {
  it('ignores non-/api paths entirely', () => {
    const { middleware, check } = load();
    const res = middleware(req('/dashboard'));
    expect(res.status).toBe(200);
    expect(check).not.toHaveBeenCalled();
  });

  it('stamps x-request-id on a passed-through public request', () => {
    const { middleware } = load();
    const res = middleware(req('/api/health'));
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('preserves a caller-supplied x-request-id', () => {
    const { middleware } = load();
    const res = middleware(
      req('/api/health', { headers: { 'x-request-id': 'trace-abc' } }),
    );
    expect(res.headers.get('x-request-id')).toBe('trace-abc');
  });

  it('answers OPTIONS preflight with 204 + CORS headers, no auth or rate limiting', () => {
    const { middleware, check } = load({ apiKeys: ['k1'] });
    const res = middleware(req('/api/sessions', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://console.example.com',
    );
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(check).not.toHaveBeenCalled();
  });

  it('stamps the runtime CORS origin on passed-through API responses', () => {
    const { middleware } = load();
    const res = middleware(req('/api/health'));
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://console.example.com',
    );
  });
});

describe('middleware — auth', () => {
  it('returns 401 INVALID_API_KEY when keys are set but token is missing', async () => {
    const { middleware } = load({ apiKeys: ['secret-key'] });
    const res = middleware(req('/api/sessions'));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_API_KEY' });
  });

  it('returns 401 for a wrong token', async () => {
    const { middleware } = load({ apiKeys: ['secret-key'] });
    const res = middleware(
      req('/api/sessions', { headers: { authorization: 'Bearer nope' } }),
    );
    expect(res.status).toBe(401);
  });

  it('admits a valid Bearer token', () => {
    const { middleware } = load({ apiKeys: ['secret-key'] });
    const res = middleware(
      req('/api/sessions', {
        headers: { authorization: 'Bearer secret-key' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('returns 503 SERVER_MISCONFIGURED for a protected route in prod with no keys', async () => {
    const { middleware } = load({ apiKeys: [], isProduction: true });
    const res = middleware(req('/api/sessions'));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: 'SERVER_MISCONFIGURED',
    });
  });

  it('falls through (dev) for a protected route with no keys configured', () => {
    const { middleware } = load({ apiKeys: [], isProduction: false });
    const res = middleware(req('/api/sessions'));
    expect(res.status).toBe(200);
  });

  it('treats GET /api/registry/agents/{aid} as public discovery', () => {
    const { middleware } = load({ apiKeys: ['k'] });
    const res = middleware(req('/api/registry/agents/aid:pubkey:z:abc'));
    expect(res.status).toBe(200);
  });
});

describe('middleware — rate limiting', () => {
  it('returns 429 with Retry-After and X-RateLimit headers when denied', async () => {
    const resetAt = Date.now() + 30_000;
    const { middleware } = load(
      { apiKeys: [] },
      { allowed: false, remaining: 0, resetAt, limit: 60 },
    );
    const res = middleware(req('/api/sessions'));
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('does not rate-limit exempt probe paths', () => {
    const { middleware, check } = load();
    middleware(req('/api/readyz'));
    expect(check).not.toHaveBeenCalled();
  });

  it('skips rate limiting entirely when disabled', () => {
    const { middleware, check } = load({ rateLimitEnabled: false });
    middleware(req('/api/health'));
    expect(check).not.toHaveBeenCalled();
  });

  it('uses the strict enroll-ip bucket for /api/registry/enroll', () => {
    const { middleware, check } = load();
    middleware(req('/api/registry/enroll', { method: 'POST' }));
    expect(check).toHaveBeenCalledWith('enroll-ip', expect.any(String), 5, 60_000);
  });

  it('buckets authenticated traffic by api-key prefix', () => {
    const { middleware, check } = load({ apiKeys: ['secret-key-value'] });
    middleware(
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

describe('middleware — client IP resolution', () => {
  it('trusts a configured platform header over XFF', () => {
    const { middleware, check } = load({ clientIpHeader: 'cf-connecting-ip' });
    middleware(
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
    const { middleware, check } = load({ trustedProxyHops: 1 });
    middleware(
      req('/api/registry/enroll', {
        method: 'POST',
        // client, edge → with 1 trusted hop the real client is 1 from the end.
        headers: { 'x-forwarded-for': 'evil-spoof, 198.51.100.9' },
      }),
    );
    expect(check).toHaveBeenCalledWith('enroll-ip', '198.51.100.9', 5, 60_000);
  });

  it('does not trust XFF at all with 0 hops, falling back to x-real-ip', () => {
    const { middleware, check } = load({ trustedProxyHops: 0 });
    middleware(
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
    const { middleware, check } = load();
    middleware(req('/api/registry/enroll', { method: 'POST' }));
    expect(check).toHaveBeenCalledWith('enroll-ip', 'unknown', 5, 60_000);
  });
});
