import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { verifyManifestJson } from 'aitp';
import { config } from '../config';

// Same 5-min guard as src/app/api/registry/agents/route.ts so callers
// don't enroll a manifest that the immediately-following register call
// would silently reject. Single source of truth here.
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
    if (!raw) {
      throw new Error('ENROLLMENT_SECRET is required');
    }
    if (raw.length < 32) {
      throw new Error(
        `ENROLLMENT_SECRET must be at least 32 characters (got ${raw.length}). ` +
          'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
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
    verifyManifestJson(manifestEnvelopeJson);

    const envelope = JSON.parse(manifestEnvelopeJson) as {
      manifest: { aid: string; expires_at?: number };
    };
    const manifest = envelope.manifest;
    const aid = manifest.aid;
    if (typeof aid !== 'string' || !aid.startsWith('aid:')) {
      throw new Error('manifest.aid missing or not an AID string');
    }
    if (typeof manifest.expires_at === 'number') {
      const expiresMs = manifest.expires_at * 1000;
      if (expiresMs < Date.now() + REGISTRATION_EXPIRY_GUARD_MS) {
        throw new Error(
          'manifest expires_at is in the past or within 5 minutes — re-issue with a longer TTL',
        );
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const payload: EnrollmentPayload = {
      sub: aid,
      scope: 'register',
      iat: now,
      exp: now + TOKEN_LIFETIME_SECS,
      jti: randomUUID(),
    };
    return { token: this.sign(payload), expiresIn: TOKEN_LIFETIME_SECS, aid };
  }

  validateToken(token: string, expectedAid: string): void {
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
