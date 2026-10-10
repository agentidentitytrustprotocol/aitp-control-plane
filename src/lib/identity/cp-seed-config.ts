/**
 * The one place that decides whether `CP_AID_SEED_HEX` is usable, and the boot
 * check built on that rule. Also the (non-fatal) production check on
 * `CP_BASE_URL`, which is the other half of the CP's own identity: the seed is
 * its key, the base URL is what its signed manifest advertises.
 *
 * TWO CONSUMERS, ONE RULE. `initCpIdentity()` in `cp-agent.ts` decodes the seed
 * through `decodeCpSeedHex()` below, and the boot check in
 * `src/instrumentation.ts` judges it through `cpSeedProblem()`, which decodes
 * the same way. So boot can never pass a seed the identity then refuses, or
 * refuse one it would have accepted.
 *
 * THE ACCEPTANCE RULE IS EXACTLY THE PRE-EXISTING DECODE, deliberately not a
 * stricter one. The seed has always been read as `Buffer.from(raw, 'hex')` and
 * handed to `AitpAgent.fromSeed`, which demands 32 bytes. Node's hex decoder
 * stops at the first non-hex pair, so `<64 hex>` followed by a newline, a space,
 * any other junk, or a 65th hex digit all decode to the SAME 32 bytes — and so
 * to the same AID — while a `0x` prefix, a leading space, 63 or 128 hex digits
 * decode to the wrong length and have always failed. A deployment running today
 * with a trailing newline in its secret has a working, pinned identity; making
 * that fatal would brick it, and "fixing" the decode (trimming, say) could change
 * which bytes are read and so rotate the CP's identity under every peer that
 * pinned it. So: fatal only where the decode already fails; an accepted-but-not-
 * clean value (anything other than exactly 64 hex digits) gets a boot warning.
 *
 * IT IMPORTS `config` AND NOTHING ELSE, for the same reason as
 * `registry/enrollment-config.ts`: it is loaded from the boot hook, and
 * `cp-agent.ts` imports `aitp`, whose native binding must not sit on the
 * critical path of the HTTP server's existence.
 *
 * NO MESSAGE HERE EVER CARRIES THE SEED. It is the CP's Ed25519 private key
 * material. Messages name the observed length and the decoded byte count, which
 * is what makes them actionable, and nothing more.
 */

import { config } from '../config';

/** Ed25519 seed length `AitpAgent.fromSeed` requires. */
export const CP_SEED_BYTES = 32;

/** The canonical form: exactly 64 hex digits (either case), nothing else. */
const CLEAN_SEED_RE = /^[0-9a-fA-F]{64}$/;

const GENERATE_HINT =
  'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

/**
 * Decode a configured seed exactly as the CP identity always has. Shared with
 * `cp-agent.ts` so the bytes the identity is built from cannot drift from the
 * bytes the boot check judged. Do NOT trim or normalise here: see the module
 * docblock — any change to what this returns can rotate a deployed identity.
 */
export function decodeCpSeedHex(raw: string): Buffer {
  return Buffer.from(raw, 'hex');
}

/**
 * Why this seed is unusable, as one operator-facing sentence — or `null` when
 * the identity can be built from it. Unusable means: absent/empty, or decoding
 * to anything other than 32 bytes (the cases that have always failed).
 */
export function cpSeedProblem(raw: string | undefined): string | null {
  if (!raw) {
    return `CP_AID_SEED_HEX is required (a ${CP_SEED_BYTES}-byte seed as 64 hex characters)`;
  }
  const decoded = decodeCpSeedHex(raw).length;
  if (decoded !== CP_SEED_BYTES) {
    return (
      `CP_AID_SEED_HEX must be 64 hex characters (${CP_SEED_BYTES} bytes); ` +
      `got ${raw.length} characters that decode to ${decoded} bytes ` +
      '(decoding stops at the first non-hex character, so a "0x" prefix or leading ' +
      'whitespace decodes to nothing)'
    );
  }
  return null;
}

/**
 * For a seed `cpSeedProblem` ACCEPTS: a warning when it is not exactly 64 hex
 * digits (trailing whitespace, trailing junk, a 65th digit), else `null`. The
 * value still works and the identity is unchanged — only the first 64 hex
 * digits are ever read — so this never fails a boot. Returns `null` for an
 * unusable seed, which `cpSeedProblem` reports instead.
 */
export function cpSeedNotCleanWarning(raw: string | undefined): string | null {
  if (!raw || cpSeedProblem(raw) !== null || CLEAN_SEED_RE.test(raw)) return null;
  return (
    `[aitp-cp] CP_AID_SEED_HEX is ${raw.length} characters, not exactly 64 hex digits ` +
    '(trailing whitespace or other characters after the seed). It is accepted: only the ' +
    'leading 64 hex digits are read, so the CP identity is unaffected. Store exactly the ' +
    '64 hex digits to silence this warning — the derived AID stays the same.'
  );
}

