function readNumber(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function readList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  isProduction: process.env.NODE_ENV === 'production',
  port: readNumber('PORT', 4000),
  cpBaseUrl: process.env.CP_BASE_URL ?? 'http://localhost:4000',
  cpAidSeedHex: process.env.CP_AID_SEED_HEX ?? '',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/aitp_control_plane',
  dbPoolMax: readNumber('DB_POOL_MAX', 20),
  apiKeys: readList('API_KEYS'),
  enrollmentSecret: process.env.ENROLLMENT_SECRET ?? '',
  maxAuditEventsInMemory: readNumber('MAX_AUDIT_EVENTS_MEMORY', 500),
  // Per-process cap on concurrent /api/events/stream connections.
  // Each open SSE holds an in-process subscription on the event bus,
  // so unbounded growth would leak memory under a misbehaving client.
  // The default is generous; raise it if you front this with a fan-out
  // proxy that opens its own pool of upstream streams.
  maxSseConnections: readNumber('MAX_SSE_CONNECTIONS', 500),
  revocationListTtlSecs: readNumber('REVOCATION_LIST_TTL_SECS', 3600),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  webhookRetryAttempts: readNumber('WEBHOOK_RETRY_ATTEMPTS', 3),
  // Optional allowlist of webhook target hosts. Empty = allow any public
  // host (still SSRF-range-checked). Entries are exact hosts; a leading
  // dot (".example.com") matches the apex and any subdomain.
  webhookUrlAllowlist: readList('WEBHOOK_URL_ALLOWLIST'),
  // Rate limits (requests per minute). All buckets are in-memory and
  // per-process; for multi-instance deployments add a Redis hub later.
  // 0 disables that bucket.
  rateLimitEnrollPerIpMin: readNumber('RATE_LIMIT_ENROLLMENT_PER_IP_MIN', 5),
  rateLimitPublicPerIpMin: readNumber('RATE_LIMIT_PUBLIC_PER_IP_MIN', 60),
  rateLimitApiKeyMin: readNumber('RATE_LIMIT_API_KEY_PER_MIN', 600),
  rateLimitWindowMs: readNumber('RATE_LIMIT_WINDOW_MS', 60_000),
  // Client-IP resolution for rate limiting. `X-Forwarded-For` is
  // client-controllable: the leftmost entry is whatever the caller sent,
  // so trusting it lets an attacker rotate it to dodge the per-IP
  // enrollment throttle (or spoof a victim's IP to exhaust their bucket).
  //   CLIENT_IP_HEADER — a single trusted header your edge sets to the
  //     real client IP (e.g. "cf-connecting-ip", "x-vercel-forwarded-for",
  //     "x-real-ip"). When set, it wins.
  //   TRUSTED_PROXY_HOPS — number of trusted proxies appending to XFF.
  //     The client IP is read that many entries from the RIGHT (the
  //     proxy-appended end), not the spoofable left. Default 0 = do not
  //     trust XFF at all.
  clientIpHeader: (process.env.CLIENT_IP_HEADER ?? '').trim().toLowerCase(),
  trustedProxyHops: readNumber('TRUSTED_PROXY_HOPS', 0),
  rateLimitEnabled:
    (process.env.RATE_LIMIT_ENABLED ?? 'true').toLowerCase() !== 'false',
  // ── Data retention ───────────────────────────────────────────────────
  // Periodic sweep deletes old rows so storage stays bounded. The sweep
  // uses a Postgres advisory lock so multiple CP instances do not
  // duplicate work. Set RETENTION_ENABLED=false to disable entirely.
  retentionEnabled:
    (process.env.RETENTION_ENABLED ?? 'true').toLowerCase() !== 'false',
  retentionIntervalMs: readNumber('RETENTION_INTERVAL_MS', 30 * 60 * 1000),
  auditEventsTtlDays: readNumber('AUDIT_EVENTS_TTL_DAYS', 90),
  webhookDeliveryTtlDays: readNumber('WEBHOOK_DELIVERY_TTL_DAYS', 14),
  expiredAgentGraceDays: readNumber('EXPIRED_AGENT_GRACE_DAYS', 30),
  adminAuditTtlDays: readNumber('ADMIN_AUDIT_TTL_DAYS', 365),
  idempotencyKeyTtlDays: readNumber('IDEMPOTENCY_KEY_TTL_DAYS', 7),
  // Per-sweep batch size — caps how many rows a single sweep deletes so
  // a long-running deploy doesn't lock tables for minutes.
  retentionBatchLimit: readNumber('RETENTION_BATCH_LIMIT', 10_000),
} as const;

export type Config = typeof config;

// Surface configuration that's "permissive in dev, dangerous in prod"
// at boot, once per process. We log via stderr directly rather than the
// pino logger to avoid a circular import (logger.ts has no deps on
// this module today, and we want to keep it that way).
if (!config.isProduction && config.apiKeys.length === 0 && !process.env.JEST_WORKER_ID) {
  // eslint-disable-next-line no-console
  console.warn(
    '[aitp-cp] API_KEYS is empty; admin routes are unauthenticated in this NODE_ENV. ' +
      'Set API_KEYS before exposing this instance to anything beyond localhost.',
  );
}
