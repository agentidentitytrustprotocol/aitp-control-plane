import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { getCpAgent } from '@/lib/identity/cp-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DB-backed health: 200 `{ok:true,service,aid,db:'ok'}`, or 503 with
 * `db:'error'` when `SELECT 1` fails. On Railway this is the deploy-time
 * healthcheck (railway.json) — it gates a new deployment going live and is
 * never polled afterwards, so a 503 here never restarts a running service. Do
 * not wire it as a k8s-style liveness probe: a DB outage would then restart
 * every replica; use /api/readyz for readiness.
 */
export async function GET() {
  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  // The AID straight from the identity, not by building and parsing the signed
  // manifest: a health probe has no business re-signing anything. A missing or
  // unusable CP_AID_SEED_HEX no longer reaches here in production — the boot
  // check (lib/identity/cp-seed-config.ts) exits first.
  const body = {
    ok: dbOk,
    service: 'aitp-control-plane',
    aid: getCpAgent().aid,
    db: dbOk ? 'ok' : 'error',
  };

  return Response.json(body, { status: dbOk ? 200 : 503 });
}
