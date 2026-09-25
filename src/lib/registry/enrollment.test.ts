import { AitpAgent } from 'aitp';
import { EnrollmentService } from './enrollment';
import { sdkVerifyCode } from './verify-error';

describe('EnrollmentService', () => {
  const secret = 'unit-test-secret-key-padded-to-pass-min-length-check';
  const service = new EnrollmentService(secret);

  function buildManifest(): string {
    const agent = AitpAgent.generate();
    return agent.buildManifest({
      displayName: 'unit-test-agent',
      handshakeEndpoint: 'https://agent.example.com/handshake',
      offeredCaps: ['demo.echo'],
      ttlSecs: 3600,
    });
  }

  it('mints a token for a valid manifest and validates it back', () => {
    const manifest = buildManifest();
    const { token, expiresIn, aid } = service.verifyAndIssueToken(manifest);
    expect(aid).toMatch(/^aid:pubkey:/);
    expect(expiresIn).toBe(300);
    expect(() => service.validateToken(token, aid)).not.toThrow();
  });

  it('rejects an invalid manifest envelope', () => {
    // Asserts .code is a string — the contract package.json's "//aitp"
    // block (0.7.0 entry) documents for exactly this path, where
    // enrollment.ts:55 calls verifyManifestJson on externally-supplied
    // input — without pinning its current value ("malformed"). A future
    // release may reclassify an unknown top-level field like `bogus` from
    // `malformed` to `unknown_field` (see the UNKNOWN_FIELD batch tracked in
    // plans/aitp-rs-breaking-changes-adoption.md); pinning today's value
    // would manufacture a failure out of that improvement.
    let threw = false;
    try {
      service.verifyAndIssueToken('{"manifest":{"bogus":true}}');
    } catch (err) {
      threw = true;
      expect(typeof (err as { code?: unknown }).code).toBe('string');
    }
    expect(threw).toBe(true);

    expect(() => service.verifyAndIssueToken('not json at all')).toThrow();
  });

  it('exposes the real SDK failure code through sdkVerifyCode', () => {
    // The one assertion in the suite that would catch the SDK moving its
    // `.code` property: everything downstream of sdkVerifyCode is mocked,
    // so without this a rename would silently degrade the public
    // `verifyCode` field to "absent" in production rather than fail here.
    // Asserts the *shape* (a non-empty string), never today's value — see
    // the forward-compat note above.
    let threw = false;
    let caught: unknown;
    try {
      service.verifyAndIssueToken('{"manifest":{"bogus":true}}');
    } catch (err) {
      threw = true;
      caught = err;
    }
    expect(threw).toBe(true);
    // Deliberately asserts ONLY the code, never the error's type. Two
    // reasons, the second measured rather than assumed:
    //
    //  1. Only `.code` is the contract. A future SDK that threw a plain
    //     object carrying `.code` would keep production working, so pinning
    //     the type here would manufacture a failure out of a non-breakage.
    //
    //  2. `expect(caught).toBeInstanceOf(Error)` FAILS in this suite — with
    //     the baffling "Expected constructor: Error / Received constructor:
    //     Error". That is a *Jest* artifact, not an SDK one:
    //     `jest-environment-node` runs the test file in a vm context with
    //     its own `Error` global, so the cross-realm `instanceof` is false.
    //     Measured under plain `node` (no Jest), the SDK's error IS a real
    //     native Error — `instanceof Error`, `isNativeError` and
    //     `Object.getPrototypeOf(e) === Error.prototype` are all true. So
    //     `route.ts`'s `err instanceof Error ? err.message : String(err)`
    //     is correct in production and must not be "fixed".
    const code = sdkVerifyCode(caught);
    expect(typeof code).toBe('string');
    expect(code).not.toBe('');
  });

  it('rejects a token signed with a different secret', () => {
    const manifest = buildManifest();
    const other = new EnrollmentService(
      'a-different-secret-also-padded-to-min-length-bound',
    );
    const { token, aid } = service.verifyAndIssueToken(manifest);
    expect(() => other.validateToken(token, aid)).toThrow(/signature/);
  });

  it('rejects a token whose sub does not match the manifest aid', () => {
    const manifest = buildManifest();
    const { token } = service.verifyAndIssueToken(manifest);
    expect(() =>
      service.validateToken(token, 'aid:pubkey:someone-else'),
    ).toThrow(/does not match/);
  });

  it('rejects a malformed token', () => {
    expect(() => service.validateToken('no-dot-here', 'aid:x')).toThrow();
  });

  it('rejects a token past its expiry', () => {
    const manifest = buildManifest();
    const { token, aid, expiresIn } = service.verifyAndIssueToken(manifest);
    // Jump the clock past the token's lifetime; the signature stays valid,
    // so this isolates the expiry check specifically.
    const realNow = Date.now();
    const spy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(realNow + (expiresIn + 60) * 1000);
    try {
      expect(() => service.validateToken(token, aid)).toThrow(/expired/);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a manifest whose TTL falls inside the 5-minute registration guard', () => {
    const agent = AitpAgent.generate();
    const shortLived = agent.buildManifest({
      displayName: 'short-ttl-agent',
      handshakeEndpoint: 'https://agent.example.com/handshake',
      offeredCaps: ['demo.echo'],
      ttlSecs: 60, // expires before the 5-minute guard window
    });
    expect(() => service.verifyAndIssueToken(shortLived)).toThrow(/longer TTL/);
  });

  it('refuses to construct with a sub-32-char secret', () => {
    expect(() => new EnrollmentService('too-short')).toThrow(/at least 32/);
  });
});
