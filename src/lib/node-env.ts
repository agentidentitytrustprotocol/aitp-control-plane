/**
 * `NODE_ENV` classification, shared by `config.ts` and `logger.ts` (issue #116).
 *
 * Every production safeguard in this service is keyed on ONE exact match,
 * `config.isProduction`. Anything other than the string `production` —
 * `staging`, `prod`, unset — silently turns ALL of them off: empty `API_KEYS`
 * stops failing closed (auth is DISABLED on gated routes), a bad
 * `ENROLLMENT_SECRET` or a missing/malformed `CP_AID_SEED_HEX` is no longer
 * fatal at boot (a missing seed becomes a random key that changes on every
 * restart), webhook URLs may be plain http, and the logger switches to
 * `pino-pretty`.
 *
 * Two things fix that without making any single gate stricter than the others
 * (which would be inconsistent and falsely reassuring):
 *   1. the value is TRIMMED, so `"production "` is production rather than a
 *      silent loss of every safeguard over a stray space;
 *   2. a value that is neither `production` nor a recognised development value
 *      is reported once at boot, at error level, naming what is inactive.
 *
 * No imports: `logger.ts` must stay dependency-free (see `config.ts`).
 */

export const RECOGNISED_DEVELOPMENT_NODE_ENVS = ['development', 'test'] as const;

/** `NODE_ENV` as the safeguards see it: trimmed. `''` when unset. */
export function readNodeEnv(): string {
  return (process.env.NODE_ENV ?? '').trim();
}

export function isProductionNodeEnv(): boolean {
  return readNodeEnv() === 'production';
}

/**
 * The boot warning for an unrecognised `NODE_ENV`, or `null` when it is
 * `production` or a recognised development value. Pure, so the exact text is
 * testable without a process.
 */
export function nodeEnvBootWarning(): string | null {
  const env = readNodeEnv();
  if (
    env === 'production' ||
    (RECOGNISED_DEVELOPMENT_NODE_ENVS as readonly string[]).includes(env)
  ) {
    return null;
  }
  // JSON.stringify so an empty value, a stray space or a control character is
  // visible rather than inferred.
  const seen = process.env.NODE_ENV === undefined ? 'unset' : JSON.stringify(process.env.NODE_ENV);
  return (
    `[aitp-cp] NODE_ENV is ${seen}, which is neither "production" nor a recognised ` +
    `development value (${RECOGNISED_DEVELOPMENT_NODE_ENVS.join(', ')}), so this process runs as NOT production ` +
    'and every production safeguard is INACTIVE: an empty API_KEYS leaves gated routes ' +
    'unauthenticated instead of answering 503, a bad ENROLLMENT_SECRET or a missing or ' +
    'malformed CP_AID_SEED_HEX no longer stops the boot (a missing seed becomes a random ' +
    'key, so the CP AID changes on every restart), webhook URLs may be plain http, and logs ' +
    'use the dev pretty-printer. Set NODE_ENV=production for any deployed instance ' +
    '(a staging environment included).'
  );
}

/** Print `nodeEnvBootWarning()` once. Called from `instrumentation.ts`'s `register()`. */
export function warnOnUnrecognisedNodeEnv(): void {
  const warning = nodeEnvBootWarning();
  if (warning !== null) {
    // eslint-disable-next-line no-console
    console.error(warning);
  }
}
