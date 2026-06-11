import { AitpAgent } from 'aitp';
import { EnrollmentService } from './enrollment';

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
    expect(() =>
      service.verifyAndIssueToken('{"manifest":{"bogus":true}}'),
    ).toThrow();
    expect(() => service.verifyAndIssueToken('not json at all')).toThrow();
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
