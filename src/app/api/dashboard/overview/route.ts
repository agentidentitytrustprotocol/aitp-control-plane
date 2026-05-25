import { NextRequest } from 'next/server';
import { getDashboardOverview, type Range } from '@/lib/dashboard/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID: Range[] = ['1h', '24h', '7d', '30d'];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const raw = (searchParams.get('range') ?? '24h') as Range;
  const range = VALID.includes(raw) ? raw : '24h';
  const overview = await getDashboardOverview(range);
  return Response.json(overview);
}
