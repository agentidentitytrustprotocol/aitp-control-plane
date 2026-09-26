import { NextRequest } from 'next/server';
import { eventBus, type AuditEventRecord } from '@/lib/audit/stream';
import {
  acquireSseSlot,
  getSseOpenCount,
  recordSseRejected,
  releaseSseSlot,
} from '@/lib/audit/sse-metrics';
import { config } from '@/lib/config';
import { childLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The per-process open-stream count, the two lifecycle counters and their
// `globalThis` slots all live in @/lib/audit/sse-metrics, so that
// /api/metrics can read them without importing another route module and so
// there is exactly one place that mutates them. See that file for why the
// state is global rather than module-scoped.

/**
 * Upper bound on values we are willing to copy from the request into a log
 * line. `x-request-id` is caller-settable and the query filters are entirely
 * caller-supplied, so an unbounded value is a log-volume amplification vector
 * on its own. Mirrors MAX_LOGGED_REQUEST_ID in the enroll route.
 */
const MAX_LOGGED_VALUE = 200;

function cap(value: string | null): string | undefined {
  return value ? value.slice(0, MAX_LOGGED_VALUE) : undefined;
}

/**
 * Logging must never be able to take the stream down with it. Observability is
 * strictly less important than the thing it observes, and the failure modes are
 * concrete: a `childLogger()` or pino transport fault thrown from the open path
 * would propagate out of `GET()` as a 500 **after** `acquireSseSlot()` has
 * already run, leaking a capacity slot for the life of the process; thrown from
 * `cleanup()` it would reject the consumer's `cancel()` promise or throw inside
 * an `abort` event listener.
 *
 * (It would not skip the unsubscribe: the close log is deliberately the LAST
 * statement of `cleanup()`, after the release, the unsubscribe and the
 * `clearInterval`. The ordering is the primary defence; this wrapper is the
 * backstop.)
 *
 * The cost of the swallow is that a permanently broken logger is silent — no
 * counter, no fallback. Accepted: the alternative is a broken logger taking out
 * the endpoint, and the three metrics in `@/lib/audit/sse-metrics` are the
 * signal that does not depend on logging working.
 */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Intentionally ignored — see above.
  }
}

/** Minimal shape this route needs from the logger. */
type LifecycleLogger = {
  info: (fields: Record<string, unknown>, msg: string) => void;
  warn: (fields: Record<string, unknown>, msg: string) => void;
};
/** Used when building the real logger throws — see `safely`. */
const NOOP_LOGGER: LifecycleLogger = { info: () => {}, warn: () => {} };

