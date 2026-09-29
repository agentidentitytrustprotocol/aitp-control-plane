import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
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

  // The probe failure is CLASSIFIED (`reason`), never quoted (#112). It used to
  // answer `{ ready: false, error: err.message }`, and the message came from a
  // pooled connection attempt, so it named infrastructure rather than SQL:
  // `getaddrinfo ENOTFOUND <internal-db-host>`, `password authentication failed
  // for user "<user>"`, `database "<name>" does not exist`, `connect ECONNREFUSED
  // <host>:<port>`. This route is in BOTH `PUBLIC_PATHS` and
  // `RATE_LIMIT_EXEMPT_PATHS` (src/proxy.ts), so that was an internal hostname or
  // username readable by any anonymous caller polling for the moment a deploy is
  // misconfigured — with no auth to stop them and no throttle to slow them down.
  //
  // `reason` rather than a redacted `error`: this route already has that
  // discriminator for the drain, and a probe consumer keys off the status code,
  // so the only thing a body reader actually needs is the one bit `reason`
  // carries — deliberate drain, or fault? — which is what decides "wait" versus
  // "page". Keeping an `error` field with fixed text would preserve the slot a
  // message sat in, and the slot is how this bug class keeps coming back (#91,
  // #98, #99, #111). The values are a closed vocabulary of literals authored
  // here, so no future one can carry infrastructure detail. Deliberately not a
  // `{error, code}` pair: docs/api.md states the probes answer their own shapes.
  //
  // Structure is the guard. The catch's ONLY statement is the log, and every
  // byte of every response body is built outside it, so `err` is not in scope
  // anywhere a body is constructed — the property `catch {}` buys
  // (registry/agents/route.ts, and /api/health right next door) without losing
  // the diagnostic. It cannot be #111's log-and-rethrow: a rethrow renders a
  // framework 500 with `Internal Server Error` text, which is not the documented
  // readiness body and not the 503-means-not-ready contract an LB is pointed at.
  //
  // The log is not optional. src/instrumentation.ts registers no
  // `onRequestError`, so without this line a database outage on the readiness
  // path would produce no pino record at all and the fix would trade a leak for
  // blindness. `warn`, not `error`: the route still answers, and a 5-10s probe
  // interval would otherwise emit ~100 error lines per replica per ten-minute
  // outage.
  let dbReachable = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbReachable = true;
  } catch (err) {
    logger.warn({ err }, 'readiness probe failed: database unreachable');
  }

  if (!dbReachable) {
    return Response.json(
      { ready: false, reason: 'db_unreachable' },
      { status: 503 },
    );
  }
  return Response.json({ ready: true }, { status: 200 });
}
