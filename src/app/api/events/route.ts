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
import { checkColumnString } from '@/lib/http/validate';
import { recordEventsDropped } from '@/lib/audit/ingest-metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A `Date` the `ts` column can store: a valid instant (a number beyond the
 * ECMAScript range of +-8.64e15 ms yields an Invalid Date, whose
 * `toISOString()` throws) whose UTC year is 0001-9999 (outside that,
 * `toISOString()` renders an expanded `+010000-...` / `-000001-...` year).
 */
function inStorableRange(d: Date): boolean {
  if (Number.isNaN(d.getTime())) return false;
  const year = d.getUTCFullYear();
  return year >= 1 && year <= 9999;
}

/**
 * The event's `ts` as ISO-8601. An absent, unparseable or out-of-range value
 * (see {@link inStorableRange}) falls back to the ingest time.
 */
function normalizeTimestamp(raw: unknown): string {
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (inStorableRange(d)) return d.toISOString();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    if (inStorableRange(d)) return d.toISOString();
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
    // Pass the payload through verbatim. v0.2 TCT/delegation events nest
    // the artifact as `payload.tct = { token, claims }` (JWS migration);
    // that structure is preserved untouched here and decomposed downstream
    // by the tct-monitor — the ingestion layer never inspects token shape.
    payload:
      typeof raw.payload === 'object' && raw.payload !== null
        ? payload
        : (raw as Record<string, unknown>),
    source: pickString(raw.source) ?? 'playground',
  };
}

interface RequestBody {
  events?: unknown;
}

/**
 * Per-item column limits, in code points (the unit `varchar(n)` counts) —
 * `audit_events` in src/lib/db/schema.ts. A value over its limit, or holding
 * U+0000, would fail the batch's single multi-row INSERT (22001 / 22021).
 */
type TextField = 'type' | 'aidA' | 'aidB' | 'sessionId' | 'runId' | 'source';
const TEXT_FIELD_LIMITS: ReadonlyArray<readonly [TextField, number]> = [
  ['type', 128],
  ['aidA', 512],
  ['aidB', 512],
  ['sessionId', 255],
  ['runId', 255],
  ['source', 128],
];

/**
 * Nesting cap for `payload`. JSON.parse is iterative in V8, so a ~120k-level
 * payload parses inside the 256KB body cap; anything recursive downstream
 * (JSON.stringify for the size check, the jsonb encoder, a projection) would
 * then overflow the stack. Items nested deeper than this are dropped.
 */
const MAX_PAYLOAD_DEPTH = 64;

/** At most this many `errors[]` entries per response; `dropped` is the full count. */
const MAX_REPORTED_ERRORS = 20;

interface ItemError {
  index: number;
  field: string;
  reason: string;
}

/**
 * Walk a JSON value ITERATIVELY (explicit stack — a recursive walk is the very
 * stack overflow the depth cap exists to prevent) and report why Postgres'
 * jsonb could not store it: nesting deeper than {@link MAX_PAYLOAD_DEPTH},
 * U+0000 in a key or string value (22P05), or a lone UTF-16 surrogate in a key
 * or string value. (JSON.stringify — which is how the jsonb parameter is sent —
 * escapes a lone surrogate as `"\ud800"`, and Postgres rejects that escape:
 * "invalid input syntax for type json". Unlike a text column, no U+FFFD
 * substitution happens on the way.) Too-deep wins over NUL, and NUL over a
 * lone surrogate: the walk stops at the first container past the cap and
 * otherwise visits every node, so `tooDeep: false` is a guarantee the value
 * is safe for recursive code (JSON.stringify). Reasons are fixed strings:
 * they never echo caller content.
 */
function jsonValueProblem(
  root: unknown,
  field: string,
): { reason: string; tooDeep: boolean } | null {
  let hasNul = false;
  let hasLoneSurrogate = false;
  const check = (str: string): void => {
    if (!hasNul && str.includes('\u0000')) hasNul = true;
    if (!hasLoneSurrogate && !str.isWellFormed()) hasLoneSurrogate = true;
  };
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value === 'string') {
      check(value);
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    if (depth > MAX_PAYLOAD_DEPTH) {
      return {
        reason: `${field} is nested too deep (more than ${MAX_PAYLOAD_DEPTH} levels)`,
        tooDeep: true,
      };
    }
    if (Array.isArray(value)) {
      for (const v of value) stack.push({ value: v, depth: depth + 1 });
    } else {
      for (const [k, v] of Object.entries(value)) {
        check(k);
        stack.push({ value: v, depth: depth + 1 });
      }
    }
  }
  if (hasNul) return { reason: `${field} contains a NUL character`, tooDeep: false };
  if (hasLoneSurrogate) {
    return { reason: `${field} contains a lone UTF-16 surrogate`, tooDeep: false };
  }
  return null;
}

