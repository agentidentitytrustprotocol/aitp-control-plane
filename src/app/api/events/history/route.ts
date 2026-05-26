import { NextRequest } from 'next/server';
import { InvalidFilterError, queryHistory } from '@/lib/audit/event-store';
import { parsePagination } from '@/lib/pagination';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const { limit, offset } = parsePagination(searchParams, {
    defaultLimit: 100,
    maxLimit: 1000,
  });
  try {
    const rows = await queryHistory({
      type: searchParams.get('type') ?? undefined,
      aid: searchParams.get('aid') ?? undefined,
      sessionId:
        searchParams.get('session_id') ?? searchParams.get('sessionId') ?? undefined,
      runId: searchParams.get('run_id') ?? searchParams.get('runId') ?? undefined,
      since: searchParams.get('since') ?? undefined,
      until: searchParams.get('until') ?? undefined,
      limit,
      offset,
    });
    return Response.json({ events: rows, count: rows.length });
  } catch (err) {
    if (err instanceof InvalidFilterError) {
      return Response.json(
        { error: err.message, code: 'FILTER_INVALID' },
        { status: 400 },
      );
    }
    throw err;
  }
}
