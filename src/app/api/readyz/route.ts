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
  // #98, #111). The values are a closed vocabulary of literals authored here, so
  // no future one can carry infrastructure detail. Deliberately not a
  // `{error, code}` pair: docs/api.md states the probes answer their own shapes.
  //
  // Structure is the guard. The catch builds no output — every byte of every
  // response body is constructed outside it, so `err` is not in scope where a
  // body exists. That is the property a catch binding nothing buys (/api/health
  // right next door swallows its probe error exactly this way; registry/agents
  // and enroll use the bare `catch {}` form for parse failures they answer from
  // literals), without giving up the diagnostic. It cannot be #111's
  // log-and-rethrow: a rethrow renders a framework 500 with `Internal Server
  // Error` text, which is not the documented readiness body and not the
  // 503-means-not-ready contract an LB is pointed at.
  //
  // The log is not optional. src/instrumentation.ts registers no
  // `onRequestError`, so without this line a database outage on the readiness
  // path would produce no pino record at all and the fix would trade a leak for
  // blindness. `warn`, not `error`: the route still answers, and a 5-10s probe
  // interval would otherwise emit 60-120 error lines per replica per ten-minute
  // outage.
  //
  // The log is try-guarded for the reason enroll's recordFailure states
  // ("instrumentation must never change the response, so neither half may
  // throw"), and that rule bites here specifically: this path answers 503, so a
  // throw from the log — pino's `err` serializer does throw synchronously if the
  // error carries a throwing getter — would turn the classified 503 into the
  // framework 500 the paragraph above exists to avoid. Guarding it is what lets
  // both halves of that argument hold at once. revocation/entries deliberately
  // does NOT guard its log for the complementary reason: that path is already a
  // 500, so a logger fault cannot change its status.
  let dbReachable = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbReachable = true;
  } catch (err) {
    try {
      logger.warn({ err }, 'readiness probe failed: database unreachable');
    } catch {
      // Intentionally ignored — see above. A lost log line is strictly better
      // than a probe that answers 500 instead of 503.
    }
  }

  if (!dbReachable) {
    return Response.json(
      { ready: false, reason: 'db_unreachable' },
      { status: 503 },
    );
  }
  return Response.json({ ready: true }, { status: 200 });
}
