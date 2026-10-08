/**
 * Background refresher for trust-anchor JWKS caches.
 *
 * Agents in OIDC identity mode need the issuer's JWKS to verify presented
 * JWTs. Some cannot reach the issuer directly (egress-restricted), so the CP
 * caches each anchor's keyset in `trust_anchors.jwks_cache` and serves it from
 * `GET /api/trust-anchors/:id/jwks`. This job populates and refreshes that
 * cache for anchors whose cache is missing or stale.
 *
 * Started once at boot from `src/instrumentation.ts`; idempotent, and the
 * interval is `.unref()`'d so it never keeps the process alive.
 *
 * Outbound-fetch safety. The CP fetches URLs that an API-key holder supplied
 * (`issuerUrl`, `jwksUrl`) and one it reads out of a remote discovery document
 * (`jwks_uri`, attacker-controlled if the issuer is). Every fetch therefore goes
 * through {@link assertSafeJwksUrl} (scheme, and every resolved address must be
 * public — the same `isPrivateIp` rule as webhook delivery), refuses redirects
 * (a public host must not bounce us to a private one), and caps the body size.
 * Residual: DNS can still change between the check and the connect (see
 * `webhooks/url-guard.ts`). `WEBHOOK_URL_ALLOWLIST` is deliberately NOT applied
 * here; it scopes webhook targets, not identity providers.
 *
 * Multiple replicas each refresh independently; the work is idempotent and
 * bounded by the stale threshold, so duplicates are harmless.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db';
import { trustAnchors } from '../db/schema';
import { config } from '../config';
import { logger } from '../logger';
import { isPrivateIp } from '../webhooks/url-guard';

/** A JWKS or discovery document is a few KB; refuse anything absurd. */
const MAX_BODY_BYTES = 1024 * 1024;
const MIN_INTERVAL_MS = 1_000;

declare global {
  // eslint-disable-next-line no-var
  var __jwksRefreshInterval: ReturnType<typeof setInterval> | undefined;
}

let running = false;

/** Idempotent. Starts the periodic refresh and runs one pass immediately. */
export function startJwksRefresher(): void {
  if (!config.jwksRefreshEnabled) return;
  if (globalThis.__jwksRefreshInterval) return;
  const tick = () => {
    refreshStaleJwks().catch((err) =>
      logger.warn({ err }, 'jwks-refresher: pass failed'),
    );
  };
  const handle = setInterval(tick, Math.max(config.jwksRefreshIntervalMs, MIN_INTERVAL_MS));
  handle.unref?.();
  globalThis.__jwksRefreshInterval = handle;
  tick();
}

/** Refresh anchors whose JWKS is missing or older than the stale threshold.
 * Exported for tests and manual triggers. Returns the count refreshed. A pass
 * already in flight makes this a no-op (returns 0) so a slow issuer cannot
 * stack passes. */
export async function refreshStaleJwks(): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const staleThreshold = new Date(Date.now() - config.jwksStaleAfterMs).toISOString();

    let anchors: (typeof trustAnchors.$inferSelect)[];
    try {
      anchors = await db
        .select()
        .from(trustAnchors)
        .where(
          or(
            isNull(trustAnchors.jwksCachedAt),
            lt(trustAnchors.jwksCachedAt, staleThreshold),
          ),
        );
    } catch (err) {
      logger.warn({ err }, 'jwks-refresher: failed to list stale trust anchors');
      return 0;
    }

    let refreshed = 0;
    for (const anchor of anchors) {
      try {
        const jwks = await fetchJwks(anchor.issuerUrl, anchor.jwksUrl);
        await db
          .update(trustAnchors)
          .set({ jwksCache: jwks, jwksCachedAt: new Date().toISOString() })
          .where(eq(trustAnchors.id, anchor.id));
        refreshed += 1;
      } catch (err) {
        // The previous cache (if any) is left in place; it is retried next pass.
        logger.warn(
          { err, issuerUrl: anchor.issuerUrl, anchorId: anchor.id },
          'jwks-refresher: refresh failed for trust anchor',
        );
      }
    }
    return refreshed;
  } finally {
    running = false;
  }
}

export class UnsafeJwksUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeJwksUrlError';
  }
}

/** Reject a URL the CP must not fetch: bad scheme (https only in production),
 * or any resolved address that is not public. Exported for tests. */
export async function assertSafeJwksUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeJwksUrlError('not a valid absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeJwksUrlError('scheme must be http or https');
  }
  if (config.isProduction && url.protocol !== 'https:') {
    throw new UnsafeJwksUrlError('https is required in production');
  }
  // URL.hostname keeps the brackets on an IPv6 literal.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new UnsafeJwksUrlError('host is a non-public address');
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UnsafeJwksUrlError(`host ${host} could not be resolved`);
  }
  if (addresses.length === 0) {
    throw new UnsafeJwksUrlError(`host ${host} resolved to no addresses`);
  }
  if (addresses.some(({ address }) => isPrivateIp(address))) {
    throw new UnsafeJwksUrlError('host resolves to a non-public address');
  }
  return url;
}

async function fetchJson(rawUrl: string): Promise<unknown> {
  const url = await assertSafeJwksUrl(rawUrl);
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(config.jwksFetchTimeoutMs),
  });
  if (!res.ok) throw new Error(`fetch returned ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('response too large');
  return JSON.parse(text) as unknown;
}

/** Resolve and fetch a JWKS, doing OIDC discovery when the anchor has no
 * explicit `jwks_url`. */
async function fetchJwks(
  issuerUrl: string,
  jwksUrl: string | null,
): Promise<Record<string, unknown>> {
  const uri = jwksUrl ?? (await discoverJwksUri(issuerUrl));
  const jwks = await fetchJson(uri);
  if (
    typeof jwks !== 'object' ||
    jwks === null ||
    !Array.isArray((jwks as { keys?: unknown }).keys)
  ) {
    throw new Error('JWKS response missing "keys" array');
  }
  return jwks as Record<string, unknown>;
}

async function discoverJwksUri(issuerUrl: string): Promise<string> {
  const meta = (await fetchJson(
    `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`,
  )) as { jwks_uri?: unknown } | null;
  if (typeof meta?.jwks_uri !== 'string' || meta.jwks_uri.length === 0) {
    throw new Error('jwks_uri missing from OIDC discovery document');
  }
  return meta.jwks_uri;
}
