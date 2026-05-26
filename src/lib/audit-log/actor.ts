import { createHash } from 'node:crypto';

/**
 * Derive a stable, non-reversible identifier for an admin actor from the
 * incoming Authorization header. Storing the raw API key prefix would
 * leak material an attacker could use to fingerprint or brute-force the
 * key; storing a hash gives operators traceability ("the same key
 * touched both rows") without exposing the secret.
 *
 * Returns `null` if no bearer token is present.
 */
export function actorIdFromAuthHeader(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;
  if (!token) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  return `apikey:${hash.slice(0, 16)}`;
}
