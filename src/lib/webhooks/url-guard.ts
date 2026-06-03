import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../config';

/**
 * SSRF guard for outbound webhook delivery targets.
 *
 * Webhooks are operator-supplied URLs the CP POSTs to on every matching
 * audit event. Without validation an operator (or any API-key holder)
 * can point a webhook at `http://169.254.169.254/...` (cloud metadata),
 * `http://localhost:5432`, or any RFC-1918 host and turn the CP into an
 * SSRF proxy into the internal network. We validate twice:
 *
 *   1. At create / update — reject obviously-unsafe URLs early.
 *   2. At delivery — re-resolve DNS right before the fetch, because a
 *      hostname that resolved to a public IP at create time can later
 *      resolve to a private one (DNS rebinding).
 *
 * Residual window: between the delivery-time resolution here and the
 * actual TCP connect inside `fetch`, a rebinding attacker could still
 * flip the record. Node's global `fetch` (undici) offers no public hook
 * to pin the resolved address, so closing that last window would require
 * adding the `undici` package and a custom dispatcher — tracked as a
 * follow-up. Re-resolution here defeats the static-private and
 * resolve-to-private cases, which are the realistic SSRF vectors.
 */

export class UnsafeWebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeWebhookUrlError';
  }
}

/** True if `ip` (a v4 or v6 literal) is loopback, link-local, private,
 * unique-local, or otherwise not a routable public address. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  // Not a parseable IP — treat as unsafe; the caller resolves names first.
  return true;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]!; // strip zone id
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4.
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // fc00::/7 ULA
  if (addr.startsWith('ff')) return true; // multicast
  return false;
}

/**
 * Validate a webhook target URL. Throws `UnsafeWebhookUrlError` if the
 * URL is malformed, uses a disallowed scheme, or resolves to a
 * non-public address. Async because it performs DNS resolution.
 */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeWebhookUrlError('url is not a valid absolute URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeWebhookUrlError('url scheme must be http or https');
  }
  if (config.isProduction && url.protocol !== 'https:') {
    throw new UnsafeWebhookUrlError('url must use https in production');
  }

  // Optional operator allowlist. When set, the host MUST match (exact or
  // suffix on a leading-dot entry) — and we still range-check resolved IPs.
  const allow = config.webhookUrlAllowlist;
  if (allow.length > 0) {
    const host = url.hostname.toLowerCase();
    const ok = allow.some((entry) =>
      entry.startsWith('.') ? host.endsWith(entry) || host === entry.slice(1) : host === entry,
    );
    if (!ok) {
      throw new UnsafeWebhookUrlError('url host is not in WEBHOOK_URL_ALLOWLIST');
    }
  }

  const host = url.hostname;
  // IP literal — check directly, no resolution.
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new UnsafeWebhookUrlError('url host resolves to a non-public address');
    }
    return;
  }

  // Hostname — resolve all A/AAAA records and reject if ANY is private.
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UnsafeWebhookUrlError(`url host ${host} could not be resolved`);
  }
  if (addresses.length === 0) {
    throw new UnsafeWebhookUrlError(`url host ${host} resolved to no addresses`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new UnsafeWebhookUrlError('url host resolves to a non-public address');
    }
  }
}
