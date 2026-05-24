import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { ingestEvents } from '@/lib/audit/event-store';
import { eventBus, type AuditEventRecord } from '@/lib/audit/stream';
import { sessionMonitor } from '@/lib/sessions/monitor';
import { touchLastSeenBatch } from '@/lib/registry/store';
import {
  dispatchWebhooksWithList,
  listActiveWebhooks,
  startWebhookReaper,
} from '@/lib/webhooks/service';
import { startExpiryJob } from '@/lib/registry/expiry-job';

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

export async function POST(req: NextRequest) {
  // First-ingest lazy startup hooks — both are idempotent and start a
  // .unref()'d interval so they don't keep Node alive on their own.
  startExpiryJob();
  startWebhookReaper();

  let body: RequestBody | unknown[] | null = null;
  try {
    body = (await req.json()) as RequestBody | unknown[];
  } catch {
    return Response.json(
      { error: 'body must be JSON', code: 'BODY_INVALID' },
      { status: 400 },
    );
  }
  const rawEvents: unknown[] = Array.isArray(body)
    ? body
    : (body?.events ?? []);

  const normalized = rawEvents
    .filter(
      (e): e is Record<string, unknown> => typeof e === 'object' && e !== null,
    )
    .map(normalize);

  await ingestEvents(normalized);

  // One ACTIVE-only webhook lookup for the whole batch — avoids
  // pulling inactive webhook secrets into the request path.
  const activeWebhooks = await listActiveWebhooks().catch((err) => {
    console.warn('[webhooks] list failed, skipping fan-out:', err);
    return [];
  });

  // One last_seen UPDATE for the whole batch.
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
    void dispatchWebhooksWithList(event, activeWebhooks).catch((err) =>
      console.warn('[webhooks] dispatch failed:', err),
    );
  }

  return Response.json({ ingested: normalized.length });
}
