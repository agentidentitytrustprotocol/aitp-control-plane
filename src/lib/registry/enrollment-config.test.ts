// Unit tests for src/lib/registry/enrollment-config.ts — the single rule that
// decides whether this service's ENROLLMENT_SECRET is usable, the typed error
// that reports it, and the boot policy built on both.
//
// WHAT IS ACTUALLY AT RISK HERE, and why each half is pinned separately:
//
//  • The RULE has three consumers (EnrollmentService's constructor, the boot
//    hook in src/instrumentation.ts, and — through the error class — both
//    registry routes). Its whole reason for existing is that those three cannot
//    be allowed to disagree, so the boundary (exactly 32 characters) is asserted
//    from both sides rather than in the middle.
//
//  • The MESSAGES are byte-for-byte the ones EnrollmentService threw before this
//    module existed, and enrollment.test.ts still matches on them. They are
//    operator-facing text in logs — no response body carries either — but they
//    are the only diagnostic an operator gets.
//
//  • The ERROR CLASS is what both routes' 503 guards discriminate on, replacing
//    a comment in each of those files that counted throw sites in a third one.
//    So it is asserted to be a real distinct class AND to satisfy neither of
//    verify-error.ts's two tests for "the caller's manifest is bad" — an
//    EnrollmentConfigError that carried a `.code` would be classified as an SDK
//    manifest rejection and answered 400, which is the #91 defect exactly.
//
//  • The BOOT POLICY is production-gated, and that gate is the one branch in
//    this change that decides whether a bad deploy dies or merely complains.
//    src/instrumentation.ts is excluded from coverage by jest.config.js, which is
//    precisely why the decision is a pure function living here.
//
// The boot-policy cases re-import through jest.isolateModules because `config`
// is a `const` evaluated at import: it snapshots process.env once, so setting
// NODE_ENV or ENROLLMENT_SECRET after the import is invisible to it. Same
// mechanism, and the same trap, as enrollment.test.ts's withEnrollmentSecret.

import {
  ENROLLMENT_SECRET_MIN_LENGTH,
  EnrollmentConfigError,
  assertEnrollmentSecretUsable,
  enrollmentSecretProblem,
} from './enrollment-config';
import { ManifestRejectedError, sdkVerifyCode } from './verify-error';

/** Exactly at the minimum — the "usable" side of the boundary. */
const AT_MINIMUM = 'a'.repeat(ENROLLMENT_SECRET_MIN_LENGTH);
/** One character short of it. */
const BELOW_MINIMUM = 'a'.repeat(ENROLLMENT_SECRET_MIN_LENGTH - 1);
const USABLE = 'enrollment-config-test-secret-padded-past-the-minimum';

/**
 * Re-import the module — and with it `config` — under a given environment.
 *
 * `process.env` is written through a widened alias: Next generates a
 * `next-env.d.ts` that types `NODE_ENV` as READ-ONLY, and `next build` type-checks
 * this file, so a direct assignment builds fine under `npm run typecheck` (which
 * runs before that file exists in CI) and then fails the build step. Measured,
 * not guessed. The alias is confined to this helper.
 */
const mutableEnv = process.env as Record<string, string | undefined>;

function withEnv(
  env: { NODE_ENV?: string; ENROLLMENT_SECRET?: string },
  fn: (mod: typeof import('./enrollment-config')) => void,
): void {
  const savedNodeEnv = mutableEnv.NODE_ENV;
  const savedSecret = mutableEnv.ENROLLMENT_SECRET;
  if (env.NODE_ENV === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = env.NODE_ENV;
  if (env.ENROLLMENT_SECRET === undefined) delete mutableEnv.ENROLLMENT_SECRET;
  else mutableEnv.ENROLLMENT_SECRET = env.ENROLLMENT_SECRET;
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      fn(require('./enrollment-config') as typeof import('./enrollment-config'));
    });
  } finally {
    if (savedNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = savedNodeEnv;
    if (savedSecret === undefined) delete mutableEnv.ENROLLMENT_SECRET;
    else mutableEnv.ENROLLMENT_SECRET = savedSecret;
  }
}

