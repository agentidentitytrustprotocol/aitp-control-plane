/**
 * Process-local counters for the `/api/events/stream` SSE lifecycle, surfaced
 * at `GET /api/metrics`.
 *
 * WHY THIS EXISTS (issue #89). The outage this was written for — the route
 * never flushing response headers — was invisible from outside the process for
 * days. `/api/metrics` is public (`src/proxy.ts` `PUBLIC_PATHS`) and
 * rate-limit exempt, so these three series are the only thing that answers
 * "is the handler being reached at all, and are streams staying alive?"
 * without log access to the deployment. That capability is the phase's whole
 * point; the counters themselves are trivial.
 *
 * WHY THE STATE LIVES ON `globalThis` AND NOT IN A MODULE-SCOPED OBJECT.
 * `enroll-metrics.ts` — the sibling counter this file otherwise copies — keeps
 * its totals in a plain module-level record. That would be wrong here for one
 * specific reason: `__sseOpenCount` was ALREADY on `globalThis`, deliberately,
 * so that a dev-server rebuild does not reset the connection cap and leak the
 * previous generation's still-open streams out of it. A module-level counter
 * would reset on a route re-evaluation while the gauge beside it did not, and
 * `streams_opened_total` could then read LOWER than the live `streams_open`
 * gauge — a nonsense pair that reads as a counter bug rather than as a reload.
 * Same storage, same lifetime, or the three series cannot be compared.
 *
 * WHY THE GAUGE IS DERIVED HERE AND NOT COUNTED HERE. `open` reads
 * `__sseOpenCount`, which `acquireSseSlot()` raises once per accepted
 * connection and `releaseSseSlot()` lowers from the route's single idempotent
 * `cleanup()`. There is exactly one decrement site and this module adds no
 * second one — that is what keeps the gauge consistent with the connection cap,
 * which reads the same number.
 *
 * WHY A SHARED MODULE AND NOT A BARE `globalThis` READ FROM `metrics/route.ts`.
 * The plan for this work proposed the latter, and it would in fact compile — a
 * `declare global` in any file under `src/` is in scope for the whole `tsc`
 * program, and `ts-jest` in this repo type-checks nothing at all, so neither
 * gate would object. The reasons are design reasons, not compiler reasons:
 *   - `acquireSseSlot()` bumps the gauge and `streams_opened_total` in ONE
 *     function. Two call sites in the route could drift apart behind a future
 *     early return, and then the two series would disagree with no way to tell
 *     which is right.
 *   - `/api/metrics` would otherwise depend on a `declare global` declared
 *     inside an unrelated route module it does not import — real coupling
 *     between two route handlers, invisible to every import graph, and it
 *     breaks the moment someone deletes the stream route's `declare` block.
 *   - Typed accessors beat raw `globalThis.__x ?? 0` reads at each use site:
 *     the `?? 0` fallback is stated once, here, next to the comment explaining
 *     why a zero must be emitted rather than a missing series.
 * This mirrors `src/lib/registry/enroll-metrics.ts`, which the repo added for
 * the same job two commits earlier.
 *
 * Per-process and reset-on-restart, like every other in-memory metric here.
 * That is correct for a Prometheus `counter` (the scraper handles resets) and
 * it makes multi-replica aggregation the scraper's job: no shared state, no
 * coordination, no new failure mode.
 */

declare global {
  // eslint-disable-next-line no-var
  var __sseOpenCount: number | undefined;
  // eslint-disable-next-line no-var
  var __sseOpenedTotal: number | undefined;
  // eslint-disable-next-line no-var
  var __sseRejectedTotal: number | undefined;
}

/**
 * Reserve a slot for one accepted stream and count the open.
 *
 * Deliberately ONE function rather than a separate `increment` and
 * `recordOpened`: two call sites could drift apart behind a future early
 * return, and then `streams_open` and `streams_opened_total` would disagree
 * with no way to tell which is right. Returns the new open count so the caller
 * can log it without re-reading the global.
 */
export function acquireSseSlot(): number {
  globalThis.__sseOpenCount = (globalThis.__sseOpenCount ?? 0) + 1;
  globalThis.__sseOpenedTotal = (globalThis.__sseOpenedTotal ?? 0) + 1;
  return globalThis.__sseOpenCount;
}

/**
 * Release the slot. Floored at 0: a negative gauge is a worse lie than a
 * slightly stale one, and it would also let the capacity cap over-admit.
 * Call this from ONE place only — the route's idempotent `cleanup()`.
 */
export function releaseSseSlot(): void {
  globalThis.__sseOpenCount = Math.max(0, (globalThis.__sseOpenCount ?? 0) - 1);
}

/** One connection refused by the cap with `503 SSE_CAPACITY`. */
export function recordSseRejected(): void {
  globalThis.__sseRejectedTotal = (globalThis.__sseRejectedTotal ?? 0) + 1;
}

/** Open streams right now, on this replica. Also what the capacity gate reads. */
export function getSseOpenCount(): number {
  return globalThis.__sseOpenCount ?? 0;
}

export interface SseMetricsSnapshot {
  /** Streams open right now, per process. */
  open: number;
  /** Streams accepted since process start. */
  openedTotal: number;
  /** Connections refused by the cap since process start. */
  rejectedTotal: number;
}

/**
 * Snapshot for the metrics endpoint — a copy, so a scrape cannot mutate what it
 * is reading.
 *
 * `?? 0` on every field so a scrape that lands before the stream route module
 * has ever been evaluated reports zeros instead of omitting the series. A
 * missing series reads as "no data" to an alert rule, not as "none yet", which
 * is the failure mode that made #89 invisible in the first place.
 */
export function getSseMetrics(): SseMetricsSnapshot {
  return {
    open: globalThis.__sseOpenCount ?? 0,
    openedTotal: globalThis.__sseOpenedTotal ?? 0,
    rejectedTotal: globalThis.__sseRejectedTotal ?? 0,
  };
}

/** Test-only: restore the pristine, all-zero state. */
export function resetSseMetrics(): void {
  globalThis.__sseOpenCount = 0;
  globalThis.__sseOpenedTotal = 0;
  globalThis.__sseRejectedTotal = 0;
}
