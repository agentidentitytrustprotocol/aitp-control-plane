/**
 * Process-local record of the last successful revocation pull per issuer key,
 * surfaced at `GET /api/metrics` as
 * `aitp_control_plane_revocation_last_pull_timestamp_seconds{issuer="<label>",aid="<aid>"}`.
 *
 * Why it exists: the CP only RELAYS revocations (RFC-AITP-0008 §1.5). An entry
 * takes effect when the issuing agent pulls it and publishes its own signed
 * list, so an agent that has stopped pulling enforces nothing new, silently.
 * This gauge is how an operator sees that: alert on `time() - gauge`.
 *
 * Keyed by the issuer key's LABEL, and labelled with the AID that key is bound
 * to, so a dashboard can join on the agent rather than on a key name that
 * changes at every rotation. Both come from `ISSUER_KEYS` config (`label@aid=key`),
 * so cardinality is bounded by configuration, never by callers. Admin-key pulls
 * are not recorded: they are an operator looking, not the issuer relaying.
 */

export interface IssuerPull {
  /** The AID the issuer key is bound to (`ISSUER_KEYS`). */
  aid: string;
  /** Epoch seconds of the last successful pull. */
  secs: number;
}

const lastPulls = new Map<string, IssuerPull>();

export function recordIssuerPull(label: string, aid: string, nowMs = Date.now()): void {
  lastPulls.set(label, { aid, secs: Math.floor(nowMs / 1000) });
}

/** label -> last successful pull, in insertion order. */
export function getIssuerLastPulls(): ReadonlyMap<string, IssuerPull> {
  return lastPulls;
}

/** Test-only. */
export function resetIssuerPulls(): void {
  lastPulls.clear();
}
