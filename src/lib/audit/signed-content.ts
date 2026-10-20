/**
 * Content keys for signed artifacts (RFC-AITP-0001 §5.4.3, spec 0.3.1-draft).
 *
 * A signature string is not canonical: the same signed object can arrive as
 * different bytes (an Ed25519 JCS signature verifies tagged or untagged; a
 * compact-JWS signature segment has spare base64url bits lenient decoders
 * ignore). So replay, dedup, caching and audit correlation MUST NOT key on the
 * raw bytes of a signed object or a hash of them -- only on what the
 * signature covers.
 */

const B64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * The JWS signing input (`header.payload`) of a compact JWS, or `null` when
 * `s` is not one. Those two segments are exactly the bytes the signature
 * covers, so they cannot change without invalidating it; the third segment
 * can. Recognised conservatively: three base64url segments whose header
 * decodes to a JSON object carrying a string `alg`.
 */
export function jwsSigningInput(s: string): string | null {
  const parts = s.split('.');
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && B64URL_SEGMENT.test(p))) {
    return null;
  }
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof header !== 'object' || header === null || Array.isArray(header)) return null;
    if (typeof (header as Record<string, unknown>).alg !== 'string') return null;
  } catch {
    return null;
  }
  return `${parts[0]}.${parts[1]}`;
}

/** Envelope members whose sibling `signature` is outside the signed content. */
const JCS_SIGNED_BODIES = ['manifest', 'revocation_list'] as const;

/**
 * Whether `key` of `obj` is the detached signature of a JCS-profile envelope
 * (`{"manifest"|"revocation_list": {...}, "signature": "..."}`) and so must be
 * left out of a content key.
 */
export function isEnvelopeSignature(obj: Record<string, unknown>, key: string): boolean {
  return (
    key === 'signature' &&
    typeof obj.signature === 'string' &&
    JCS_SIGNED_BODIES.some((k) => typeof obj[k] === 'object' && obj[k] !== null)
  );
}
