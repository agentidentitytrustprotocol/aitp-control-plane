import { NextRequest, NextResponse } from 'next/server';
import { config as appConfig } from './lib/config';

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

// GET-only public sub-trees. DELETE /api/registry/agents/:aid stays
// API-key-gated because it's an admin action; GETs are public discovery.
const PUBLIC_GET_PREFIXES = ['/api/registry/agents/'];

function newRequestId(): string {
  return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveRequestId(request: NextRequest): string {
  return request.headers.get('x-request-id') ?? newRequestId();
}

/** Pass the request through unmodified except for an x-request-id
 * header that both downstream route handlers AND the client response
 * will see. The `request.headers` Headers object on NextRequest is
 * read-only from the route-handler side unless we rebuild it here and
 * hand it back via NextResponse.next({ request: { headers } }) — just
 * calling request.headers.set(...) silently no-ops. */
function passThrough(request: NextRequest): NextResponse {
  const requestId = resolveRequestId(request);
  const forwarded = new Headers(request.headers);
  forwarded.set('x-request-id', requestId);
  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set('x-request-id', requestId);
  return response;
}

function deny(request: NextRequest, body: unknown, status: number): NextResponse {
  const requestId = resolveRequestId(request);
  const response = NextResponse.json(body, { status });
  response.headers.set('x-request-id', requestId);
  return response;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { method } = request;

  if (!pathname.startsWith('/api/')) return NextResponse.next();
  if (method === 'OPTIONS') return passThrough(request);
  if (PUBLIC_PATHS.has(pathname)) return passThrough(request);
  if (
    method === 'GET' &&
    PUBLIC_GET_PREFIXES.some((p) => pathname.startsWith(p))
  ) {
    return passThrough(request);
  }

  const keys = appConfig.apiKeys;
  if (keys.length === 0) {
    // In production an empty API_KEYS list would expose admin endpoints
    // (POST /api/webhooks, POST /api/revocation/entries, GET /api/audit,
    // DELETE /api/registry/agents/:aid). Refuse the request instead of
    // silently passing it through — operators see the misconfiguration
    // immediately rather than after an exfiltration incident.
    if (appConfig.isProduction) {
      return deny(
        request,
        {
          error:
            'server misconfigured: API_KEYS is required in production',
          code: 'SERVER_MISCONFIGURED',
        },
        503,
      );
    }
    return passThrough(request);
  }

  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  if (!token || !keys.includes(token)) {
    return deny(request, { error: 'Unauthorized', code: 'INVALID_API_KEY' }, 401);
  }

  return passThrough(request);
}

export const config = {
  matcher: ['/api/:path*'],
};
