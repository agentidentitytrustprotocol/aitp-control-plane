/**
 * Process-local counters for `POST /api/events`, surfaced at `GET /api/metrics`.
 *
 * Same pattern as `getAdminAuditInsertFailures()` and `enroll-metrics.ts`: a
 * module-level number, no DB write, no metrics library. Per replica, reset on
 * restart (docs/operations.md#metrics).
 */

let eventsDroppedTotal = 0;

/**
 * Count items that `POST /api/events` dropped by per-item validation (over a
 * column limit, a NUL character, a lone UTF-16 surrogate in the payload or
 * grants, a payload nested too deep). Called only when
 * the handler actually runs, so an Idempotency-Key replay is not re-counted.
 */
export function recordEventsDropped(n: number): void {
  if (Number.isFinite(n) && n > 0) eventsDroppedTotal += n;
}

export function getEventsDroppedTotal(): number {
  return eventsDroppedTotal;
}
