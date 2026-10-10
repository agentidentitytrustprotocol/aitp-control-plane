import { webhookBreaker } from '@/lib/webhooks/circuit-breaker';
import { invalidId, isUuid } from '@/lib/http/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // The breaker map is in-memory and keyed by any string: without this check
  // every probed id would create a fresh entry. Webhook ids are UUIDs.
  if (!isUuid(id)) return invalidId();
  return Response.json(webhookBreaker.getSnapshot(id));
}
