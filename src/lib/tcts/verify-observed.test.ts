import { AitpAgent } from 'aitp';
import {
  decideProjection,
  verifyObservedDelegation,
  verifyObservedTct,
  type VerificationOutcome,
} from './verify-observed';
import { parseTct } from './monitor';

const OK: VerificationOutcome = { attempted: true, verified: true, error: null };
const BAD: VerificationOutcome = { attempted: true, verified: false, error: 'boom' };
const NONE: VerificationOutcome = { attempted: false, verified: false, error: 'no signed token to verify' };

describe('decideProjection', () => {
  it('off: always projects and never reports', () => {
    for (const o of [OK, BAD, NONE]) {
      expect(decideProjection('off', o)).toEqual({ project: true, error: null });
    }
  });

  it('warn: always projects; only an attempted failure is reported', () => {
    expect(decideProjection('warn', OK)).toEqual({ project: true, error: null });
    expect(decideProjection('warn', NONE)).toEqual({ project: true, error: null });
    expect(decideProjection('warn', BAD)).toEqual({ project: true, error: 'boom' });
  });

  it('strict: projects only a verified report', () => {
    expect(decideProjection('strict', OK)).toEqual({ project: true, error: null });
    expect(decideProjection('strict', BAD)).toEqual({ project: false, error: 'boom' });
    expect(decideProjection('strict', NONE)).toEqual({
      project: false,
      error: 'no signed token to verify',
    });
  });
});

// Real SDK tokens: A handshakes with B (B issues A a TCT + grant voucher), then
// A delegates to C. Nothing is mocked, so these also pin the verifier-AID
// semantics of verifyDelegation (the delegation's own `aud`, not the delegatee).
function fixture() {
  const opts = (n: string) => ({
    displayName: n,
    handshakeEndpoint: `https://${n}.example/h`,
    offeredCaps: ['demo.echo'],
    ttlSecs: 3600,
  });
  const a = AitpAgent.generate();
  const b = AitpAgent.generate();
  const c = AitpAgent.generate();
  a.buildManifest(opts('a'));
  const manifestB = b.buildManifest(opts('b'));
  const initiator = a.newSession();
  const responder = b.newResponder();
  const hello = responder.processHello(initiator.buildHello(manifestB, ['demo.echo']));
  const commit = initiator.processHelloAck(hello.ackJson, hello.sessionId);
  const committed = responder.processCommit(commit);
  const done = initiator.complete(committed.ackJson);
  const delegation = a.buildDelegation(done.grantVoucher!, c.aid, ['demo.echo'], 600);
  const dClaims = JSON.parse(
    Buffer.from(delegation.split('.')[1], 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  return { done, delegation, dClaims };
}

function tamper(jws: string): string {
  const [h, p, s] = jws.split('.');
  const flipped = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  return `${h}.${p}.${flipped}`;
}

describe('verifyObservedTct', () => {
  const { done } = fixture();
  const wrapper = { token: done.tct, claims: done.claims };
  const parsed = parseTct(wrapper, new Date().toISOString())!;

  it('verifies a genuine reported TCT', () => {
    expect(verifyObservedTct(wrapper, parsed)).toEqual(OK);
  });

  it('fails a TCT whose signature was altered', () => {
    const out = verifyObservedTct({ ...wrapper, token: tamper(done.tct) }, parsed);
    expect(out.attempted).toBe(true);
    expect(out.verified).toBe(false);
    expect(typeof out.error).toBe('string');
  });

  it('does not attempt a claims-only report', () => {
    const out = verifyObservedTct(done.claims, parsed);
    expect(out.attempted).toBe(false);
  });

  it('fails (does not throw) when the reported grants are empty', () => {
    const out = verifyObservedTct(wrapper, { ...parsed, grants: [] });
    expect(out).toMatchObject({ attempted: true, verified: false });
  });
});

describe('verifyObservedDelegation', () => {
  const { delegation, dClaims } = fixture();
  const payload = { delegation: { token: delegation, claims: dClaims } };

  it('verifies a genuine reported delegation', () => {
    expect(verifyObservedDelegation(payload)).toEqual(OK);
  });

  it('accepts the wrapper under payload.tct as well', () => {
    expect(verifyObservedDelegation({ tct: payload.delegation })).toEqual(OK);
  });

  it('fails a delegation whose signature was altered', () => {
    const out = verifyObservedDelegation({
      delegation: { token: tamper(delegation), claims: dClaims },
    });
    expect(out).toMatchObject({ attempted: true, verified: false });
  });

  it('fails when the claims carry no aud', () => {
    const { aud: _aud, ...rest } = dClaims;
    void _aud;
    const out = verifyObservedDelegation({
      delegation: { token: delegation, claims: rest },
    });
    expect(out).toMatchObject({ attempted: true, verified: false });
  });

  it('does not attempt a report without a token', () => {
    expect(verifyObservedDelegation({ delegation: { claims: dClaims } }).attempted).toBe(false);
  });
});