interface ItemProblem {
  field: string;
  reason: string;
  tooDeep: boolean;
}

/**
 * First problem that would make `event` unstorable, or `null`. A too-deep
 * payload is reported first whatever else is wrong, because the caller must
 * then keep the payload away from JSON.stringify.
 */
function itemProblem(event: AuditEventRecord): ItemProblem | null {
  const payloadProblem = jsonValueProblem(event.payload, 'payload');
  if (payloadProblem?.tooDeep) return { field: 'payload', ...payloadProblem };
  for (const [field, max] of TEXT_FIELD_LIMITS) {
    const v = event[field];
    if (typeof v !== 'string') continue;
    const reason = checkColumnString(v, { field, max });
    if (reason) return { field, reason, tooDeep: false };
  }
  if (event.grants) {
    const p = jsonValueProblem(event.grants, 'grants');
    if (p) return { field: 'grants', ...p };
  }
  if (payloadProblem) return { field: 'payload', ...payloadProblem };
  return null;
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
  // (the periodic jobs are also re-arm-on-call). Suppressed under Jest:
  // every worker's first ingest would fire a boot sweep / retry flush
  // against the shared test DB, racing the suites that seed those
  // tables and exercise the sweeps directly.
  if (process.env.JEST_WORKER_ID === undefined) {
    startExpiryJob();
    startWebhookReaper();
    startRetentionJob();
  }

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
    // `{events: <non-array>}` is a client bug worth a 400 — and it must be
    // caught BEFORE the 500-event cap, which would otherwise read `.length`
    // off a string or `{length: 501}` and answer 413 (or throw: 500). A
    // top-level primitive / `null`, or `events: null`, keeps answering
    // `200 {ingested: 0}` as it always has.
    if (
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      (body as RequestBody).events !== undefined &&
      (body as RequestBody).events !== null &&
      !Array.isArray((body as RequestBody).events)
    ) {
      return {
        status: 400,
        body: { error: 'events must be an array', code: 'BODY_INVALID' },
      };
    }

    const rawEvents: unknown[] = Array.isArray(body)
      ? body
      : (((body as RequestBody | null)?.events as unknown[] | null | undefined) ?? []);

    if (rawEvents.length > MAX_BATCH_EVENTS) {
      return {
        status: 413,
        body: {
          error: `batch exceeds ${MAX_BATCH_EVENTS} events (got ${rawEvents.length})`,
          code: 'PAYLOAD_TOO_LARGE',
        },
      };
    }

    // Non-object entries are skipped silently, as they always were (not
    // counted in `dropped`). Each object keeps its index in the ORIGINAL
    // array so `errors[].index` points at what the caller sent.
    const candidates: Array<{
      index: number;
      event: AuditEventRecord;
      problem: ItemProblem | null;
    }> = [];
    rawEvents.forEach((e, index) => {
      if (typeof e !== 'object' || e === null) return;
      const event = normalize(e as Record<string, unknown>);
      candidates.push({ index, event, problem: itemProblem(event) });
    });

    // Per-event payload cap — still whole-batch, unchanged. Measured on every
    // item except one already dropped as too deep (JSON.stringify recurses
    // and would overflow on it), so an oversized payload answers 413 exactly
    // as before even if that item also has a per-item problem.
    for (const { event, problem } of candidates) {
      if (problem?.tooDeep) continue;
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

    // Per-item validation. An item Postgres could not store (a text field
    // over its column limit, U+0000 anywhere, a lone surrogate in payload or
    // grants, a payload nested too deep) is
    // DROPPED and reported, and the rest of the batch is ingested. This
    // replaces the earlier all-or-nothing stance: the batch is one multi-row
    // INSERT, so one bad item used to fail the whole request with a 500 —
    // and the playground posts a whole run's log in one fire-and-forget
    // request, so that lost the entire run's audit trail. Callers learn what
    // was refused from `dropped` / `errors[]` (index into their array).
    const normalized: AuditEventRecord[] = [];
    const errors: ItemError[] = [];
    let dropped = 0;
    for (const { index, event, problem } of candidates) {
      if (problem) {
        dropped += 1;
        if (errors.length < MAX_REPORTED_ERRORS) {
          errors.push({ index, field: problem.field, reason: problem.reason });
        }
        continue;
      }
      normalized.push(event);
    }
    if (dropped > 0) {
      recordEventsDropped(dropped);
      // Counts only — never the payload or the offending values.
      logger.warn(
        { received: rawEvents.length, ingested: normalized.length, dropped },
        'events ingest: dropped items that failed validation',
      );
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

    return { status: 200, body: { ingested: normalized.length, dropped, errors } };
  });
}
