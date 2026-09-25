// Unit tests for the two rejections EnrollmentService makes ITSELF, after
// the SDK has already accepted a manifest:
//   • `manifest.aid` missing, non-string, or not `aid:`-prefixed
//   • `expires_at` inside the 5-minute registration guard
//
// Both must throw ManifestRejectedError with cpCode MANIFEST_INVALID and
// their exact existing messages — the route turns cpCode straight into the
// response `code`, so a typo here ships an undocumented code to clients.
//
// WHY THIS FILE EXISTS SEPARATELY, AND WHY IT MOCKS THE SDK.
// `verifyAndIssueToken` calls `verifyManifestJson` first, and the signature
// covers the aid — so a tampered aid is rejected by the SDK before our guard
// is ever reached, and `AitpAgent` only ever mints `aid:`-prefixed AIDs.
// The aid guard is therefore UNREACHABLE through a real signed manifest
// (asserted in enrollment.test.ts). Stubbing verification to a no-op is the
// only way to drive these guards directly, and without it the aid guard has
// no test at all: reverting it to a bare `new Error` passes the entire suite.
//
// enrollment.test.ts keeps the real SDK and must stay that way — it holds the
// forward-compat guard that watches the SDK's `.code` contract. Mocking `aitp`
// there would disarm it, which is why this is a separate file.

import { jest } from '@jest/globals';

const verifyManifestJsonMock = jest.fn((_json: string): void => {});

jest.mock('aitp', () => ({
  verifyManifestJson: (json: string) => verifyManifestJsonMock(json),
}));

import { EnrollmentService } from './enrollment';
import { ManifestRejectedError, sdkVerifyCode } from './verify-error';

const SECRET = 'guard-test-secret-padded-well-past-the-32-char-minimum';
const service = new EnrollmentService(SECRET);

const AID_MESSAGE = 'manifest.aid missing or not an AID string';
const EXPIRY_MESSAGE =
  'manifest expires_at is in the past or within 5 minutes — re-issue with a longer TTL';

function envelope(manifest: Record<string, unknown>): string {
  return JSON.stringify({ manifest });
}

/** Returns what `fn` threw, or throws if it did not throw at all. */
function captureThrow(fn: () => unknown): unknown {
  let threw = false;
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    threw = true;
    caught = err;
  }
  if (!threw) throw new Error('expected the call to throw, but it returned');
  return caught;
}

beforeEach(() => {
  verifyManifestJsonMock.mockReset();
});

describe('EnrollmentService guards (SDK verification stubbed to a no-op)', () => {
  it('confirms the stub really is bypassing verification', () => {
    // Non-vacuity: if this envelope minted a token, the stub is in effect and
    // the rejections below are genuinely OUR guards firing, not the SDK's.
    const far = Math.floor(Date.now() / 1000) + 3600;
    const result = service.verifyAndIssueToken(
      envelope({ aid: 'aid:pubkey:z:stub', expires_at: far }),
    );
    expect(result.aid).toBe('aid:pubkey:z:stub');
    expect(verifyManifestJsonMock).toHaveBeenCalledTimes(1);
  });

  describe('the aid guard', () => {
    it.each([
      ['absent', {}],
      ['not a string', { aid: 42 }],
      ['null', { aid: null }],
      ['a DID rather than an AID', { aid: 'did:pubkey:z:abc' }],
      ['an empty string', { aid: '' }],
      ['prefixed with something else', { aid: 'urn:aid:pubkey:z:abc' }],
    ])('rejects a manifest whose aid is %s', (_label, manifest) => {
      const far = Math.floor(Date.now() / 1000) + 3600;
      const err = captureThrow(() =>
        service.verifyAndIssueToken(envelope({ ...manifest, expires_at: far })),
      );
      expect(err).toBeInstanceOf(ManifestRejectedError);
      expect((err as ManifestRejectedError).cpCode).toBe('MANIFEST_INVALID');
      expect((err as ManifestRejectedError).message).toBe(AID_MESSAGE);
      // Ours, never mistakable for the SDK's.
      expect(sdkVerifyCode(err)).toBeUndefined();
    });

    it('accepts an `aid:`-prefixed aid', () => {
      const far = Math.floor(Date.now() / 1000) + 3600;
      expect(() =>
        service.verifyAndIssueToken(
          envelope({ aid: 'aid:pubkey:z:ok', expires_at: far }),
        ),
      ).not.toThrow();
    });
  });

  describe('the 5-minute registration guard', () => {
    it('rejects a manifest expiring inside the window', () => {
      const soon = Math.floor(Date.now() / 1000) + 60;
      const err = captureThrow(() =>
        service.verifyAndIssueToken(
          envelope({ aid: 'aid:pubkey:z:ok', expires_at: soon }),
        ),
      );
      expect(err).toBeInstanceOf(ManifestRejectedError);
      expect((err as ManifestRejectedError).cpCode).toBe('MANIFEST_INVALID');
      expect((err as ManifestRejectedError).message).toBe(EXPIRY_MESSAGE);
      expect(sdkVerifyCode(err)).toBeUndefined();
    });

    it('rejects a manifest already past expires_at', () => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      const err = captureThrow(() =>
        service.verifyAndIssueToken(
          envelope({ aid: 'aid:pubkey:z:ok', expires_at: past }),
        ),
      );
      expect((err as ManifestRejectedError).cpCode).toBe('MANIFEST_INVALID');
    });

    it('rejects `expires_at: 0`, which is inside the window by any reading', () => {
      // enrollment.ts guards on `typeof === 'number'`, so 0 is checked;
      // agents/route.ts uses `if (manifest.expires_at)`, so it treats 0 as
      // absent and accepts. That divergence is real and out of scope here —
      // pinned so a future reader sees which side this file is on.
      const err = captureThrow(() =>
        service.verifyAndIssueToken(
          envelope({ aid: 'aid:pubkey:z:ok', expires_at: 0 }),
        ),
      );
      expect(err).toBeInstanceOf(ManifestRejectedError);
    });

    it('accepts a manifest with no expires_at at all', () => {
      expect(() =>
        service.verifyAndIssueToken(envelope({ aid: 'aid:pubkey:z:ok' })),
      ).not.toThrow();
    });

    it('accepts a manifest expiring comfortably outside the window', () => {
      const far = Math.floor(Date.now() / 1000) + 3600;
      expect(() =>
        service.verifyAndIssueToken(
          envelope({ aid: 'aid:pubkey:z:ok', expires_at: far }),
        ),
      ).not.toThrow();
    });
  });

  it('checks the aid before the expiry, so a doubly-bad manifest reports the aid', () => {
    const soon = Math.floor(Date.now() / 1000) + 60;
    const err = captureThrow(() =>
      service.verifyAndIssueToken(envelope({ aid: 'nope', expires_at: soon })),
    );
    expect((err as ManifestRejectedError).message).toBe(AID_MESSAGE);
  });
});
