import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Kubernetes-style readiness probe. Distinct from /api/health (liveness)
 * in that it requires the database to be reachable. K8s should remove the
 * pod from service when this returns 503 but keep it running. */
export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return Response.json({ ready: true }, { status: 200 });
  } catch (err) {
    return Response.json(
      {
        ready: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}
