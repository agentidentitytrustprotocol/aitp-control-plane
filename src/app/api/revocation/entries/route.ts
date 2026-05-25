import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { revocationEntries } from '@/lib/db/schema';
import { revocationProducer } from '@/lib/revocation/producer';
import { writeAdminAudit } from '@/lib/audit-log/service';
import { eventBus, type AuditEventRecord } from '@/lib/audit/stream';
import { ingestOneEvent } from '@/lib/audit/event-store';
import { dispatchWebhooks } from '@/lib/webhooks/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestBody {
  jti?: unknown;
  reason?: unknown;
  revokedAt?: unknown;
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return Response.json(
      { error: 'body must be JSON', code: 'BODY_INVALID' },
      { status: 400 },
    );
  }
  if (typeof body.jti !== 'string' || !UUID_RE.test(body.jti)) {
    return Response.json(
      { error: 'jti must be a UUID', code: 'JTI_INVALID' },
      { status: 400 },
    );
  }

  const reason = typeof body.reason === 'string' ? body.reason : null;
  let revokedAt: string;
  if (typeof body.revokedAt === 'string') {
    const parsed = new Date(body.revokedAt);
    if (Number.isNaN(parsed.getTime())) {
      return Response.json(
        {
          error: 'revokedAt must be a parseable date string (ISO-8601 recommended)',
          code: 'BODY_INVALID',
        },
        { status: 400 },
      );
    }
    revokedAt = parsed.toISOString();
  } else {
    revokedAt = new Date().toISOString();
  }

  try {
    await db
      .insert(revocationEntries)
      .values({
        jti: body.jti,
        revokedAt,
        reason,
      })
      .onConflictDoNothing();
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err),
        code: 'INSERT_FAILED',
      },
      { status: 500 },
    );
  }

  // Re-sign next time the well-known list is fetched.
  revocationProducer.invalidate();

  const event: AuditEventRecord = {
    id: randomUUID(),
    type: 'tct.revoked',
    ts: revokedAt,
    payload: { jti: body.jti, reason },
    source: 'cp',
  };
  await ingestOneEvent(event);
  eventBus.publish(event);
  void dispatchWebhooks(event).catch((err) =>
    console.warn('[webhooks] tct.revoked dispatch failed:', err),
  );
  await writeAdminAudit({
    action: 'revocation.add',
    targetId: body.jti,
    details: { reason },
    requestId: req.headers.get('x-request-id') ?? undefined,
  });

  return Response.json(
    { jti: body.jti, revokedAt, reason },
    { status: 201 },
  );
}
