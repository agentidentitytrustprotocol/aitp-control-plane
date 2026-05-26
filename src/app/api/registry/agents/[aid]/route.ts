import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { deactivateAgent, getAgent } from '@/lib/registry/store';
import { writeAdminAudit } from '@/lib/audit-log/service';
import { ingestOneEvent } from '@/lib/audit/event-store';
import { eventBus, type AuditEventRecord } from '@/lib/audit/stream';
import { dispatchWebhooks } from '@/lib/webhooks/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ aid: string }> },
) {
  const { aid } = await params;
  const decoded = decodeURIComponent(aid);
  const agent = await getAgent(decoded);
  if (!agent) {
    return Response.json(
      { error: 'agent not found', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }
  return Response.json(
    {
      aid: agent.aid,
      displayName: agent.displayName,
      handshakeEndpoint: agent.handshakeEndpoint,
      offeredCaps: agent.offeredCaps,
      status: agent.status,
      registeredAt: agent.registeredAt,
      lastSeenAt: agent.lastSeenAt,
      manifestUrl: `/api/registry/agents/${encodeURIComponent(agent.aid)}/manifest`,
    },
    {
      // Public discovery surface — a 30s cache softens load on hot
      // peer-discovery paths without making stale data dangerous (the
      // canonical signed manifest is fetched at handshake time anyway).
      headers: { 'Cache-Control': 'public, max-age=30' },
    },
  );
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ aid: string }> },
) {
  const { aid } = await params;
  const decoded = decodeURIComponent(aid);
  const ok = await deactivateAgent(decoded);
  if (!ok) {
    return Response.json(
      { error: 'agent not found', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }
  await writeAdminAudit({
    action: 'agent.deregister',
    targetId: decoded,
    requestId: req.headers.get('x-request-id') ?? undefined,
  });
  const event: AuditEventRecord = {
    id: randomUUID(),
    type: 'agent.deregistered',
    ts: new Date().toISOString(),
    aidA: decoded,
    payload: { reason: 'admin_deregister' },
    source: 'cp',
  };
  await ingestOneEvent(event);
  eventBus.publish(event);
  void dispatchWebhooks(event).catch(() => {});
  return Response.json({ aid: decoded, status: 'deregistered' });
}
