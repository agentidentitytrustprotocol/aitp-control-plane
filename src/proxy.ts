import { NextRequest, NextResponse } from 'next/server';
import { config as appConfig } from './lib/config';
import { rateLimiter } from './lib/rate-limit';
import { issuerKeyIndex, labelIndex, type IssuerKeyEntry } from './lib/api-keys';
import {
  CLIENT_IP_FORWARD_HEADER,
  KEY_ISSUER_HEADER,
  KEY_KIND_HEADER,
  KEY_LABEL_HEADER,
  type KeyKind,
} from './lib/audit-log/actor';

// key -> non-secret label, built once from the boot-time config.
const KEY_LABELS = labelIndex(appConfig.apiKeyEntries);
// issuer key -> {label, aid}. Never consulted outside ISSUER_KEY_ROUTE.
const ISSUER_KEYS = issuerKeyIndex(appConfig.issuerKeyEntries);
// read-only key -> label. Consulted only after the admin lookup missed, and it
// opens nothing but GET on isReadOnlyRoute(). The parser already dropped any
// entry whose key is also an admin or issuer key.
const READ_ONLY_KEYS = labelIndex(appConfig.readOnlyKeyEntries);

// The ONLY route an issuer key (ISSUER_KEYS) opens, and only for GET. On every
// other path such a key is not in KEY_LABELS, so it is a 401 like any unknown
// key. The route itself enforces `iss` == the key's AID.
const ISSUER_KEY_ROUTE = '/api/revocations';

