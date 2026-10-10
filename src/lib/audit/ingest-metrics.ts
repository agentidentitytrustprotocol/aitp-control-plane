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

let eventsDuplicateTotal = 0;

/**
 * Count items that `POST /api/events` accepted but did not store because an
 * event with the same content-derived id already existed (a re-send) or
 * appeared earlier in the same batch. Not re-counted on an Idempotency-Key
 * replay (the handler does not run).
 */
export function recordEventsDuplicate(n: number): void {
  if (Number.isFinite(n) && n > 0) eventsDuplicateTotal += n;
}

export function getEventsDuplicateTotal(): number {
  return eventsDuplicateTotal;
}
