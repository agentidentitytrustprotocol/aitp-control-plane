import { logger } from './logger';

/**
 * One structured log line per unhandled route fault, with the request id
 * attached — the body of Next's `onRequestError` hook.
 *
 * WHY THIS EXISTS. Six places in this service deliberately rethrow a failure
 * they cannot classify, so the framework renders the 500 and no internal detail
 * reaches the response body (`registry/enroll` twice, `revocation/entries`,
 * `webhooks`, `events`, `events/history`). That is the right pattern —
 * "a function that throws has no response body to leak into" — but until this
 * module nothing in the process OBSERVED those throws. The only report was
 * Next's own `console.error`: not JSON, indifferent to `LOG_LEVEL`, and with no
 * `x-request-id`, so it could not be correlated to the request that produced it
 * even though `docs/api.md` promises clients every response carries one. The
 * more carefully a route avoided leaking detail into the body, the less anyone
 * could see about the failure at all (issue #114, found while fixing #98).
 *
 * WHY IT IS A MODULE AND NOT INLINE IN `src/instrumentation.ts`. Same reason
 * that file gives for `enforceEnrollmentSecretAtBoot` living in
 * `enrollment-config.ts`: `jest.config.js` excludes `src/instrumentation.ts`
 * from coverage, so a decision made there is measured by nothing. Every
 * judgement below is here instead, where `request-error.test.ts` asserts it on
 * the emitted JSON.
 *
 * WHAT THIS DOES NOT DO — three things, each deliberate:
 *
 *   1. It does not change the response, because it CANNOT. Next sends a
 *      hardcoded `new Response(null, {status: 500})` after awaiting the hook
 *      (`next/dist/build/templates/app-route.js`), so there is no body, header
 *      or status to influence from here. `src/proxy.ts` already put
 *      `x-request-id` on the response on the way in; this line is how an
 *      operator gets from that id to the fault.
 *   2. It does not silence Next's `console.error`. The framework passes
 *      `silenceLog = false` unconditionally and logs the raw error itself
 *      BEFORE calling the hook. So a fault now produces two lines, one of them
 *      structured. Nothing in userland can turn the other one off; a pipeline
 *      that wants JSON only has to drop non-JSON lines. Do not write a comment
 *      or a doc claiming this replaced `console.error` — it did not.
 *   3. It does not throw. See the swallow at the bottom.
 */

/**
 * Upper bound on the client-supplied request id we are willing to put in a log
 * line, and on the path beside it.
 *
 * `x-request-id` is caller-settable (`src/proxy.ts` echoes what the client sent
 * and only generates one when the header is absent) and this hook fires for
 * PUBLIC routes, so an unbounded value is a log-volume amplification vector by
 * itself. 200 is the same bound `src/app/api/registry/enroll/route.ts` and
 * `src/app/api/events/stream/route.ts` apply to the same header; the three
 * copies are deliberate for now — consolidating them means editing two route
 * files this change has no other business in — and are tracked as a follow-up.
 */
const MAX_LOGGED_REQUEST_ID = 200;

/**
 * The request shape Next hands the hook, restated locally.
 *
 * Next's own `InstrumentationOnRequestError` is NOT on its public type surface:
 * it lives at `next/dist/server/instrumentation/types`, which is a private path
 * that a minor upgrade may move. Production code therefore depends on no
 * internal path, and `src/instrumentation.test.ts` deep-imports Next's type and
 * asserts assignability in BOTH directions instead — so a renamed or retyped
 * field fails `npm run typecheck` loudly, rather than silently leaving a hook
 * Next still calls but which reads `undefined` for everything.
 */
export interface RequestErrorRequest {
  /** `req.url`: pathname AND query string. See `pathOf` for why that matters. */
  readonly path: string;
  readonly method: string;
  /** The POST-middleware header set — see `requestIdOf`. */
  readonly headers: NodeJS.Dict<string | string[]>;
}

export interface RequestErrorContext {
  readonly routerKind: 'Pages Router' | 'App Router';
  /** The route TEMPLATE, e.g. `/api/registry/agents/[aid]`. */
  readonly routePath: string;
  readonly routeType: 'render' | 'route' | 'action' | 'proxy';
  readonly renderSource?:
    | 'react-server-components'
    | 'react-server-components-payload'
    | 'server-rendering';
  readonly revalidateReason: 'on-demand' | 'stale' | undefined;
}