/** Drops any `user:pass@` part so credentials never reach the log. */
function redactUrl(raw: string): string {
  return raw.replace(/\/\/[^/@\s]*@/, '//');
}

/**
 * Production-only warning for a `CP_BASE_URL` the CP's signed manifest should
 * not advertise: unparseable, not https, or a loopback host (unset defaults to
 * `http://localhost:4000`). Non-fatal: the manifest still builds, and nothing
 * in this service routes on it — but RFC-AITP-0003's manifest schema requires an
 * `https://` `handshake_endpoint`, so peers that validate it will reject the
 * CP's manifest. `null` outside production or when the value looks public.
 */
export function cpBaseUrlBootWarning(): string | null {
  if (!config.isProduction) return null;
  const raw = config.cpBaseUrl;
  let reason: string | null = null;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '0.0.0.0' ||
      host === '::1' ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
    ) {
      reason = 'points at a loopback host';
    } else if (url.protocol !== 'https:') {
      reason = 'is not https';
    }
  } catch {
    reason = 'is not a valid URL';
  }
  if (reason === null) return null;
  return (
    `[aitp-cp] CP_BASE_URL ${reason} (${JSON.stringify(redactUrl(raw))}; unset defaults to ` +
    '"http://localhost:4000"). The CP\'s signed manifest advertises ' +
    '<CP_BASE_URL>/api/aitp/handshake/hello, and the AITP manifest schema requires ' +
    'https://, so peers that validate the manifest will reject it. Set CP_BASE_URL to ' +
    "this deployment's public https origin. Starting anyway: nothing else depends on it."
  );
}

/**
 * What the boot hook should do about the configured seed: `null` when there is
 * nothing to say, otherwise a line to print and whether to die after printing
 * it. Pure policy, separate from acting on it, for the same coverage reason as
 * `enrollmentSecretBootFailure()` (`instrumentation.ts` is excluded).
 *
 * FATAL ONLY IN PRODUCTION, the repo's convention for a required variable.
 * Outside production a missing seed is the documented dev behaviour (a random
 * ephemeral key per boot) and a malformed one fails on first use, as before.
 */
export function cpSeedBootFailure(): { fatal: boolean; message: string } | null {
  const raw = config.cpAidSeedHex;
  const problem = cpSeedProblem(raw);
  if (problem === null) return null;

  const consequence =
    'The CP cannot build its identity, so /.well-known/aitp-manifest, ' +
    '/api/revocation/list and /api/health would fail on every request.';

  if (config.isProduction) {
    return {
      fatal: true,
      message:
        `[aitp-cp] FATAL: ${problem} — ${consequence} ` +
        'Refusing to start rather than serving a deployment without a stable identity. ' +
        `Set CP_AID_SEED_HEX and redeploy. ${GENERATE_HINT}`,
    };
  }
  return {
    fatal: false,
    message: !raw
      ? `[aitp-cp] CP_AID_SEED_HEX is not set — using an ephemeral key, so the CP AID ` +
        'changes on every restart. Starting anyway because NODE_ENV is not production; ' +
        'a production boot with this configuration exits non-zero instead.'
      : `[aitp-cp] ${problem} — ${consequence} Starting anyway because NODE_ENV is not ` +
        'production; a production boot with this configuration exits non-zero instead.',
  };
}

/**
 * Apply the seed policy at boot: print, and exit 1 if fatal; then print any
 * non-fatal warnings (a not-clean seed, a production `CP_BASE_URL` the manifest
 * should not advertise).
 *
 * Called once per server boot from `src/instrumentation.ts`'s `register()`,
 * right after `enforceEnrollmentSecretAtBoot()`. Nothing else may call it — it
 * can end the process. It lives here rather than in `instrumentation.ts` for the
 * reasons spelled out on `enforceEnrollmentSecretAtBoot` (no `process.exit` in
 * the Edge-compiled file; coverage). `console.*` rather than pino, same reason.
 */
export function enforceCpSeedAtBoot(): void {
  const failure = cpSeedBootFailure();
  if (failure !== null) {
    // if/else rather than relying on `process.exit` never returning: a test
    // mocks it, and the fatal line must not then also appear at warn level.
    if (failure.fatal) {
      // eslint-disable-next-line no-console
      console.error(failure.message);
      process.exit(1);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(failure.message);
  }

  const warnings = [cpSeedNotCleanWarning(config.cpAidSeedHex), cpBaseUrlBootWarning()];
  for (const warning of warnings) {
    if (warning !== null) {
      // eslint-disable-next-line no-console
      console.warn(warning);
    }
  }
}
