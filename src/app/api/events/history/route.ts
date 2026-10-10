import { NextRequest } from 'next/server';
import { InvalidFilterError, queryHistory } from '@/lib/audit/event-store';
import { parsePagination } from '@/lib/pagination';
import { checkQueryParam } from '@/lib/http/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const { limit, offset } = parsePagination(searchParams, {
    defaultLimit: 100,
    maxLimit: 1000,
  });
  const type = searchParams.get('type');
  const aid = searchParams.get('aid');
  const sessionId = searchParams.get('session_id') ?? searchParams.get('sessionId');
  const runId = searchParams.get('run_id') ?? searchParams.get('runId');
  // A NUL in a text filter would reach a varchar comparison (22021 -> 500).
  // Answered with this route's filter-error code. (`since`/`until` are parsed
  // as dates by the store and already answer FILTER_INVALID.)
  for (const [name, value] of [
    ['type', type],
    ['aid', aid],
    ['session_id', sessionId],
    ['run_id', runId],
  ] as const) {
    const problem = checkQueryParam(value, name);
    if (problem) {
      return Response.json({ error: problem, code: 'FILTER_INVALID' }, { status: 400 });
    }
  }
  try {
    const rows = await queryHistory({
      type: type ?? undefined,
      aid: aid ?? undefined,
      sessionId: sessionId ?? undefined,
      runId: runId ?? undefined,
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
