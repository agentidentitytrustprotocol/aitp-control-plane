import { webhookBreaker } from '@/lib/webhooks/circuit-breaker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return Response.json(webhookBreaker.getSnapshot(id));
}
