/**
 * Process-local counter for enrollment verification failures, labelled by
 * code, surfaced at `GET /api/metrics`.
 *
 * Extends the two counter patterns already in this service —
 * `getAdminAuditInsertFailures()` (unlabelled) and
 * `rateLimiter.getDropTotals()` (labelled) — rather than introducing a metrics
 * library. No DB write, no new dependency, no new shared state.
 *
 * WHY THE LABEL IS ALLOWLISTED HERE WHILE THE WIRE VALUE IS NOT.
 * This is the one place in the feature where the rule inverts, and conflating
 * the two is the trap:
 *
 *   - On the wire (`verifyCode` in the response body), an unknown code MUST
 *     pass through verbatim, or this service breaks on the next SDK release.
 *     The SDK owns that vocabulary. See `verify-error.ts`, which deliberately
 *     names no code at all.
 *   - In a Prometheus label, an unknown code must NOT pass through. Label
 *     values are a time-series dimension, and the code derives from
 *     caller-supplied input. `metrics/route.ts` escapes quotes but bounds no
 *     cardinality, so an attacker who could induce novel codes — or one SDK
 *     release that started embedding variable detail in `.code` — would turn
 *     `/api/metrics` into an unbounded time-series bomb that takes the scrape
 *     target and the TSDB with it. Cardinality is ours to bound, so we bound
 *     it.
 *
 * The allowlist therefore lives HERE, next to the metric that needs it, and
 * never in `verify-error.ts` — whose permanent, greppable invariant is that it
 * names no SDK code. Two opposite rules, two files, so the separation is
 * verifiable by grep rather than asserted in a comment.
 *
 * Going stale is safe by design: a code this list has not heard of is counted
 * as `other` rather than dropped or passed through, so the total stays right
 * and only the breakdown loses detail — and `other` becoming non-zero is
 * itself the signal that the SDK's set has moved.
 */

/**
 * The eight codes `aitp`'s `verifyManifestJson` documents. A snapshot, used
 * ONLY to bound label cardinality — never to decide what reaches a caller.
 */
const KNOWN_VERIFY_CODES: readonly string[] = [
  'signature_invalid',
  'pop_failed',
  'aid_mismatch',
  'expired',
  'version_unknown',
  'identity_hint_malformed',
  'incompatible_identity_type',
  'malformed',
];

/** Any code outside the allowlist. Keeps cardinality bounded at 10. */
const OTHER_LABEL = 'other';

/**
 * A failure the SDK did not classify — one of this service's own rejections
 * (the aid guard, the 5-minute registration guard). Worth counting rather
 * than ignoring: it is how those guards show up on a dashboard at all.
 */
const NONE_LABEL = 'none';

export const ENROLL_FAILURE_LABELS: readonly string[] = [
  ...KNOWN_VERIFY_CODES,
  OTHER_LABEL,
  NONE_LABEL,
];

const known = new Set(KNOWN_VERIFY_CODES);

// Pre-seeded with every label at 0 so each series EXISTS from process start.
// A `for...of Object.entries` emitter skips an empty map, and a missing series
// reads as "no data" rather than "zero" — which silently breaks an alert rule
// that expects the series to be there.
const totals: Record<string, number> = Object.fromEntries(
  ENROLL_FAILURE_LABELS.map((label) => [label, 0]),
);

/**
 * Count one failed enrollment. `verifyCode` is `sdkVerifyCode`'s output: a
 * string when the SDK rejected the manifest, `undefined` when we did.
 */
export function recordEnrollFailure(verifyCode: string | undefined): void {
  const label =
    verifyCode === undefined
      ? NONE_LABEL
      : known.has(verifyCode)
        ? verifyCode
        : OTHER_LABEL;
  // Every branch yields an allowlisted, pre-seeded key, so the `?? 0` is
  // unreachable today — it is here because without it a missing key would
  // silently produce `NaN` (`undefined + 1`), and a `NaN` sample value is an
  // unparseable scrape line rather than a wrong number. Cheap insurance
  // against a future edit that adds a label but forgets the seed.
  totals[label] = (totals[label] ?? 0) + 1;
}

/**
 * Snapshot of the counters, for the metrics endpoint. A copy, so a scrape
 * cannot mutate the counters it is reading.
 *
 * Per-process and reset-on-restart, like both patterns it copies. That is
 * correct for a Prometheus `counter` (the scraper handles resets) and means
 * multi-instance aggregation is the scraper's job — no shared state, so no
 * coordination and no new failure mode.
 */
export function getEnrollFailureTotals(): Record<string, number> {
  return { ...totals };
}

/** Test-only: restore the pristine, all-zero state. */
export function resetEnrollFailureTotals(): void {
  for (const label of ENROLL_FAILURE_LABELS) totals[label] = 0;
}
