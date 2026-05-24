import { getAgentMetrics } from '@/lib/dashboard/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const agents = await getAgentMetrics();
  return Response.json({ agents });
}
