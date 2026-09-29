/**
 * The one place that decides whether this service's `ENROLLMENT_SECRET` is
 * usable, and the typed error that says so.
 *
 * THREE CONSUMERS, ONE RULE. `EnrollmentService`'s constructor (so a request
 * hitting a misconfigured server still answers sanely), the boot check in
 * `src/instrumentation.ts` (so a misconfigured *deployment* never reaches a
 * request at all), and the two routes that need to tell this failure apart from
 * every other one. If any of them carried its own copy of "unset, or shorter
 * than 32 characters" they could disagree — boot passing what the constructor
 * rejects is a strictly worse version of the bug issue #99 describes, because
 * the boot check would then be actively reassuring. Hence this module, and hence
 * nothing here reads `process.env` directly except through `config`.
 *
 * IT IMPORTS `config` AND NOTHING ELSE, deliberately. It is loaded from the boot
 * hook, and `enrollment.ts` — the obvious place to have put this — imports
 * `aitp`, whose native binding would then sit on the critical path of the HTTP
 * server's existence. A binding that failed to load would take the entire
 * service down rather than the two routes that actually need it. Keep this
 * module's import list at one entry.
 *
 * NO MESSAGE HERE EVER CARRIES THE SECRET'S VALUE. The too-short message names
 * the observed *length*, which is what makes it actionable, and that is the
 * upper bound of what any of these strings may reveal — they reach operator
 * logs, and the length message was already reaching a response body before #91
 * fixed that.
 */

import { config } from '../config';

/**
 * Minimum usable secret length, in characters.
 *
 * 32 is a floor on entropy for an HMAC-SHA256 key, and it is a *published*
 * number: `README.md`, `.env.example`, `docs/operations.md`,
 * `internal_docs/DEPLOY.md` and both routes' documented 503 all state it, and
 * the harnesses in `scripts/` pin secrets comfortably above it. Raising it is a
 * breaking change for existing deployments — every one of them would refuse to
 * boot — so it moves only with those docs and a migration note.
 */
export const ENROLLMENT_SECRET_MIN_LENGTH = 32;

/**
 * A server whose enrollment configuration is unusable — not a caller's problem.
 *
 * Follows the repo's lib-thrown / route-mapped error idiom
 * (`ManifestRejectedError`, `BodyTooLargeError`, `UnsafeWebhookUrlError`,
 * `InvalidFilterError`): extend `Error`, set `this.name`, let the route
 * discriminate by class.
 *
 * THE CLASS IS THE CONTRACT, and it replaces a much weaker one. Both registry
 * routes used to justify their narrow `catch` around `getEnrollmentService()` by
 * counting throw sites in a constructor in another file — "safe ONLY because
 * that constructor has exactly two throw sites" — which made a third throw site
 * added there silently re-open the defect #69 and #91 fixed, pointed the other
 * way (a server fault reported as the caller's). An `instanceof` check cannot
 * rot that way: a new throw in that constructor is either this class, and means
 * 503, or it is not, and propagates as a 500.
 *
 * It deliberately defines no `code` and no `cpCode` property. `code` belongs to
 * the `aitp` SDK's vocabulary and `sdkVerifyCode` watches for it
 * (`verify-error.ts`); `cpCode` marks a *caller's* rejection. This error is
 * neither, and must not be able to satisfy either test.
 */
export class EnrollmentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrollmentConfigError';
  }
}

/**
 * Why this secret is unusable, as one operator-facing sentence — or `null` when
 * it is fine.
 *
 * Returns a string rather than throwing because two of the three callers want
 * the reason without the control flow: the boot check composes it into a log
 * line, and tests assert on it.
 *
 * BOTH MESSAGES ARE BYTE-FOR-BYTE WHAT `EnrollmentService`'s constructor threw
 * before this module existed, and they are pinned as such by
 * `enrollment.test.ts` (`/ENROLLMENT_SECRET is required/`, `/at least 32/`).
 * They are operator-facing text in logs, not a wire contract — no response body
 * carries either one — but they are the only diagnostic an operator gets, so
 * they change only deliberately.
 */
