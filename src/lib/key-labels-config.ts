/**
 * Boot check for key labels in `API_KEYS` and `ISSUER_KEYS`.
 *
 * A label is the audit actor (`key:<label>`) and the revocation last-pull
 * series name, so two keys sharing one make their traffic indistinguishable.
 * The parsers in `api-keys.ts` report that as an error rather than a warning,
 * and this refuses to start on one.
 *
 * FATAL IN EVERY NODE_ENV, unlike the required-variable checks
 * (`enrollment-config.ts`, `identity/cp-seed-config.ts`) that only warn outside
 * production: those let `npm run dev` start off an empty `.env.example`, while a
 * duplicate label is never a usable configuration anywhere, and an empty list
 * has no labels to collide.
 */
import { config } from './config';

/** The line to print before exiting, or `null` when the labels are unique. */
export function keyLabelBootFailure(
  errors: readonly string[] = config.keyLabelErrors,
): string | null {
  if (errors.length === 0) return null;
  return (
    `[aitp-cp] FATAL: ${errors.join('; ')}. ` +
    'Refusing to start: give every key in API_KEYS and in ISSUER_KEYS its own label ' +
    '(a rotation adds the new key under a new label) and redeploy.'
  );
}

/**
 * Apply `keyLabelBootFailure()`: print it and exit 1. Called once per server
 * boot from `src/instrumentation.ts`'s `register()`, after the seed check;
 * nothing else may call it. The exit lives here rather than there for the
 * reasons on `enforceEnrollmentSecretAtBoot` (no `process.exit` in the
 * Edge-compiled file; coverage).
 */
export function enforceKeyLabelsAtBoot(): void {
  const failure = keyLabelBootFailure();
  if (failure === null) return;
  // eslint-disable-next-line no-console
  console.error(failure);
  process.exit(1);
}