describe('enrollmentSecretProblem', () => {
  it('reports an absent secret as required, not as too short', () => {
    // The distinction is the operator's next action. `.env.example` ships
    // `ENROLLMENT_SECRET=` (set, empty), and `config` folds an unset variable to
    // `''` as well, so both arrive here as falsy — and "0 characters, needs 32"
    // would describe a bad choice where none was made at all.
    expect(enrollmentSecretProblem(undefined)).toBe(
      'ENROLLMENT_SECRET is required',
    );
    expect(enrollmentSecretProblem('')).toBe('ENROLLMENT_SECRET is required');
  });

  it('reports a too-short secret with its observed length and how to fix it', () => {
    // Pinned byte-for-byte, because this is the string EnrollmentService threw
    // before this module existed and enrollment.test.ts matches on it. The
    // length is deliberately included — it is what makes the message actionable
    // — and it is the ONLY thing about the secret that is ever revealed.
    expect(enrollmentSecretProblem('too-short')).toBe(
      'ENROLLMENT_SECRET must be at least 32 characters (got 9). ' +
        'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  });

  it('accepts exactly the minimum and rejects one character below it', () => {
    // The boundary from both sides. Three consumers share this rule; an
    // off-by-one here would make a secret that boots fail every request, or the
    // reverse.
    expect(enrollmentSecretProblem(AT_MINIMUM)).toBeNull();
    expect(enrollmentSecretProblem(BELOW_MINIMUM)).toContain('(got 31)');
    expect(ENROLLMENT_SECRET_MIN_LENGTH).toBe(32);
  });

  it('accepts a comfortably long secret', () => {
    expect(enrollmentSecretProblem(USABLE)).toBeNull();
  });

  it('never echoes the secret itself', () => {
    // These strings reach operator logs. The length is the documented limit of
    // what they may reveal; the value must not appear even in part.
    const secret = 'sup3rsecret';
    const problem = enrollmentSecretProblem(secret) ?? '';
    expect(problem).toContain('(got 11)');
    expect(problem).not.toContain(secret);
    expect(problem).not.toContain('sup3r');
  });
});

describe('assertEnrollmentSecretUsable', () => {
  it('throws EnrollmentConfigError carrying the same message', () => {
    expect(() => assertEnrollmentSecretUsable('')).toThrow(
      EnrollmentConfigError,
    );
    expect(() => assertEnrollmentSecretUsable('')).toThrow(
      'ENROLLMENT_SECRET is required',
    );
    expect(() => assertEnrollmentSecretUsable('too-short')).toThrow(
      EnrollmentConfigError,
    );
    expect(() => assertEnrollmentSecretUsable('too-short')).toThrow(
      /at least 32/,
    );
  });

  it('is silent for a usable secret', () => {
    expect(() => assertEnrollmentSecretUsable(USABLE)).not.toThrow();
    expect(() => assertEnrollmentSecretUsable(AT_MINIMUM)).not.toThrow();
  });
});

describe('EnrollmentConfigError', () => {
  it('is a named Error subclass, so a route can discriminate on it', () => {
    const err = new EnrollmentConfigError('nope');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EnrollmentConfigError);
    expect(err.name).toBe('EnrollmentConfigError');
    expect(err.message).toBe('nope');
  });

  it('satisfies NEITHER test for a caller-side manifest rejection', () => {
    // The load-bearing negative, and the reason this class defines no `code`
    // and no `cpCode`. verify-error.ts identifies a caller's fault two ways: an
    // `instanceof ManifestRejectedError` (we rejected the manifest) and a usable
    // `.code` (the SDK did). If a server-configuration fault satisfied either,
    // POST /api/registry/enroll would answer it 400 and blame a manifest that
    // was fine — defect #69/#91, from a third direction.
    const err = new EnrollmentConfigError('ENROLLMENT_SECRET is required');
    expect(err).not.toBeInstanceOf(ManifestRejectedError);
    expect(sdkVerifyCode(err)).toBeUndefined();
    expect('cpCode' in err).toBe(false);
  });
});

describe('enrollmentSecretBootFailure', () => {
  it('says nothing when the secret is usable, in either environment', () => {
    withEnv({ NODE_ENV: 'production', ENROLLMENT_SECRET: USABLE }, (mod) => {
      expect(mod.enrollmentSecretBootFailure()).toBeNull();
    });
    withEnv({ NODE_ENV: 'development', ENROLLMENT_SECRET: USABLE }, (mod) => {
      expect(mod.enrollmentSecretBootFailure()).toBeNull();
    });
  });

  it('is FATAL in production, and says what it is refusing and why', () => {
    // The branch the whole change turns on: in production a bad secret must stop
    // the process, because the alternative — the behaviour issue #99 reports —
    // is a replica that reports ready and 503s every enrollment for as long as
    // it runs.
    withEnv({ NODE_ENV: 'production', ENROLLMENT_SECRET: undefined }, (mod) => {
      const failure = mod.enrollmentSecretBootFailure();
      expect(failure).not.toBeNull();
      expect(failure?.fatal).toBe(true);
      expect(failure?.message).toContain('FATAL');
      expect(failure?.message).toContain('ENROLLMENT_SECRET is required');
      expect(failure?.message).toContain('Refusing to start');
    });
  });

  it('names BOTH routes, because the register half is invisible in the metrics', () => {
    // enroll_verification_failures is the enroll route's own counter and never
    // moves for this fault (docs/operations.md), so a line mentioning only
    // enrollment would understate the outage by half and send the operator
    // looking in the wrong place for the other one.
    withEnv({ NODE_ENV: 'production', ENROLLMENT_SECRET: 'short' }, (mod) => {
      const message = mod.enrollmentSecretBootFailure()?.message ?? '';
      expect(message).toContain('POST /api/registry/enroll');
      expect(message).toContain('POST /api/registry/agents');
      expect(message).toContain('503 SERVER_MISCONFIGURED');
    });
  });

  it('warns but does NOT stop a non-production boot, and says so', () => {
    // Deliberately not fatal outside production: `.env.example` ships the
    // variable empty and README's quickstart is `cp .env.example .env`, so a
    // hard stop here would break the documented local flow for anyone who only
    // wants the discovery routes. The line still has to make the consequence
    // unmissable, and has to be honest that production differs.
    for (const nodeEnv of ['development', 'test', undefined]) {
      withEnv({ NODE_ENV: nodeEnv, ENROLLMENT_SECRET: '' }, (mod) => {
        const failure = mod.enrollmentSecretBootFailure();
        expect(failure?.fatal).toBe(false);
        expect(failure?.message).toContain('ENROLLMENT_SECRET is required');
        expect(failure?.message).toContain('Starting anyway');
        expect(failure?.message).not.toContain('FATAL');
      });
    }
  });

  it('reads the secret from config rather than the ambient environment', () => {
    // Non-vacuity for the helper itself: if the env var were being set too late
    // to reach `config` — the exact mistake the helper's docblock describes —
    // every case above would be asserting against whatever the ambient
    // environment happens to hold, and the usable-secret case would fail here.
    withEnv({ NODE_ENV: 'production', ENROLLMENT_SECRET: AT_MINIMUM }, (mod) => {
      expect(mod.enrollmentSecretBootFailure()).toBeNull();
    });
  });

  it('never puts the secret in the boot line', () => {
    // A boot log is the one place this value would be most tempting to print
    // and most damaging to leak — it is archived, shipped to a log aggregator,
    // and read by more people than a response body ever is.
    const secret = 'sh0rt-but-secret';
    withEnv({ NODE_ENV: 'production', ENROLLMENT_SECRET: secret }, (mod) => {
      const message = mod.enrollmentSecretBootFailure()?.message ?? '';
      expect(message).toContain('(got 16)');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('sh0rt');
    });
  });
});

describe('enforceEnrollmentSecretAtBoot', () => {
  // What src/instrumentation.ts actually calls, once per server boot. That file
  // is excluded from coverage (jest.config.js), which is exactly why the
  // console.error and the process.exit live here and are asserted here rather
  // than being taken on trust at the call site.
  //
  // `process.exit` is ALWAYS mocked in this block. Unmocked, the fatal case
  // would take the Jest worker down with it and report as a crashed suite.
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => undefined) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('is completely silent when the secret is usable', () => {
    // The positive control. Without it every assertion below would also pass
    // against a function that printed and exited unconditionally.
    withEnv({ NODE_ENV: 'production', ENROLLMENT_SECRET: USABLE }, (mod) => {
      mod.enforceEnrollmentSecretAtBoot();
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints and exits non-zero on a production boot with no secret', () => {
    // The whole point of issue #99: the deploy fails here, loudly, before any
    // traffic — rather than reporting ready and 503ing every enrollment.
    withEnv({ NODE_ENV: 'production', ENROLLMENT_SECRET: undefined }, (mod) => {
      mod.enforceEnrollmentSecretAtBoot();
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('FATAL');
    // 1, not 0: a zero exit reads as a clean shutdown to an orchestrator, and
    // railway.json's restartPolicyType is ON_FAILURE.
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints but does NOT exit outside production', () => {
    withEnv({ NODE_ENV: 'development', ENROLLMENT_SECRET: 'too-short' }, (mod) => {
      mod.enforceEnrollmentSecretAtBoot();
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Starting anyway');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints before exiting, not after', () => {
    // Ordering is the whole value of the fatal path: an exit that beat its own
    // log line would leave an operator with a crash-looping container and no
    // reason for it, which is a worse incident than the one being fixed.
    const order: string[] = [];
    errorSpy.mockImplementation(() => {
      order.push('error');
    });
    exitSpy.mockImplementation(((_code?: number) => {
      order.push('exit');
      return undefined;
    }) as never);
    withEnv({ NODE_ENV: 'production', ENROLLMENT_SECRET: '' }, (mod) => {
      mod.enforceEnrollmentSecretAtBoot();
    });
    expect(order).toEqual(['error', 'exit']);
  });
});
