/**
 * Optional cryptographic verification of REPORTED TCT / delegation telemetry.
 *
 * The CP is an observer: agents report what happened and the monitor projects
 * it. When a report carries the full signed token (the v0.2 `{ token, claims }`
 * wrapper) the CP can check it with the SDK instead of trusting the claims.
 * Governed by `OBSERVED_ARTIFACT_VERIFICATION` (off|warn|strict); see
 * {@link decideProjection} and `config.ts`.
 *
 * Verification never throws: any failure (including an uninitialised CP
 * identity) is captured as a failed outcome so projection cannot crash.
 *
 * What a pass means: the token's signature, expiry, and (for a TCT) its
 * grant/audience check out under the key encoded in the issuer AID. It does NOT
 * consult the revocation list, and an expired token fails -- so a late report
 * of a TCT that has since expired is dropped in strict mode.
 */

import { verifyDelegation } from 'aitp';
import { getCpAgent } from '../identity/cp-agent';
import type { ParsedTct } from './monitor';

export type VerificationMode = 'off' | 'warn' | 'strict';

export interface VerificationOutcome {
  /** Whether a signed token was present and verification was attempted. */
  attempted: boolean;
  /** True only if attempted and the SDK accepted the token. */
  verified: boolean;
  /** Failure reason when !verified (for a not-attempted report: why). */
  error: string | null;
}

export interface ProjectionDecision {
  /** Whether to project the row at all. */
  project: boolean;
  /** Reason worth logging, or null when there is nothing to report. */
  error: string | null;
}

const NO_TOKEN: VerificationOutcome = {
  attempted: false,
  verified: false,
  error: 'no signed token to verify',
};

/**
 * Pure policy. `off`: always project, nothing to say. `warn`: always project;
 * surface an attempted-and-failed verification. `strict`: project only when
 * verification was attempted and passed.
 */
export function decideProjection(
  mode: VerificationMode,
  outcome: VerificationOutcome,
): ProjectionDecision {
  if (mode === 'off') return { project: true, error: null };
  if (mode === 'strict') {
    return outcome.attempted && outcome.verified
      ? { project: true, error: null }
      : { project: false, error: outcome.error ?? 'verification failed' };
  }
  // warn: a report with no token is normal telemetry, not a failure.
  return {
    project: true,
    error: outcome.attempted && !outcome.verified ? outcome.error : null,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** The compact-JWS `token` of a v0.2 `{ token, claims }` wrapper, if any. */
function wrapperToken(wrapper: unknown): string | null {
  if (!isRecord(wrapper)) return null;
  const t = wrapper.token;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

function failure(err: unknown): VerificationOutcome {
  return {
    attempted: true,
    verified: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Verify one reported TCT (`raw` is the reported entry, `parsed` its projection).
 * The audience is the TCT's own `aud` (== `sub` in v0.2) and the required grant
 * is its first grant, so those checks are tautological and the signal is
 * signature + expiry. A TCT with no grants cannot be checked.
 */
export function verifyObservedTct(raw: unknown, parsed: ParsedTct): VerificationOutcome {
  const token = wrapperToken(raw);
  if (!token) return NO_TOKEN;
  if (parsed.grants.length === 0) {
    return {
      attempted: true,
      verified: false,
      error: 'cannot verify: TCT carries no grant to check',
    };
  }
  try {
    getCpAgent().verifyTct(token, parsed.grants[0], parsed.audienceAid);
    return { attempted: true, verified: true, error: null };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Verify a reported `delegation.issued` payload. SDK `verifyDelegation` takes
 * the verifier AID that MUST equal the delegation's `aud` (the root grantor)
 * and checks the embedded voucher under that AID's key, so we pass the token's
 * own `aud`. Multi-hop chains are rejected by the strict single-hop verifier
 * and therefore fail verification here.
 */
export function verifyObservedDelegation(
  payload: Record<string, unknown>,
): VerificationOutcome {
  const wrapper = payload.tct ?? payload.delegation;
  const token = wrapperToken(wrapper);
  if (!token) return NO_TOKEN;
  const claims =
    isRecord(wrapper) && isRecord(wrapper.claims) ? wrapper.claims : undefined;
  const aud = claims?.aud;
  if (typeof aud !== 'string' || aud.length === 0) {
    return {
      attempted: true,
      verified: false,
      error: 'cannot verify: delegation claims carry no aud',
    };
  }
  try {
    verifyDelegation(token, aud);
    return { attempted: true, verified: true, error: null };
  } catch (err) {
    return failure(err);
  }
}
