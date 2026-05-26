import { NextRequest } from 'next/server';
import { listAdminAudit } from '@/lib/audit-log/service';
import { parsePagination } from '@/lib/pagination';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const { limit, offset } = parsePagination(searchParams, {
    defaultLimit: 100,
    maxLimit: 1000,
  });
  const rows = await listAdminAudit(limit, offset);
  return Response.json({ entries: rows, count: rows.length });
}
