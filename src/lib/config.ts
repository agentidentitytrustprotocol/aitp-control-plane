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

/**
 * Lower bound on the SSE heartbeat, in ms. This clamp is not cosmetic.
 *
 * `readNumber` above returns the default only for a MISSING or non-numeric
 * value: it tests `if (!v)` on the raw *string*, and `"0"` is a truthy string.
 * So `SSE_HEARTBEAT_MS=0` yields a finite `0`, and `=-5` yields `-5`, and both
 * pass straight through. Node clamps a `setInterval` delay of `<= 0` up to
 * 1 ms, so either typo would make every open stream emit a heartbeat frame
 * roughly every millisecond — a CPU spin and a bandwidth flood on every
 * connected client, from one character in an env var. This floor is what stands
 * between that misconfiguration and a self-inflicted outage; the ceiling below
 * covers the other end, where the same 1 ms spin is reached by overflow.
 *
 * 1000 ms is chosen as "the fastest any deployment could plausibly need": it is
 * 30-60x inside the common 30-60 s edge idle timeouts the heartbeat exists to
 * stay under, and costs at worst one wakeup per second per stream.
 */
const SSE_HEARTBEAT_FLOOR_MS = 1_000;

/**
 * Upper bound on the SSE heartbeat, in ms — and, like the floor, a correctness
 * clamp rather than a policy one.
 *
 * `setInterval` stores its delay in a signed 32-bit int, so a delay above
 * 2 147 483 647 overflows: Node emits `TimeoutOverflowWarning` and **resets the
 * delay to 1 ms**. The failure is therefore inverted and much worse than the
 * typo suggests — `SSE_HEARTBEAT_MS=15000000000` (an extra-zeros slip, "15
 * billion ms, basically never") would fire a heartbeat frame on every open
 * stream roughly every millisecond. Measured against this module before the
 * ceiling existed: ~80 ticks per 100 ms of wall clock, at both 2^31 and 1e21.
 *
 * So the ceiling is exactly Node's `TIMEOUT_MAX` (2^31 - 1, ~24.8 days): high
 * enough that it cannot override any interval a real deployment would choose —
 * everything the `SSE_HEARTBEAT_WARN_ABOVE_MS` warning is about stays untouched
 * and unclamped — and low enough that the overflow region is unreachable.
 *
 * It also keeps the `retry:` hint well-formed on the wire: `String(1e21)` is
 * `"1e+21"`, and the SSE spec requires a client to ignore a `retry` value that
 * is not all ASCII digits, so an overflowing number would silently drop the
 * reconnect hint too. Every value at or below this ceiling stringifies as digits.
 */
const SSE_HEARTBEAT_CEILING_MS = 2_147_483_647;

/**
 * Above this, warn at boot. Deliberately NOT clamped: a deployment behind an
 * edge with a long (or no) idle timeout may legitimately want a slow heartbeat,
 * and silently overriding an operator's explicit number is worse than saying so.
 * (The ceiling above is a different thing: not "too slow to be sensible" but
 * "so large that setInterval inverts it into 1 ms".)
 */
const SSE_HEARTBEAT_WARN_ABOVE_MS = 60_000;

/**
 * Clamp rather than fall back to the default. An operator who wrote `0` or `-5`
 * meant "as fast as possible", and the floor preserves that intent at a bounded
 * cost; substituting 15 000 for an explicit number is the more surprising
 * behaviour and would hide the typo instead of bounding it. A non-numeric value
 * is a different case — there is no intent to preserve — and `readNumber`
 * already returns the default for it (and for `Infinity`, which is not finite).
 * `Math.floor` because a fractional interval is meaningless to `setInterval`.
 *
 * Clamped at BOTH ends: `setInterval` misbehaves below 1 ms and above 2^31-1,
 * and in both directions the misbehaviour is the same 1 ms spin. See the two
 * bound constants above.
 */
function readHeartbeatMs(): number {
  return Math.min(
    SSE_HEARTBEAT_CEILING_MS,
    Math.max(
      SSE_HEARTBEAT_FLOOR_MS,
      Math.floor(readNumber('SSE_HEARTBEAT_MS', 15_000)),
    ),
  );
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
  // Interval between `: heartbeat` comment frames on an open SSE stream, and
  // the `retry:` reconnect hint the route advertises in its prelude.
  //
  // 15 s is kept as the default: it sits safely inside the common 30-60 s proxy
  // idle timeouts, and since the route now writes a prelude at connect the
  // heartbeat is no longer load-bearing for getting response headers onto the
  // wire (issue #89) — it only keeps an idle connection alive. Making it
  // configurable is the point: if an edge turns out to idle-close at 10 s that
  // becomes an env var, not a deploy. Clamped — see readHeartbeatMs above.
  sseHeartbeatMs: readHeartbeatMs(),
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

// A heartbeat slower than the edge's idle timeout silently reintroduces dropped
// streams — the connection is closed under you between beats, and the symptom is
// a console that reconnects on a fixed cadence with nothing wrong in the logs.
if (
  config.sseHeartbeatMs > SSE_HEARTBEAT_WARN_ABOVE_MS &&
  !process.env.JEST_WORKER_ID
) {
  // Trimmed and truncated because it is echoed into a log line. Operator-set at
  // boot rather than request data, so this is hygiene, not a boundary — but
  // `Number` ignores surrounding whitespace, so without the trim a value of
  // "70000\n" would put a raw newline in the middle of the warning. The marker
  // keeps a truncated value from reading as a complete one.
  // `String(...)` rather than `?? ''`: if this warning is firing then the
  // variable is set and numeric, because the 15 000 default is below the
  // threshold — so a nullish branch here is unreachable and would sit
  // permanently uncovered.
  const rawEnv = String(process.env.SSE_HEARTBEAT_MS).trim();
  const raw = rawEnv.length > 40 ? `${rawEnv.slice(0, 40)}…(truncated)` : rawEnv;
  // Reported separately from the effective value, because a clamp from above is
  // the one case where the number an operator wrote and the number the server
  // runs on differ by orders of magnitude — and the unclamped behaviour would
  // have been the opposite symptom (a 1ms flood, not a slow beat). The test is
  // on `rawEnv`, never on the display string: `Number('1e21…(truncated)')` is
  // NaN, which would silently drop this clause for a very long value.
  const clampNote =
    Number(rawEnv) > SSE_HEARTBEAT_CEILING_MS
      ? `SSE_HEARTBEAT_MS=${raw} is above setInterval's 2^31-1 ms limit and was clamped to ` +
        `${SSE_HEARTBEAT_CEILING_MS}ms (left alone, Node resets such a delay to 1ms and every ` +
        'open stream would be flooded with heartbeat frames). '
      : '';
  // Named once: the clamp clause above already quotes what the operator set.
  const setBy = clampNote ? '' : ` (SSE_HEARTBEAT_MS=${raw})`;
  // eslint-disable-next-line no-console
  console.warn(
    `[aitp-cp] ${clampNote}effective SSE heartbeat is ${config.sseHeartbeatMs}ms` +
      `${setBy}, above ${SSE_HEARTBEAT_WARN_ABOVE_MS}ms. ` +
      'The heartbeat exists to keep an idle SSE connection inside the edge\'s idle timeout, ' +
      'and common ones are 30-60s — at this interval idle streams will be dropped between beats.',
  );
}