// Always public regardless of method. /api/registry/agents collection
// is in here so POST works with only the enrollment token (the actual
// gate is inside the route handler) — matches the original CLAUDE.md
// design where external agents self-register without a pre-provisioned
// API key.
const PUBLIC_PATHS = new Set<string>([
  '/api/health',
  '/api/readyz',
  '/api/well-known/aitp-manifest',
  '/api/registry/enroll',
  '/api/registry/agents',
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

// The ONLY routes a read-only key (READ_ONLY_API_KEYS) opens, and only for GET
// (HEAD is refused too: Next answers HEAD with the GET handler, so a HEAD on
// the stream would open a real SSE stream). An anchored allowlist, not a
// method gate: several GET routes are admin-only — the admin audit log
// (/api/audit), /api/metrics, webhook subscriber URLs and breaker state
// (/api/webhooks*), the issuer relay (/api/revocations) and the agent export
// bundle (/api/registry/agents/{aid}/export, which carries admin audit rows).
// Fail closed: a new route is unreachable with a read key until it is listed
// here, and the route-inventory test in proxy.test.ts fails until every
// (route, method) pair is classified.
const READ_ONLY_PATHS = new Set<string>([
  '/api/dashboard/agents',
  '/api/dashboard/overview',
  '/api/delegations',
  '/api/events/history',
  '/api/events/stream',
  '/api/pinned-keys',
  '/api/registry/agents',
  '/api/revocation/issuers',
  '/api/sessions',
  '/api/tcts',
  '/api/trust-anchors',
]);

const READ_ONLY_PATTERNS: RegExp[] = [
  /^\/api\/registry\/agents\/[^/]+$/,
  /^\/api\/registry\/agents\/[^/]+\/manifest$/,
  /^\/api\/sessions\/[^/]+$/,
  /^\/api\/sessions\/[^/]+\/replay$/,
  /^\/api\/sessions\/[^/]+\/export$/,
  /^\/api\/trust-anchors\/[^/]+$/,
  /^\/api\/trust-anchors\/[^/]+\/jwks$/,
];

/** Exported for unit testing; do not import from production code. Whether a
 * read-only key may GET this path. The method check lives in the gate. */
export function isReadOnlyRoute(pathname: string): boolean {
  if (READ_ONLY_PATHS.has(pathname)) return true;
  return READ_ONLY_PATTERNS.some((re) => re.test(pathname));
}

// Paths exempt from rate limiting. Probes and metrics scrape endpoints
// run on tight intervals; throttling them would mask real outages.
// /api/metrics is NOT public (it needs an API_KEYS key, so its counts never
// reach anonymous callers); the exemption applies only after auth passed.
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
 * will see, and the gate's attribution headers (key label, client IP),
 * which only the gate may set: any client-supplied copy is dropped. */
function passThrough(
  request: NextRequest,
  keyLabel: string | null = null,
  keyIssuer: string | null = null,
  keyKind: KeyKind | null = null,
): NextResponse {
  const requestId = resolveRequestId(request);
  const forwarded = new Headers(request.headers);
  forwarded.set('x-request-id', requestId);
  forwarded.delete(KEY_LABEL_HEADER);
  forwarded.delete(KEY_ISSUER_HEADER);
  forwarded.delete(KEY_KIND_HEADER);
  forwarded.delete(CLIENT_IP_FORWARD_HEADER);
  if (keyLabel) forwarded.set(KEY_LABEL_HEADER, keyLabel);
  if (keyIssuer) forwarded.set(KEY_ISSUER_HEADER, keyIssuer);
  if (keyKind) forwarded.set(KEY_KIND_HEADER, keyKind);
  const ip = getClientIp(request);
  if (ip !== 'unknown') forwarded.set(CLIENT_IP_FORWARD_HEADER, ip);
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
 *  - a public GET carrying a key the gate resolved as admin or read-only uses
 *    that key's bucket (a server-side console proxies every visitor from one
 *    egress IP, so the per-IP bucket would throttle them all together)
 *  - other public routes share a per-IP bucket — including public writes and
 *    junk or issuer keys, so a key never makes registration cheaper and an
 *    unknown key cannot dodge the per-IP limit
 *  - a read-only key uses its own per-key `read-key` bucket, so visitor reads
 *    can never drain an admin key's budget
 *  - other authenticated routes use per-API-key
 */
function chooseRateLimit(
  request: NextRequest,
  pathname: string,
  token: string | null,
  isPublic: boolean,
  publicKeyKind: KeyKind | null,
  keyKind: KeyKind | null,
): RateLimitChoice {
  const ip = getClientIp(request);
  if (pathname === '/api/registry/enroll') {
    return {
      bucketName: 'enroll-ip',
      key: ip,
      limit: appConfig.rateLimitEnrollPerIpMin,
    };
  }
  // On a public route the effective kind is what the key WOULD be, resolved
  // only for a GET; on a gated route it is what authenticated the request.
  const kind = isPublic ? publicKeyKind : keyKind;
  if (token && kind === 'read') {
    return {
      bucketName: 'read-key',
      key: token.slice(0, 24),
      limit: appConfig.rateLimitReadKeyMin,
    };
  }
  if (!token || (isPublic && kind !== 'admin')) {
    return {
      bucketName: 'public-ip',
      key: ip,
      limit: appConfig.rateLimitPublicPerIpMin,
    };
  }
  // Per KEY, not per label: two keys sharing a label (e.g. during a rotation
  // overlap) keep separate budgets. Hash-ish prefix is enough — we just need a
  // stable per-key bucket.
  return {
    bucketName: 'api-key',
    key: token.slice(0, 24),
    limit: appConfig.rateLimitApiKeyMin,
  };
}

export function proxy(request: NextRequest) {
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
  // The label of the key that authenticated this request, forwarded to the
  // handler for the admin audit log. Public routes carry none, even if the
  // caller sent a key.
  let keyLabel: string | null = null;
  // Set only when an issuer key authenticated the request: the AID the route
  // must restrict the answer to.
  let issuerKey: IssuerKeyEntry | undefined;
  // Which list authenticated the request (forwarded as KEY_KIND_HEADER). Null
  // on public routes and in dev with no API_KEYS.
  let keyKind: KeyKind | null = null;
  if (pathname === ISSUER_KEY_ROUTE && method === 'GET' && token) {
    issuerKey = ISSUER_KEYS.get(token);
    if (issuerKey) {
      keyLabel = issuerKey.label;
      keyKind = 'issuer';
    }
  }
  if (!isPublic && !issuerKey) {
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
      const label = token ? KEY_LABELS.get(token) : undefined;
      const readLabel =
        !label && token ? READ_ONLY_KEYS.get(token) : undefined;
      if (label) {
        keyLabel = label;
        keyKind = 'admin';
      } else if (readLabel) {
        // A known read-only key: 403, not 401, outside its allowlist — that
        // says only "this key is read-only", nothing about the route.
        if (method !== 'GET' || !isReadOnlyRoute(pathname)) {
          return deny(
            request,
            { error: 'Forbidden: read-only key', code: 'READ_ONLY_KEY' },
            403,
          );
        }
        keyLabel = readLabel;
        keyKind = 'read';
      } else {
        return deny(
          request,
          { error: 'Unauthorized', code: 'INVALID_API_KEY' },
          401,
        );
      }
    }
  }

  // On a public GET, resolve the key only to pick its rate-limit bucket. It is
  // NOT forwarded: public routes carry no label and no kind.
  let publicKeyKind: KeyKind | null = null;
  if (isPublic && method === 'GET' && token && appConfig.apiKeys.length > 0) {
    if (KEY_LABELS.has(token)) publicKeyKind = 'admin';
    else if (READ_ONLY_KEYS.has(token)) publicKeyKind = 'read';
  }

  // ── Rate limit ─────────────────────────────────────────────────────
  if (appConfig.rateLimitEnabled && !RATE_LIMIT_EXEMPT_PATHS.has(pathname)) {
    const choice = chooseRateLimit(
      request,
      pathname,
      token,
      isPublic,
      publicKeyKind,
      keyKind,
    );
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

  return passThrough(request, keyLabel, issuerKey?.aid ?? null, keyKind);
}

export const config = {
  matcher: ['/api/:path*'],
};
