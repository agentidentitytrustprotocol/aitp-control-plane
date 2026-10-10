import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { verifyManifestJson } from 'aitp';
import { config } from '../config';
import { assertEnrollmentSecretUsable } from './enrollment-config';
import { checkManifestColumns } from './manifest-columns';
import { ManifestRejectedError, markSdkVerifyFailure } from './verify-error';

// Same 5-min window as src/app/api/registry/agents/route.ts, so a caller does
// not enroll a manifest that the immediately-following register call would
// reject after a round trip. Both routes also return the same code
// (MANIFEST_EXPIRED) and the same message, which src/e2e/flow.integration.test.ts
// asserts across the two routes.
//
// NOT a single source of truth, despite what this comment used to claim:
// agents/route.ts declares its own copy of this constant and inlines its own
// copy of the code and message, and the two implementations genuinely disagree
// on `expires_at: 0` (guarded here via `typeof === 'number'`, treated as absent
// there via `if (manifest.expires_at)`). This side of that divergence is pinned
// in enrollment-guards.test.ts and both sides are documented in docs/api.md.
// agents/route.ts's guard IS asserted for its code and message (agents.test.ts,
// and cross-route in flow.integration.test.ts) — what nothing asserts is its
// handling of `expires_at: 0`, so a change to that side would go unnoticed.
// De-duplicating the guard is its own change, tracked as an open question on the
// #69 plan.
const REGISTRATION_EXPIRY_GUARD_MS = 5 * 60 * 1000;

// Enrollment tokens are short-lived bearer credentials. The lifetime is
// deliberately tight: the only thing they unlock is a one-shot
// `POST /api/registry/agents` for the matching aid. If you raise this,
// also re-check that the manifest expiry guard above still covers it.
const TOKEN_LIFETIME_SECS = 300;

interface EnrollmentPayload {
  sub: string;
  scope: 'register';
  iat: number;
  exp: number;
  jti: string;
  /** SHA-256 (hex) of the exact ManifestEnvelope bytes verified at enrollment.
   * Registration recomputes it over its own body and requires a match, so a
   * token cannot be replayed against a different manifest for the same aid. */
  msh: string;
}

/** SHA-256 hex digest of the exact ManifestEnvelope body bytes (UTF-8). */
export function manifestDigest(manifestEnvelopeJson: string): string {
  return createHash('sha256').update(manifestEnvelopeJson, 'utf8').digest('hex');
}

export interface EnrollmentResult {
  token: string;
  expiresIn: number;
  aid: string;
}

export class EnrollmentService {
  private readonly secret: Buffer;

  constructor(secret?: string) {
    const raw = secret ?? config.enrollmentSecret;
    // ONE throw site, throwing ONE class: `EnrollmentConfigError`, from
    // `enrollment-config.ts`, which also owns the rule, both messages, and the
    // reasoning for all of it (including why the two registry routes no longer
    // count throw sites in this file).
    //
    // What matters HERE: a configuration fault is `EnrollmentConfigError` and
    // both routes turn it into a 503; anything else thrown in this constructor is
    // an internal fault and must propagate as a 500. A throw added here picks one
    // of those two sides, and picking wrongly is visible rather than silent.
    assertEnrollmentSecretUsable(raw);
    this.secret = Buffer.from(raw);
  }

