/**
 * Process-local record of the last successful revocation pull per issuer key,
 * surfaced at `GET /api/metrics` as
 * `aitp_control_plane_revocation_last_pull_timestamp_seconds{issuer="<label>"}`.
 *
 * Why it exists: the CP only RELAYS revocations (RFC-AITP-0008 §1.5). An entry
 * takes effect when the issuing agent pulls it and publishes its own signed
 * list, so an agent that has stopped pulling enforces nothing new, silently.
 * This gauge is how an operator sees that: alert on `time() - gauge`.
 *
 * Keyed by the issuer key's LABEL, which comes from `ISSUER_KEYS` config, so
 * cardinality is bounded by configuration, never by callers. Admin-key pulls
 * are not recorded: they are an operator looking, not the issuer relaying.
 */

const lastPullSecs = new Map<string, number>();

export function recordIssuerPull(label: string, nowMs = Date.now()): void {
  lastPullSecs.set(label, Math.floor(nowMs / 1000));
}

/** label -> epoch seconds of the last successful pull, in insertion order. */
export function getIssuerLastPulls(): ReadonlyMap<string, number> {
  return lastPullSecs;
}

/** Test-only. */
export function resetIssuerPulls(): void {
  lastPullSecs.clear();
}
