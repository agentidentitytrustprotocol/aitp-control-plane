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

/**
 * Headers the request gate (src/proxy.ts) sets on the request it forwards to a
 * route handler. The gate DELETES any client-supplied copy first, so a handler
 * can trust them: they are never caller-controlled.
 *
 * - KEY_LABEL_HEADER: the non-secret label of the API key that authenticated
 *   the request (src/lib/api-keys.ts). Absent on public routes and in dev with
 *   no API_KEYS.
 * - CLIENT_IP_FORWARD_HEADER: the client IP as the gate resolved it for rate
 *   limiting. Only as trustworthy as CLIENT_IP_HEADER / TRUSTED_PROXY_HOPS
 *   make it (see src/lib/config.ts); `unknown` is not forwarded.
 */
export const KEY_LABEL_HEADER = 'x-aitp-key-label';
export const CLIENT_IP_FORWARD_HEADER = 'x-aitp-client-ip';

/** Admin-audit actor for a request authenticated with the key labelled `label`. */
export function actorIdForKeyLabel(label: string): string {
  return `key:${label}`;
}

export interface AuditContext {
  actorId?: string;
  requestId?: string;
  clientIp?: string;
}

/**
 * The attribution fields for a `writeAdminAudit` call, read from the headers
 * the gate forwarded. `fallbackActor` names the credential for routes that are
 * not API-key gated (e.g. `enrollment-token` on agent self-registration).
 */
export function auditContext(
  req: { headers: { get(name: string): string | null } },
  fallbackActor?: string,
): AuditContext {
  const ctx: AuditContext = {};
  const label = req.headers.get(KEY_LABEL_HEADER);
  if (label) ctx.actorId = actorIdForKeyLabel(label);
  else if (fallbackActor) ctx.actorId = fallbackActor;
  const requestId = req.headers.get('x-request-id');
  if (requestId) ctx.requestId = requestId;
  const ip = req.headers.get(CLIENT_IP_FORWARD_HEADER);
  if (ip) ctx.clientIp = ip;
  return ctx;
}
