import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { ingestEvents } from '@/lib/audit/event-store';
import { eventBus, type AuditEventRecord } from '@/lib/audit/stream';
import { sessionMonitor } from '@/lib/sessions/monitor';
import { tctMonitor } from '@/lib/tcts/monitor';
import { touchLastSeenBatch } from '@/lib/registry/store';
import {
  dispatchWebhooksWithList,
  listActiveWebhooks,
  startWebhookReaper,
} from '@/lib/webhooks/service';
import { startExpiryJob } from '@/lib/registry/expiry-job';
import { startRetentionJob } from '@/lib/retention';
import { logger } from '@/lib/logger';
import { withIdempotency } from '@/lib/idempotency';
import { BodyTooLargeError, readBodyTextWithLimit } from '@/lib/http/read-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeTimestamp(raw: unknown): string {
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as string[];
  }
  return undefined;
}

function normalize(raw: Record<string, unknown>): AuditEventRecord {
  const playground = (raw.playground as Record<string, unknown>) ?? {};
  const payload = (raw.payload as Record<string, unknown>) ?? {};
  return {
    id: randomUUID(),
    type: typeof raw.type === 'string' ? raw.type : 'unknown',
    ts: normalizeTimestamp(raw.ts),
    aidA: pickString(raw.aidA, (raw as { aid_a?: unknown }).aid_a, raw.initiator),
    aidB: pickString(raw.aidB, (raw as { aid_b?: unknown }).aid_b, raw.target),
    sessionId: pickString(
      raw.sessionId,
      (raw as { session_id?: unknown }).session_id,
    ),
    runId: pickString(
      raw.runId,
      (raw as { run_id?: unknown }).run_id,
      playground.run_id,
    ),
    grants: pickStringArray(raw.grants),
    payload:
      typeof raw.payload === 'object' && raw.payload !== null
        ? payload
        : (raw as Record<string, unknown>),
    source: pickString(raw.source) ?? 'playground',
  };
}

interface RequestBody {
  events?: unknown[];
}

// Caps for the batched telemetry sink. Picked to match a 50-event batch
// of typical handshake/TCT events (~1KB each) with a 5x headroom. A
// caller that legitimately needs more should split into multiple
// requests rather than asking us to lift these.
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
// Hard ceiling on events per request. Independent of the byte cap so a
// payload of many tiny objects can't flood the SSE backlog, the DB, or
// the webhook fan-out. Callers needing more must split into batches.
const MAX_BATCH_EVENTS = 500;
// Bound concurrent webhook fan-out per batch so a full batch can't spawn
// an unbounded burst of outbound deliveries.
const WEBHOOK_DISPATCH_CONCURRENCY = 8;

export async function POST(req: NextRequest) {
  // Lazy startup hooks — idempotent, .unref()'d intervals. Run BEFORE
  // the idempotency wrapper so they fire even on replayed requests
  // (the periodic jobs are also re-arm-on-call).
  startExpiryJob();
  startWebhookReaper();
  startRetentionJob();

  // Reject obviously-too-large bodies before consuming them. The
  // per-event check after parse catches the case where Content-Length
  // is unset or wrong; this check just spares us reading 50MB to learn
  // we'll reject it.
  const declaredLen = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BATCH_BYTES) {
    return Response.json(
      {
        error: `request body exceeds ${MAX_BATCH_BYTES} bytes`,
        code: 'PAYLOAD_TOO_LARGE',
      },
      { status: 413 },
    );
  }

  // Read with a hard byte ceiling enforced on the actual bytes, not just
  // the (spoofable / chunked-bypassable) Content-Length header.
  let bodyText: string;
  try {
    bodyText = await readBodyTextWithLimit(req, MAX_BATCH_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return Response.json(
        { error: err.message, code: 'PAYLOAD_TOO_LARGE' },
        { status: 413 },
      );
    }
    throw err;
  }

  let body: RequestBody | unknown[] | null = null;
  try {
    body = JSON.parse(bodyText) as RequestBody | unknown[];
  } catch {
    return Response.json(
      { error: 'body must be JSON', code: 'BODY_INVALID' },
      { status: 400 },
    );
  }

  return withIdempotency(req, 'events.ingest', async () => {
    const rawEvents: unknown[] = Array.isArray(body)
      ? body
      : (body?.events ?? []);

    if (rawEvents.length > MAX_BATCH_EVENTS) {
      return {
        status: 413,
        body: {
          error: `batch exceeds ${MAX_BATCH_EVENTS} events (got ${rawEvents.length})`,
          code: 'PAYLOAD_TOO_LARGE',
        },
      };
    }

    const normalized = rawEvents
      .filter(
        (e): e is Record<string, unknown> => typeof e === 'object' && e !== null,
      )
      .map(normalize);

    // Per-event payload cap. Rejecting the whole batch is intentional —
    // partial-acceptance would force callers to reconcile which events
    // landed and which didn't, which defeats batching.
    for (const event of normalized) {
      const size = JSON.stringify(event.payload).length;
      if (size > MAX_EVENT_PAYLOAD_BYTES) {
        return {
          status: 413,
          body: {
            error: `event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes (got ${size})`,
            code: 'PAYLOAD_TOO_LARGE',
            eventType: event.type,
          },
        };
      }
    }

    await ingestEvents(normalized);

    const activeWebhooks = await listActiveWebhooks().catch((err) => {
      logger.warn({ err }, 'webhooks list failed, skipping fan-out');
      return [];
    });

    const seenAids = new Set<string>();
    for (const event of normalized) {
      if (event.aidA) seenAids.add(event.aidA);
      if (event.aidB) seenAids.add(event.aidB);
    }
    if (seenAids.size > 0) {
      try {
        await touchLastSeenBatch([...seenAids]);
      } catch {
        // best-effort
      }
    }

    for (const event of normalized) {
      eventBus.publish(event);
      await sessionMonitor.onEvent(event);
      await tctMonitor.onEvent(event);
    }

    // Webhook fan-out with bounded concurrency. The batch is already
    // capped at MAX_BATCH_EVENTS; this caps the in-flight enqueue width
    // so a full batch can't burst the outbound delivery layer.
    for (let i = 0; i < normalized.length; i += WEBHOOK_DISPATCH_CONCURRENCY) {
      const slice = normalized.slice(i, i + WEBHOOK_DISPATCH_CONCURRENCY);
      await Promise.all(
        slice.map((event) =>
          dispatchWebhooksWithList(event, activeWebhooks).catch((err) =>
            logger.warn({ err, eventType: event.type }, 'webhooks dispatch failed'),
          ),
        ),
      );
    }

    return { status: 200, body: { ingested: normalized.length } };
  });
}