  /** Verify a ManifestEnvelope (via the Rust binding) and mint a
   * short-lived bearer token that POST /api/registry/agents will accept.
   *
   * Mirrors the registration-time 5-minute expiry guard so a manifest
   * with a TTL shorter than the token's own lifetime is rejected here
   * (clearer error than the same rejection at register-time after a
   * round-trip). */
  verifyAndIssueToken(manifestEnvelopeJson: string): EnrollmentResult {
    // The try is around this ONE call, and the mark is applied here, because
    // this is the only frame that can honestly say "the SDK's verifier is what
    // rejected this manifest". Both halves of issue #102's fix are that narrow:
    //
    //  - Provenance is ASSERTED, not sniffed. `sdkVerifyCode` answers only for a
    //    value marked here, so nothing else that merely happens to carry a
    //    string `.code` can be published to a caller as a `verifyCode`.
    //  - The region that can produce a manifest verdict is narrowed to exactly
    //    this call. Everything below it — the two `ManifestRejectedError`
    //    guards, and `randomUUID`/`Buffer.from`/`createHmac` in the minting tail
    //    — is outside that region by construction, not because the route
    //    remembers to keep its statements in a careful order. That was the
    //    other fix issue #102 proposed, and doing it here rather than by
    //    splitting this method gets it without changing a public API.
    //
    // The error propagates UNTOUCHED: the mark is an entry in a WeakSet, not a
    // property, so `enrollment.test.ts`'s forward-compat guard still reads
    // `.code` off the object the SDK actually threw, and the route still echoes
    // the SDK's own message. Wrapping would have cost both.
    //
    // A future second call site of `verifyManifestJson` must mark too; see
    // `markSdkVerifyFailure` for what forgetting costs and why it is loud.
    try {
      verifyManifestJson(manifestEnvelopeJson);
    } catch (err) {
      markSdkVerifyFailure(err);
      throw err;
    }

    const envelope = JSON.parse(manifestEnvelopeJson) as {
      manifest: { aid: string; expires_at?: number };
    };
    const manifest = envelope.manifest;
    const aid = manifest.aid;
    // These two rejections are OURS, not the SDK's — the SDK has already
    // accepted the manifest by this point. They throw ManifestRejectedError
    // so the route can tell "the caller's manifest is bad" from "this service
    // is broken" positively, rather than inferring it from the absence of a
    // `.code` (which is equally true of a genuine internal error). `cpCode`
    // becomes the response `code`, but only after the route checks it against
    // its own allowlist — so a typo here does not ship an undocumented code, it
    // silently downgrades this rejection to MANIFEST_INVALID. That is the safe
    // failure, and it is also a silent one, which is why both values are pinned
    // byte-for-byte by tests rather than left to the allowlist to catch.
    if (typeof aid !== 'string' || !aid.startsWith('aid:')) {
      throw new ManifestRejectedError(
        'manifest.aid missing or not an AID string',
        'MANIFEST_INVALID',
      );
    }
    if (typeof manifest.expires_at === 'number') {
      const expiresMs = manifest.expires_at * 1000;
      if (expiresMs < Date.now() + REGISTRATION_EXPIRY_GUARD_MS) {
        // MANIFEST_EXPIRED, not MANIFEST_INVALID: the sibling route
        // (`src/app/api/registry/agents/route.ts`) has always returned
        // MANIFEST_EXPIRED for this identical condition with this
        // byte-identical message. Two routes, one condition, one message and
        // two different codes made the same rejection machine-detectable on
        // register and prose-only on enroll — which is the whole defect #69
        // describes, one field over. The message is deliberately unchanged, so
        // status-only and substring-matching clients are unaffected; only an
        // exact `code === 'MANIFEST_INVALID'` match on this one condition is.
        throw new ManifestRejectedError(
          'manifest expires_at is in the past or within 5 minutes — re-issue with a longer TTL',
          'MANIFEST_EXPIRED',
        );
      }
    }
    // A manifest the `agents` row cannot hold (a `display_name` over 256
    // characters, a NUL in a stored string, ...) verifies fine, and minting a
    // token for it only moved the failure to registration — where it burned
    // the token's `jti` and answered 500. Rejected here, before the token
    // exists. MANIFEST_INVALID like the aid guard above: the SDK accepted it,
    // we did not, and the route counts it under the `none` metric label.
    const columnProblem = checkManifestColumns(manifest);
    if (columnProblem !== null) {
      throw new ManifestRejectedError(columnProblem, 'MANIFEST_INVALID');
    }
    const now = Math.floor(Date.now() / 1000);
    const payload: EnrollmentPayload = {
      sub: aid,
      scope: 'register',
      iat: now,
      exp: now + TOKEN_LIFETIME_SECS,
      jti: randomUUID(),
      msh: manifestDigest(manifestEnvelopeJson),
    };
    return { token: this.sign(payload), expiresIn: TOKEN_LIFETIME_SECS, aid };
  }

  /** Verify the token's signature, scope, expiry, subject binding, and that it
   * is bound to `manifestEnvelopeJson` (the exact request-body bytes) via the
   * `msh` claim. A token without a string `msh` (minted before this binding
   * existed) is rejected, not waved through: there is no safe way to tell a
   * legitimately old token from a stripped one, and they live 5 minutes.
   * Returns the validated payload so the caller can atomically consume
   * the `jti` (one-time-token enforcement — see `consumeEnrollmentJti`).
   * Throws on any failure. */
  validateToken(
    token: string,
    expectedAid: string,
    manifestEnvelopeJson: string,
  ): EnrollmentPayload {
    const payload = this.verify(token);
    if (payload.scope !== 'register') {
      throw new Error('token scope must be register');
    }
    if (Math.floor(Date.now() / 1000) > payload.exp) {
      throw new Error('enrollment token expired');
    }
    if (payload.sub !== expectedAid) {
      throw new Error(
        `token sub ${payload.sub} does not match manifest aid ${expectedAid}`,
      );
    }
    if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
      throw new Error('enrollment token missing jti');
    }
    if (typeof payload.msh !== 'string' || payload.msh.length === 0) {
      throw new Error(
        'enrollment token is not bound to a manifest — re-enroll to get a new token',
      );
    }
    if (payload.msh !== manifestDigest(manifestEnvelopeJson)) {
      throw new Error(
        'enrollment token was issued for a different manifest than the one submitted',
      );
    }
    return payload;
  }

  private sign(payload: EnrollmentPayload): string {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', this.secret)
      .update(data)
      .digest('base64url');
    return `${data}.${sig}`;
  }

  private verify(token: string): EnrollmentPayload {
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('malformed enrollment token');
    const [data, sig] = parts;
    if (!data || !sig || !BASE64URL_RE.test(data) || !BASE64URL_RE.test(sig)) {
      throw new Error('malformed enrollment token');
    }
    const expected = createHmac('sha256', this.secret)
      .update(data)
      .digest('base64url');
    // Both are ASCII (base64url alphabet), so byte-length === char-length.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error('token signature invalid');
    }
    try {
      const decoded = Buffer.from(data, 'base64url').toString('utf8');
      return JSON.parse(decoded) as EnrollmentPayload;
    } catch {
      throw new Error('token payload is not valid JSON');
    }
  }
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

declare global {
  // eslint-disable-next-line no-var
  var __enrollment: EnrollmentService | undefined;
}

export function getEnrollmentService(): EnrollmentService {
  if (!globalThis.__enrollment) {
    globalThis.__enrollment = new EnrollmentService();
  }
  return globalThis.__enrollment;
}
