import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { getCpManifestJson } from '@/lib/identity/cp-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const manifest = JSON.parse(getCpManifestJson()) as {
    manifest: { aid: string };
  };

  const body = {
    ok: dbOk,
    service: 'aitp-control-plane',
    aid: manifest.manifest.aid,
    db: dbOk ? 'ok' : 'error',
  };

  return Response.json(body, { status: dbOk ? 200 : 503 });
}
