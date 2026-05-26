import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { isShuttingDown } from '@/lib/shutdown';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Kubernetes-style readiness probe. Distinct from /api/health (liveness)
 * in that it requires the database to be reachable. K8s should remove the
 * pod from service when this returns 503 but keep it running.
 *
 * Also flips to 503 once a SIGTERM has been received — the LB drains us
 * out of rotation before the process actually exits. */
export async function GET() {
  if (isShuttingDown()) {
    return Response.json(
      { ready: false, reason: 'shutting_down' },
      { status: 503 },
    );
  }
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
