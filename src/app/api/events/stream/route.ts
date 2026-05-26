import { NextRequest } from 'next/server';
import { eventBus, type AuditEventRecord } from '@/lib/audit/stream';
import { config } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per-process count of open SSE streams. Survives hot-reload via a
// global slot so the count doesn't reset to zero on a dev rebuild and
// leak the previous generation's still-open connections out of the cap.
declare global {
  // eslint-disable-next-line no-var
  var __sseOpenCount: number | undefined;
}
function incrementSseCount(): number {
  globalThis.__sseOpenCount = (globalThis.__sseOpenCount ?? 0) + 1;
  return globalThis.__sseOpenCount;
}
function decrementSseCount(): void {
  globalThis.__sseOpenCount = Math.max(
    0,
    (globalThis.__sseOpenCount ?? 0) - 1,
  );
}

export function GET(req: NextRequest) {
  if ((globalThis.__sseOpenCount ?? 0) >= config.maxSseConnections) {
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
  // checked req.signal.aborted.
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  // Reserve a slot for this connection; release it in cleanup so the
  // count tracks live streams 1:1.
  incrementSseCount();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    decrementSseCount();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
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
          cleanup();
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

      // Heartbeat. Proactively cleans up if the request was aborted
      // since the last tick, so we don't keep ticking against a dead
      // controller for up to 15s.
      heartbeat = setInterval(() => {
        if (req.signal.aborted) {
          cleanup();
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
          cleanup();
        }
      }, 15_000);
      heartbeat.unref?.();

      const onAbort = () => {
        cleanup();
        try {
          ctrl.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener('abort', onAbort, { once: true });
    },
    cancel() {
      cleanup();
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
