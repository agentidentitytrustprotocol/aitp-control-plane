import { checkColumnString } from '../http/validate';

/**
 * Storability check for the manifest fields `upsertAgent` writes into the
 * `agents` row (src/lib/db/schema.ts). Returns a human error message, or
 * `null` when every value would be accepted by Postgres.
 *
 * The SDK's signature verification says nothing about these limits: a signed
 * manifest with a 300-character `display_name`, or a U+0000 in it, verifies
 * fine. Without this check `/enroll` minted a token for it and
 * `POST /api/registry/agents` then consumed the token's `jti` and failed the
 * insert with a 500 — a burned token and an unclassified error for a manifest
 * that could never have been stored. So it runs in BOTH places: in
 * `/enroll` before a token is minted, and in the register route before the
 * `jti` is consumed (tokens minted before this check existed, or by a
 * replica that lacks it, still reach that route).
 *
 * Fields and the column each lands in (measured against the test DB):
 *   - `aid`                  -> `aid` varchar(512): > 512 code points 22001,
 *                               NUL 22021.
 *   - `display_name ?? aid`  -> `display_name` varchar(256): > 256 code points
 *                               22001, NUL 22021. The AID is the fallback, so
 *                               an absent `display_name` checks the AID
 *                               against 256 too.
 *   - `handshake_endpoint`   -> `handshake_endpoint` text NOT NULL: NUL 22021.
 *                               No length limit (1 MB stores).
 *   - `expires_at`           -> `manifest_expires_at` timestamptz via toISOString():
 *                               outside years 0001-9999 throws/is rejected.
 *   - `offered_capabilities` -> `offered_caps` jsonb: a `\u0000` escape is
 *                               22P05 and a lone surrogate escape 22P02
 *                               (`JSON.stringify` emits `\udXXX` for one).
 *
 * The namespace is NOT checked here: the `X-Aitp-Namespace` header wins over
 * `manifest.extensions.namespace` at registration, so `/enroll` cannot know
 * which value will be stored. The register route checks both itself.
 *
 * Takes the parsed manifest as `unknown` and checks types too, because the
 * register route's `ManifestEnvelope` type is a cast, not a validation.
 */
export function checkManifestColumns(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return 'manifest must be an object';
  }
  const m = manifest as Record<string, unknown>;

  if (typeof m.aid !== 'string') return 'manifest.aid must be a string';
  const aidProblem = checkColumnString(m.aid, { field: 'manifest.aid', max: AID_MAX });
  if (aidProblem) return aidProblem;

  // Mirrors the route's `manifest.display_name ?? manifest.aid`.
  const displayName = m.display_name ?? m.aid;
  if (typeof displayName !== 'string') {
    return 'manifest.display_name must be a string when present';
  }
  const dnProblem = checkColumnString(displayName, {
    field:
      m.display_name === undefined || m.display_name === null
        ? 'manifest.aid (used as the display name when manifest.display_name is absent)'
        : 'manifest.display_name',
    max: DISPLAY_NAME_MAX,
  });
  if (dnProblem) return dnProblem;

  if (typeof m.handshake_endpoint !== 'string') {
    return 'manifest.handshake_endpoint must be a string';
  }
  if (m.handshake_endpoint.includes('\u0000')) {
    return 'manifest.handshake_endpoint must not contain a NUL character';
  }

  // Mirrors the route's `manifest.offered_capabilities ?? []`.
  const caps = m.offered_capabilities ?? [];
  if (!Array.isArray(caps)) {
    return 'manifest.offered_capabilities must be an array of strings';
  }
  for (const cap of caps) {
    if (typeof cap !== 'string') {
      return 'manifest.offered_capabilities must be an array of strings';
    }
    if (cap.includes('\u0000')) {
      return 'manifest.offered_capabilities entries must not contain a NUL character';
    }
    if (LONE_SURROGATE_RE.test(cap)) {
      return 'manifest.offered_capabilities entries must be well-formed Unicode';
    }
  }

  // `manifestExpiresAt` is written as `new Date(expires_at * 1000).toISOString()`.
  // The SDK's Timestamp is an unbounded i64, so a signed manifest can carry a
  // value that makes toISOString() throw (RangeError, a 500 after the jti is
  // burned) or that renders outside the years Postgres timestamptz accepts
  // from an ISO string. Follows the route's truthiness test (0/absent/null are
  // stored as NULL and need no check) but is stricter for other falsy/truthy
  // non-numbers (false, "", numeric strings), which are rejected.
  if (m.expires_at !== undefined && m.expires_at !== null && m.expires_at !== 0) {
    const e = m.expires_at;
    if (
      typeof e !== 'number' ||
      !Number.isFinite(e) ||
      e < EXPIRES_AT_MIN_SECS ||
      e > EXPIRES_AT_MAX_SECS
    ) {
      return 'manifest.expires_at must be a Unix timestamp in seconds between year 0001 and 9999';
    }
  }
  return null;
}

/** 0001-01-01T00:00:00Z / 9999-12-31T23:59:59Z in Unix seconds. */
const EXPIRES_AT_MIN_SECS = -62135596800;
const EXPIRES_AT_MAX_SECS = 253402300799;

/** `agents.aid` is varchar(512). */
const AID_MAX = 512;
/** `agents.display_name` is varchar(256). */
const DISPLAY_NAME_MAX = 256;

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
