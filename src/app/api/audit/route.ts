import { NextRequest } from 'next/server';
import { listAdminAudit } from '@/lib/audit-log/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = searchParams.has('limit')
    ? Number(searchParams.get('limit'))
    : 100;
  const offset = searchParams.has('offset')
    ? Number(searchParams.get('offset'))
    : 0;
  const rows = await listAdminAudit(
    Number.isFinite(limit) ? limit : 100,
    Number.isFinite(offset) ? offset : 0,
  );
  return Response.json({ entries: rows, count: rows.length });
}