/**
 * The request id to correlate by, bounded.
 *
 * Reading ONLY this one header out of the dict is the security decision in this
 * file. `headers` is the complete request header set and contains
 * `authorization` — a bearer API key on every gated route, and the enrollment
 * token on `POST /api/registry/enroll` — plus any cookies. Logging the dict, a
 * subset of it, or a "redacted" copy would put a live credential in the log on
 * every 500. There is no allowlist here on purpose: one named header cannot grow
 * into a leak the way a filter can.
 *
 * It resolves for essentially every request rather than only for callers who set
 * the header: `src/proxy.ts` sets `x-request-id` on the FORWARDED request, and
 * Next applies the gate's `x-middleware-request-*` overrides onto `req.headers`
 * before the route runs, so the dict carries CP-generated ids too — the same
 * value the client saw in the response header.
 *
 * Node lowercases incoming header names, and a repeated header arrives as an
 * array; the first value wins, matching `Headers.get()`'s single-value read in
 * the route handlers.
 */
function requestIdOf(headers: NodeJS.Dict<string | string[]>): string | undefined {
  const raw = headers['x-request-id'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined || first === '') return undefined;
  return String(first).slice(0, MAX_LOGGED_REQUEST_ID);
}

/**
 * The concrete path, with the query string dropped and the rest bounded.
 *
 * `errorContext.routePath` (logged as `route`) is the template and is the field
 * to aggregate on — a finite, build-derived set. This one is logged beside it
 * because the template loses the actual resource: `/api/registry/agents/[aid]`
 * does not tell you WHICH agent's request failed.
 *
 * Everything from the first `?` is discarded. `GET /api/events/history` and
 * `/api/events/stream` take `aid`, `session_id` and `run_id` filters —
 * caller-supplied identifiers, of unbounded length, on routes an attacker can
 * reach. They are not ours to retain in logs, and they are the one part of the
 * URL a caller controls without limit.
 */
function pathOf(path: string): string {
  const q = path.indexOf('?');
  return (q === -1 ? path : path.slice(0, q)).slice(0, MAX_LOGGED_REQUEST_ID);
}

/**
 * Mark the active span as having thrown, when tracing is on.
 *
 * Next already sets `SpanStatusCode.ERROR` and `error.type` for any 5xx in its
 * own `finally` block, so that is NOT the gap. What it never does is
 * `recordException`, which is what puts the exception type, message and stack on
 * the span — so without this a trace shows an errored request with nothing in it
 * about the error. `setStatus` is kept anyway, cheap and idempotent, because the
 * background-revalidate branch calls this hook and then rethrows rather than
 * responding, so the `res.statusCode >= 500` test that drives Next's version
 * does not necessarily hold on that path.
 *
 * `getActiveSpan()` is the right span by construction rather than by luck: Next
 * awaits the hook INSIDE the `tracer.trace(...)` callback for the request, and
 * its tracer enters the span with `startActiveSpan` /
 * `context.with(trace.setSpan(...))`.
 *
 * Gated on `OTEL_ENABLED` so the default deployment — tracing off — pays neither
 * the dynamic import nor the span lookup per fault, matching `register()`'s
 * treatment of the SDK in the same file.
 */
async function markSpan(error: unknown): Promise<void> {
  if (process.env.OTEL_ENABLED !== 'true') return;
  const { trace, SpanStatusCode } = await import('@opentelemetry/api');
  const span = trace.getActiveSpan();
  if (!span) return;
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Report one unhandled route fault. Never throws, never returns anything the
 * caller must act on.
 *
 * THE SWALLOWS ARE THE CONTRACT, and there are two of them for the reason
 * `enroll/route.ts`'s `recordFailure` gives: the halves are guarded separately
 * and the log goes FIRST, so a tracing fault cannot also cost us the log line.
 *
 * Why swallowing is right here specifically, rather than merely convenient: Next
 * wraps the hook in its own try/catch and reports a throw with
 * `console.error('Error in instrumentation.onRequestError:', err)`. So throwing
 * would lose the structured line AND emit a second unstructured one — the exact
 * defect this module exists to fix. And on the Edge call path Next has no
 * try/catch at the calling frame at all, where the hook is awaited before the
 * response is sent.
 *
 * Note what the catch deliberately does NOT do: fall back to `console.error`.
 * That would reintroduce the banned channel (`eslint.config.mjs`) on the one
 * path where it adds nothing — the framework has already printed the underlying
 * error by the time we are called.
 */
export async function reportRequestError(
  error: unknown,
  errorRequest: RequestErrorRequest,
  errorContext: RequestErrorContext,
): Promise<void> {
  try {
    const requestId = requestIdOf(errorRequest.headers);
    logger.error(
      {
        err: error,
        route: errorContext.routePath,
        path: pathOf(errorRequest.path),
        method: errorRequest.method,
        routerKind: errorContext.routerKind,
        routeType: errorContext.routeType,
        ...(errorContext.revalidateReason
          ? { revalidateReason: errorContext.revalidateReason }
          : {}),
        ...(requestId ? { requestId } : {}),
      },
      'unhandled route error',
    );
  } catch {
    // Intentionally ignored — see above.
  }
  try {
    await markSpan(error);
  } catch {
    // Intentionally ignored — see above.
  }
}
