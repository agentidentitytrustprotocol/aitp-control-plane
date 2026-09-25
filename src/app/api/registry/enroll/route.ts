import { NextRequest } from 'next/server';
import { childLogger } from '@/lib/logger';
import { recordEnrollFailure } from '@/lib/registry/enroll-metrics';
import { getEnrollmentService } from '@/lib/registry/enrollment';
import {
  ManifestRejectedError,
  sdkVerifyCode,
} from '@/lib/registry/verify-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Upper bound on the client-supplied request id we are willing to put in a log
 * line. `x-request-id` may be pre-set by the caller, and this route is public,
 * so an unbounded value is a log-volume amplification vector by itself.
 */
const MAX_LOGGED_REQUEST_ID = 200;

/**
 * The response `code` values this route may publish for a rejection this
 * service made itself, and the value it falls back to.
 *
 * `cpCode` is OURS — a SCREAMING_SNAKE value from this repo's taxonomy — so an
 * unrecognized one is a bug in this repo rather than news from a dependency,
 * and echoing it would publish an undocumented code to clients. That is the
 * exact opposite of the rule for `verifyCode`, which passes through verbatim
 * precisely because the SDK owns that vocabulary and has already grown it.
 * Whoever owns the vocabulary decides whether unknown values pass through.
 *
 * This allowlist is the only check there is: `openapi.yaml` enumerates no
 * `code` value anywhere (its `Error.code` is a bare `type: string`), so nothing
 * machine-readable would catch a bad one, and each value is published
 * per-endpoint in `docs/api.md` prose. Add a value here only together with its
 * `docs/api.md` and `openapi.yaml` entry.
 */
const REJECTION_CODES: readonly string[] = ['MANIFEST_INVALID', 'MANIFEST_EXPIRED'];
const DEFAULT_REJECTION_CODE = 'MANIFEST_INVALID';

/**
 * The `aitp` SDK's code for a manifest already past its `expires_at`.
 *
 * This is the one SDK code literal in production code outside
 * `enroll-metrics.ts`'s label allowlist, and it knowingly supersedes the
 * earlier "`route.ts` contains no SDK code literals" rule. The literal is
 * unavoidable: mapping one SDK code to one of ours is by definition a
 * translation, and hiding it in `verify-error.ts` would break that file's
 * stronger invariant (it names no code at all) to preserve a weaker one.
 *
 * Both expiry paths therefore report `MANIFEST_EXPIRED` — already past
 * `expires_at` (caught by the SDK) and inside our five-minute registration
 * window (caught by `enrollment.ts`) — with `verifyCode` distinguishing them.
 * That is the right grouping: to a client both mean "re-issue with a longer
 * TTL". If a future SDK renames this code, the grouping silently reverts to
 * `MANIFEST_INVALID` for the SDK half; the in-repo half is unaffected, and the
 * `enroll_verification_failures{code="other"}` series is what would show it.
 */
const SDK_EXPIRED_CODE = 'expired';

/**
 * Record a classified enrollment failure: one counter increment and one log
 * line, by code.
 *
 * Deliberately logs NOTHING about the manifest — not the body, not the AID.
 * The body is unauthenticated attacker-controlled input up to the size limit,
 * and logging it at warn level on a public endpoint is a log-volume
 * amplification vector. The code plus the request id is enough to chart and
 * alert on, and the request id is bound explicitly here: nothing else in this
 * service puts one on a log line, so without this the line could not be
 * correlated to a request at all.
 *
 * Instrumentation must never change the response, so neither half may throw: a
 * counter bug turning a clean 400 into an unhandled 500 would be strictly worse
 * than a lost metric. The two halves are guarded SEPARATELY and the log goes
 * first, so a counter fault cannot also cost us the log line (and vice versa).
 * These two swallows are the only silent-failure paths added here.
 */
