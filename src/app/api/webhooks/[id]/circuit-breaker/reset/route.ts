import { NextRequest } from 'next/server';
import { webhookBreaker } from '@/lib/webhooks/circuit-breaker';
import { writeAdminAudit } from '@/lib/audit-log/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  webhookBreaker.reset(id);
  await writeAdminAudit({
    action: 'webhook.circuit-breaker.reset',
    targetId: id,
    requestId: req.headers.get('x-request-id') ?? undefined,
  });
  return Response.json(webhookBreaker.getSnapshot(id));
}