export function enrollmentSecretProblem(raw: string | undefined): string | null {
  // `!raw` rather than `=== undefined`: `config.enrollmentSecret` defaults an
  // absent variable to `''`, and `ENROLLMENT_SECRET=` (set but empty, which is
  // what `.env.example` ships) must read as "required", not as "0 characters,
  // needs 32" — the operator has not chosen a bad secret, they have not chosen
  // one at all.
  if (!raw) {
    return 'ENROLLMENT_SECRET is required';
  }
  if (raw.length < ENROLLMENT_SECRET_MIN_LENGTH) {
    return (
      `ENROLLMENT_SECRET must be at least ${ENROLLMENT_SECRET_MIN_LENGTH} characters ` +
      `(got ${raw.length}). ` +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return null;
}

/**
 * Throw `EnrollmentConfigError` if the secret is unusable. The form
 * `EnrollmentService`'s constructor wants.
 */
export function assertEnrollmentSecretUsable(raw: string | undefined): void {
  const problem = enrollmentSecretProblem(raw);
  if (problem !== null) {
    throw new EnrollmentConfigError(problem);
  }
}

/**
 * What the boot hook should do about the configured secret: `null` when there is
 * nothing to say, otherwise a line to print and whether to die after printing
 * it.
 *
 * THE POLICY LIVES HERE, NOT AT THE CALL SITE, for one concrete reason:
 * `jest.config.js` excludes `src/instrumentation.ts` from coverage ("OTel
 * bootstrap; exercised only at process start"), so anything decided there is
 * decided in a file no test measures. Keeping the decision a pure function
 * leaves the call site a `console.error` and a `process.exit` — the two things a
 * unit test genuinely cannot run — and puts the branch that matters under test.
 *
 * FATAL ONLY IN PRODUCTION, which is this repo's settled convention for a
 * required variable rather than a hedge: `API_KEYS` fails closed in prod and
 * only warns in dev (`config.ts`), and `CP_AID_SEED_HEX` throws only in prod.
 * It costs real deployments nothing — the `Dockerfile`'s runner stage hardcodes
 * `NODE_ENV=production`, so every container deploy is covered, as is a local
 * `next start` (which defaults `NODE_ENV` to production) — while leaving
 * `npm run dev` off `.env.example` (which ships `ENROLLMENT_SECRET=` empty)
 * working, and leaving the two routes' 503 paths reachable by hand in the only
 * environments where anyone would want to reach them.
 *
 * Non-production still gets the line, because the alternative is the silence
 * issue #99 is about.
 */
export function enrollmentSecretBootFailure(): {
  fatal: boolean;
  message: string;
} | null {
  const problem = enrollmentSecretProblem(config.enrollmentSecret);
  if (problem === null) return null;

  // Both routes are named explicitly. The register half is the one operators
  // miss: it is invisible in the metrics (`enroll_verification_failures` is the
  // enroll route's own counter and never moves for it — see
  // docs/operations.md), so a log line that mentioned only enrollment would
  // understate the outage by half.
  const consequence =
    'POST /api/registry/enroll cannot mint enrollment tokens and ' +
    'POST /api/registry/agents cannot verify them: both answer ' +
    '503 SERVER_MISCONFIGURED for every request.';

  if (config.isProduction) {
    return {
      fatal: true,
      message:
        `[aitp-cp] FATAL: ${problem} ${consequence} ` +
        'Refusing to start rather than serving a deployment that reports ready ' +
        'and then fails every enrollment. Set ENROLLMENT_SECRET and redeploy.',
    };
  }
  return {
    fatal: false,
    message:
      `[aitp-cp] ${problem} ${consequence} ` +
      'Starting anyway because NODE_ENV is not production; a production boot ' +
      'with this configuration exits non-zero instead.',
  };
}

/**
 * Apply `enrollmentSecretBootFailure()`: print it, and die if it is fatal.
 *
 * Called once per server boot from `src/instrumentation.ts`'s `register()`,
 * before anything else is started. Nothing else may call it — it can end the
 * process.
 *
 * IT LIVES HERE RATHER THAN AT THE CALL SITE for a specific, measured reason.
 * Next compiles `instrumentation.ts` for both runtimes, and a literal
 * `process.exit` in that file makes the build emit "A Node.js API is used
 * (process.exit) which is not supported in the Edge Runtime" — a permanent new
 * build warning about a line that is already unreachable off the Node runtime
 * (`register()` returns early unless `NEXT_RUNTIME === 'nodejs'`). Reached
 * through the dynamic import that already loads this module, it is not in the
 * Edge bundle's static graph and the warning does not appear. The side benefit
 * is coverage: `jest.config.js` excludes `instrumentation.ts`, so a decision
 * made there is measured by nothing, while this function is tested — including
 * the exit, with `process.exit` spied.
 *
 * `console.*` rather than the pino logger, matching `config.ts`'s precedent for
 * boot-time configuration messages and keeping the fatal path free of a
 * dependency that could itself fail to load. The LEVEL follows the verdict —
 * `error` when the process is about to die, `warn` when it is starting anyway —
 * which is the same split `config.ts` makes for an empty `API_KEYS`. Emitting the
 * non-fatal case at error level would page someone for a dev box.
 *
 * `process.exit(1)` rather than throwing: Next wraps a throw from `register()`
 * and rethrows it into its own bootstrap, and what the standalone server does
 * with a rejected `prepare()` is a framework internal this repo should not
 * depend on for its crash semantics. A non-zero exit is what
 * `railway.json`'s `restartPolicyType: "ON_FAILURE"` and every orchestrator's
 * crash-loop detector read, and it guarantees the deploy's healthcheck never
 * passes — so the release fails and the previous one keeps serving.
 */
export function enforceEnrollmentSecretAtBoot(): void {
  const failure = enrollmentSecretBootFailure();
  if (failure === null) return;
  // if/else rather than an early `process.exit` followed by the warn: TypeScript
  // types `process.exit` as `never`, so a fall-through would be unreachable in
  // production — but a test that mocks `process.exit` (the only way to assert the
  // fatal path without killing the Jest worker) makes it return, and the fatal
  // message was then ALSO emitted at warn level. Caught by the test asserting the
  // two levels are exclusive. Control flow that is only correct because a
  // function never returns is control flow waiting to be mocked.
  if (failure.fatal) {
    // eslint-disable-next-line no-console
    console.error(failure.message);
    process.exit(1);
  } else {
    // eslint-disable-next-line no-console
    console.warn(failure.message);
  }
}