function recordFailure(
  req: NextRequest,
  code: string,
  verifyCode: string | undefined,
): void {
  try {
    const requestId = req.headers.get('x-request-id')?.slice(0, MAX_LOGGED_REQUEST_ID);
    childLogger(requestId ? { requestId } : {}).warn(
      { code, verifyCode },
      'enrollment verification failed',
    );
  } catch {
    // Intentionally ignored — see above.
  }
  try {
    recordEnrollFailure(verifyCode);
  } catch {
    // Intentionally ignored — see above.
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  // Pre-validate JSON shape so the caller gets "body must be ManifestEnvelope"
  // instead of a Rust serde error string when they POST something unrelated.
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (!parsed.manifest || typeof parsed.manifest !== 'object') {
      return Response.json(
        {
          error: 'body must be a ManifestEnvelope: {"manifest": {...}}',
          code: 'MANIFEST_INVALID',
        },
        { status: 400 },
      );
    }
  } catch {
    return Response.json(
      { error: 'body must be valid JSON', code: 'BODY_INVALID' },
      { status: 400 },
    );
  }
  // Hoisted deliberately OUT of the try below. `getEnrollmentService()`
  // constructs `EnrollmentService`, whose constructor throws when
  // ENROLLMENT_SECRET is unset or shorter than 32 chars — a server fault,
  // not a problem with the caller's manifest. Inside the try it was caught by
  // the catch-all and answered `400 MANIFEST_INVALID`, which tells every
  // client in the fleet to stop retrying and fix a manifest that was fine,
  // while nothing in the response points at the operator. Hoisting it also
  // states the precedence in the control flow: a broken server cannot
  // evaluate anyone's manifest.
  //
  // This second catch is safe to keep this narrow ONLY because that
  // constructor has exactly two throw sites and no other statement in it can
  // fail. If you add anything to `EnrollmentService`'s constructor that can
  // throw for a different reason, this guard must be re-thought — otherwise
  // it becomes the same catch-all bug pointed the other way.
  let service;
  try {
    service = getEnrollmentService();
  } catch {
    // 503 + SERVER_MISCONFIGURED matches src/proxy.ts's existing precedent for
    // a missing required secret, and docs/api.md already lists 503 as
    // "misconfigured / draining". Two deliberate divergences from that
    // precedent: the message is fixed rather than naming the env var (the
    // caller is unauthenticated and cannot act on it either way), and the
    // guard is UNCONDITIONAL rather than production-only — enroll is a public
    // route, nothing validates this secret at startup, and a server without it
    // cannot serve enrollment in any environment.
    return Response.json(
      {
        error: 'enrollment is temporarily unavailable on this server',
        code: 'SERVER_MISCONFIGURED',
      },
      { status: 503 },
    );
  }

  try {
    const result = service.verifyAndIssueToken(body);
    return Response.json(result, { status: 200 });
  } catch (err) {
    // The repo's established idiom, which this route was the only one to omit:
    // discriminate the known error types, map each, and RETHROW the rest.
    // Without the rethrow every internal failure is laundered into a 400 that
    // blames the caller. See events/route.ts, webhooks/route.ts and
    // events/history/route.ts, which all do this.
    if (err instanceof ManifestRejectedError) {
      // We rejected it, deliberately, and it is the caller's fault. No
      // verifyCode: the SDK is not what rejected this. The cpCode is
      // allowlisted rather than echoed — see REJECTION_CODES.
      const code = REJECTION_CODES.includes(err.cpCode)
        ? err.cpCode
        : DEFAULT_REJECTION_CODE;
      recordFailure(req, code, undefined);
      return Response.json({ error: err.message, code }, { status: 400 });
    }

    // Semantics: `verifyCode` present ⇔ the aitp SDK rejected this manifest.
    // After the ManifestRejectedError branch above, that is also exactly the
    // test for "is this the caller's fault at all" — so its absence here means
    // the failure was neither a rejection we made nor one the SDK made.
    const verifyCode = sdkVerifyCode(err);
    if (verifyCode === undefined) {
      // Not a manifest problem at all — a bug, a broken dependency, an
      // exhausted resource. Let it propagate so the framework renders a 500
      // and internal detail stays out of the body by construction rather than
      // by remembering to redact it.
      throw err;
    }

    // `code` stays in this repo's SCREAMING_SNAKE taxonomy (BODY_INVALID,
    // MANIFEST_EXPIRED, TOKEN_INVALID, RATE_LIMITED, …); the SDK's codes are a
    // lowercase_snake vocabulary owned by a different project on a different
    // release cadence. The SDK's code is never written INTO `code` — that
    // would break every client branching on `code` today and put two unrelated
    // vocabularies in one field. What happens instead is a translation of
    // exactly one value (see SDK_EXPIRED_CODE), so the two expiry paths agree.
    // The case convention carries the distinction: SCREAMING_SNAKE means this
    // service classified it, lowercase_snake means the SDK did.
    //
    // So `verifyCode` is an additive sibling field, following the
    // `{error, code, bucket}` shape src/proxy.ts already returns on a 429.
    //
    // Named errorBody, not body: `body` is already the request text read at
    // the top of this handler. There is a log line in this same catch, and the
    // obvious thing to reach for when logging a verification failure is the
    // request body — which must NOT be logged (it is unauthenticated
    // attacker-controlled input on a public route). Distinct names so that
    // mistake cannot be made silently.
    const errorBody = {
      error: err instanceof Error ? err.message : String(err),
      code:
        verifyCode === SDK_EXPIRED_CODE ? 'MANIFEST_EXPIRED' : DEFAULT_REJECTION_CODE,
      verifyCode,
    };
    recordFailure(req, errorBody.code, verifyCode);
    return Response.json(errorBody, { status: 400 });
  }
}
