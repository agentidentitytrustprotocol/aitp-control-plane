import { NextRequest, NextResponse } from 'next/server';
import { config as appConfig } from './lib/config';
import { rateLimiter } from './lib/rate-limit';

// Always public regardless of method. /api/registry/agents collection
// is in here so POST works with only the enrollment token (the actual
// gate is inside the route handler) — matches the original CLAUDE.md
// design where external agents self-register without a pre-provisioned
// API key.
const PUBLIC_PATHS = new Set<string>([
  '/api/health',
  '/api/readyz',
  '/api/well-known/aitp-manifest',
  '/api/well-known/aitp-revocation-list',
  '/api/registry/enroll',
  '/api/registry/agents',
  '/api/metrics',
]);

// Anonymous discovery: `GET /api/registry/agents/{aid}` and
// `GET /api/registry/agents/{aid}/manifest` are the only public reads
// under the agents/ subtree. New admin-only suffixes (e.g. /export)
// MUST NOT be added to this list — they leak audit data. The pattern
// is path-shape-anchored to make accidental opening of new routes
// impossible.
const PUBLIC_GET_PATTERNS: RegExp[] = [
  /^\/api\/registry\/agents\/[^/]+$/,
  /^\/api\/registry\/agents\/[^/]+\/manifest$/,
];

/** Exported for unit testing; do not import from production code. */
export function isPublicRequest(pathname: string, method: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (method === 'GET' && PUBLIC_GET_PATTERNS.some((re) => re.test(pathname))) {
    return true;
  }
  return false;
}

// Paths exempt from rate limiting. Probes and metrics scrape endpoints
// run on tight intervals; throttling them would mask real outages.
const RATE_LIMIT_EXEMPT_PATHS = new Set<string>([
  '/api/health',
  '/api/readyz',
  '/api/metrics',
]);

// Configurable via RATE_LIMIT_WINDOW_MS; default 60s matches the per-min limits.
const WINDOW_MS = appConfig.rateLimitWindowMs;

// CORS is applied here (runtime) rather than in next.config.ts `headers()`,
// which Next bakes at build time — that would freeze CORS_ORIGIN into the
// Docker image. Reading appConfig.corsOrigin here means CORS_ORIGIN is
// honored from the runtime environment (e.g. Railway service vars).
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': appConfig.corsOrigin,
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization,content-type,x-request-id,x-aitp-namespace',
  'Access-Control-Expose-Headers': 'x-request-id',
  Vary: 'Origin',
};

function applyCors(response: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
  return response;
}

function newRequestId(): string {
  return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveRequestId(request: NextRequest): string {
  return request.headers.get('x-request-id') ?? newRequestId();
}

function getClientIp(request: NextRequest): string {
  // 1. A trusted platform header (set by the edge, not the client) wins.
  if (appConfig.clientIpHeader) {
    const v = request.headers.get(appConfig.clientIpHeader);
    if (v) return v.split(',')[0]!.trim();
  }

  // 2. X-Forwarded-For, read from the RIGHT by trusted-proxy hop count.
  //    Each trusted proxy APPENDS the address it saw, so the real client
  //    is `hops` entries from the end. The leftmost entries are
  //    client-supplied and must never be trusted. With 0 hops we don't
  //    trust XFF at all (a misconfigured edge shouldn't open a spoof).
  const hops = appConfig.trustedProxyHops;
  if (hops > 0) {
    const fwd = request.headers.get('x-forwarded-for');
    if (fwd) {
      const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
      const idx = parts.length - hops;
      if (idx >= 0 && parts[idx]) return parts[idx]!;
    }
  }

  // 3. x-real-ip (single value some proxies set) then a localhost-dev
  //    fallback. Next.js no longer exposes request.ip in middleware as of
  //    v15; raw localhost dev sends no proxy headers, so all such requests
  //    bucket together under "unknown" — fine for a single dev machine.
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

/** Pass the request through unmodified except for an x-request-id
 * header that both downstream route handlers AND the client response
 * will see. */
function passThrough(request: NextRequest): NextResponse {
  const requestId = resolveRequestId(request);
  const forwarded = new Headers(request.headers);
  forwarded.set('x-request-id', requestId);
  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set('x-request-id', requestId);
  return applyCors(response);
}

function deny(
  request: NextRequest,
  body: unknown,
  status: number,
  extraHeaders?: Record<string, string>,
): NextResponse {
  const requestId = resolveRequestId(request);
  const response = NextResponse.json(body, { status });
  response.headers.set('x-request-id', requestId);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) response.headers.set(k, v);
  }
  return applyCors(response);
}

interface RateLimitChoice {
  bucketName: string;
  key: string;
  limit: number;
}

/** Pick a rate-limit bucket for the request. Order:
 *  - enrollment endpoint gets its own strict per-IP bucket (token brute force)
 *  - other public routes share a per-IP bucket
 *  - authenticated routes use per-API-key
 */
function chooseRateLimit(
  request: NextRequest,
  pathname: string,
  token: string | null,
  isPublic: boolean,
): RateLimitChoice {
  const ip = getClientIp(request);
  if (pathname === '/api/registry/enroll') {
    return {
      bucketName: 'enroll-ip',
      key: ip,
      limit: appConfig.rateLimitEnrollPerIpMin,
    };
  }
  if (isPublic || !token) {
    return {
      bucketName: 'public-ip',
      key: ip,
      limit: appConfig.rateLimitPublicPerIpMin,
    };
  }
  // Hash-ish prefix is enough — we just need a stable per-key bucket.
  return {
    bucketName: 'api-key',
    key: token.slice(0, 24),
    limit: appConfig.rateLimitApiKeyMin,
  };
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { method } = request;

  if (!pathname.startsWith('/api/')) return NextResponse.next();
  // CORS preflight: answer directly with the CORS headers and a 204 so the
  // browser proceeds to the real request. Never reaches a route handler.
  if (method === 'OPTIONS') {
    const requestId = resolveRequestId(request);
    const response = new NextResponse(null, { status: 204 });
    response.headers.set('x-request-id', requestId);
    return applyCors(response);
  }

  const isPublic = isPublicRequest(pathname, method);

  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader || null;

  // ── Auth check ─────────────────────────────────────────────────────
  if (!isPublic) {
    const keys = appConfig.apiKeys;
    if (keys.length === 0) {
      if (appConfig.isProduction) {
        return deny(
          request,
          {
            error: 'server misconfigured: API_KEYS is required in production',
            code: 'SERVER_MISCONFIGURED',
          },
          503,
        );
      }
      // Dev: fall through to rate limit + handler with no auth.
    } else {
      if (!token || !keys.includes(token)) {
        return deny(
          request,
          { error: 'Unauthorized', code: 'INVALID_API_KEY' },
          401,
        );
      }
    }
  }

  // ── Rate limit ─────────────────────────────────────────────────────
  if (appConfig.rateLimitEnabled && !RATE_LIMIT_EXEMPT_PATHS.has(pathname)) {
    const choice = chooseRateLimit(request, pathname, token, isPublic);
    const decision = rateLimiter.check(
      choice.bucketName,
      choice.key,
      choice.limit,
      WINDOW_MS,
    );
    if (!decision.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((decision.resetAt - Date.now()) / 1000),
      );
      return deny(
        request,
        {
          error: 'rate limit exceeded',
          code: 'RATE_LIMITED',
          bucket: choice.bucketName,
        },
        429,
        {
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(decision.limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor(decision.resetAt / 1000)),
        },
      );
    }
  }

  return passThrough(request);
}

export const config = {
  matcher: ['/api/:path*'],
};
