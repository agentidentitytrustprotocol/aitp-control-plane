import { NextRequest } from 'next/server';
import { getAgent } from '@/lib/registry/store';

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
  return new Response(agent.manifestJson, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=60',
    },
  });
}