export function GET(req: NextRequest) {
  const requestId = cap(req.headers.get('x-request-id'));
  // Building the child logger is itself a call that can throw, and it happens
  // on the request path, so it gets the same treatment as the log calls.
  let log: LifecycleLogger = NOOP_LOGGER;
  safely(() => {
    log = childLogger(requestId ? { requestId } : {});
  });

  if (getSseOpenCount() >= config.maxSseConnections) {
    recordSseRejected();
    // warn, not info: at the cap the console is being actively refused, which
    // is the one SSE lifecycle event an operator should be paged-adjacent to.
    safely(() =>
      log.warn(
        {
          reason: 'capacity',
          open: getSseOpenCount(),
          cap: config.maxSseConnections,
        },
        'sse stream rejected',
      ),
    );
    return new Response(
      JSON.stringify({
        error: 'too many open SSE connections; retry after current streams drain',
        code: 'SSE_CAPACITY',
      }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '30',
        },
      },
    );
  }

  const { searchParams } = new URL(req.url);
  const filterType = searchParams.get('type');
  const filterRunId = searchParams.get('run_id') ?? searchParams.get('runId');
  const filterAid = searchParams.get('aid');

  const matches = (e: AuditEventRecord): boolean => {
    if (filterType && e.type !== filterType) return false;
    if (filterRunId && e.runId !== filterRunId) return false;
    if (filterAid && e.aidA !== filterAid && e.aidB !== filterAid) return false;
    return true;
  };

  const enc = new TextEncoder();

  // Single cleanup path — idempotent and called from every termination
  // signal (consumer cancel, request abort, heartbeat-after-abort).
  // Previously the heartbeat could keep firing for up to one tick
  // window after the connection died because nothing proactively
  // checked req.signal.aborted. Note that window is now operator-sized: it is
  // one config.sseHeartbeatMs, not a fixed 15s. It only matters for a signal
  // already aborted before GET() — every other path runs cleanup() at once.
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  // Reserve a slot for this connection; release it in cleanup so the
  // count tracks live streams 1:1. Also counts the open.
  const openCount = acquireSseSlot();
  const openedAt = Date.now();
  safely(() =>
    log.info(
      {
        open: openCount,
        cap: config.maxSseConnections,
        // Which filters the client asked for. Truncated, because these are
        // raw query values. Omitted entirely when unset, so a plain connect
        // does not carry three `null`s.
        filters: {
          type: cap(filterType),
          runId: cap(filterRunId),
          aid: cap(filterAid),
        },
      },
      'sse stream opened',
    ),
  );
  /**
   * `reason` is why the stream ended, and it is the field worth having: the
   * question after #89 is not "did a stream close" but "did it close because
   * the client went away, or because something upstream cut it".
   */
  const cleanup = (reason: 'cancel' | 'abort' | 'enqueue-failed') => {
    if (closed) return;
    closed = true;
    releaseSseSlot();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    // Inside the `closed` guard, so exactly one close line is emitted per
    // stream however many termination signals arrive. One line per lifecycle
    // event and none per heartbeat, so 500 open streams do not flood the log.
    safely(() =>
      log.info(
        { reason, durationMs: Date.now() - openedAt, open: getSseOpenCount() },
        'sse stream closed',
      ),
    );
  };

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      // MUST be the first statement, before any await: force Next's Node
      // adapter to flush the status line + headers now. It defers
      // res.flushHeaders() to the first body chunk
      // (next/dist/server/pipe-readable.js:59-74), so a stream that stays
      // silent until its first event sends NO headers at all — clients and
      // proxies with a sub-heartbeat first-byte timeout see a dead hang with
      // not even an HTTP status line (issue #89: 15s to first byte in
      // production, because a freshly started process has an empty backlog
      // and the heartbeat below is the first thing that writes).
      // A comment frame is ignored by every SSE parser, including EventSource.
      //
      // ONE enqueue, not two. `readFrames` in the tests pushes one decoded
      // string per read(), and the route's frame indices are its enqueue order,
      // so splitting the prelude would shift every replay/dedup assertion. It
      // is also one fewer write on the socket.
      //
      // `retry:` tells an EventSource how long to wait before reconnecting.
      // Browsers default to ~3 s; advertising the heartbeat interval instead
      // gives a reconnecting client a server-chosen floor, so a console stuck in
      // a reconnect loop backs off to the cadence this server actually expects
      // rather than hammering at the browser default. Note the coupling cuts
      // both ways: below ~3 s this makes clients reconnect FASTER than their
      // default, so a sub-3s heartbeat trades keepalive headroom for reconnect
      // pressure on the capacity gate (documented in docs/operations.md).
      // config.sseHeartbeatMs is clamped to 1000-2147483647 in @/lib/config, so
      // this always renders as ASCII digits — a `retry:` value that is not all
      // digits (e.g. String(1e21) === "1e+21") must be ignored by the client.
      ctrl.enqueue(
        enc.encode(`retry: ${config.sseHeartbeatMs}\n: connected\n\n`),
      );

      // Track ids already enqueued so backlog replay + the
      // subscription-arrival queue don't double-deliver any event that
      // existed in both. Without this, an event published mid-replay
      // would be missed (subscribe happened too late) OR doubled
      // (replay happened too late).
      const seenIds = new Set<string>();
      const sendEvent = (evt: AuditEventRecord) => {
        if (seenIds.has(evt.id)) return;
        seenIds.add(evt.id);
        try {
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
        } catch {
          cleanup('enqueue-failed');
        }
      };

      // Buffer subscription arrivals until the backlog has been drained,
      // then emit them in order. Subscribing BEFORE replaying closes the
      // race window where a publish between getBacklog() and subscribe()
      // would be lost.
      let draining = true;
      const subscriptionBuffer: AuditEventRecord[] = [];
      unsubscribe = eventBus.subscribe((evt) => {
        if (!matches(evt)) return;
        if (draining) {
          subscriptionBuffer.push(evt);
          return;
        }
        sendEvent(evt);
      });

      // Replay the backlog.
      for (const evt of eventBus.getBacklog(100).filter(matches)) {
        sendEvent(evt);
      }

      // Drain anything that arrived during the replay window. Dedup
      // happens inside sendEvent — events present in both backlog and
      // buffer are sent once.
      draining = false;
      for (const evt of subscriptionBuffer) sendEvent(evt);
      subscriptionBuffer.length = 0;

      // Heartbeat, at config.sseHeartbeatMs (default 15s, clamped to
      // [1s, 2^31-1ms] — see readHeartbeatMs in @/lib/config for why BOTH
      // bounds are mandatory: past 2^31-1 Node resets the delay to 1ms, so the
      // top end fails the same way as 0).
      // Proactively cleans up if the request was aborted since the last tick,
      // so we don't keep ticking against a dead controller for a whole interval.
      heartbeat = setInterval(() => {
        if (req.signal.aborted) {
          cleanup('abort');
          try {
            ctrl.close();
          } catch {
            // already closed
          }
          return;
        }
        try {
          ctrl.enqueue(enc.encode(`: heartbeat\n\n`));
        } catch {
          // Defensive, and unreachable through the public surface today: every
          // path that closes the controller runs cleanup() first, which clears
          // this interval, so a tick cannot find a closed controller. Verified
          // by attempting it — a throwing sink, tee()-and-cancel, an
          // already-aborted signal and a re-locked reader all terminate via
          // cancel()/abort instead. Kept because without it a future change that
          // closes the stream some other way would turn a throw here into an
          // unhandled timer exception, which in Node ends the process.
          //
          // The sibling catch in sendEvent() is reachable in a test, because
          // JSON.stringify(evt) is inside its try — though no current publish
          // path can produce a payload that fails to serialise, so that is a
          // synthesised trigger for a real branch, not a live failure mode.
          cleanup('enqueue-failed');
        }
      }, config.sseHeartbeatMs);
      // Preserve the unref: the open socket is what keeps the event loop alive,
      // so unref only ensures a lingering timer never blocks shutdown
      // (see src/lib/shutdown.ts).
      heartbeat.unref?.();

      const onAbort = () => {
        cleanup('abort');
        try {
          ctrl.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener('abort', onAbort, { once: true });
    },
    cancel() {
      cleanup('cancel');
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
