import { createHash } from 'node:crypto';
import { canonicalJson, eventIdFor, parseEventTimestamp } from './event-id';

describe('canonicalJson', () => {
  it('sorts keys at every level and writes no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('matches JSON.stringify for key-sorted input', () => {
    const v = { a: 'x"\\\n ', b: [true, false, 1.5, -0, 1e21, ''], c: {}, d: [] };
    expect(canonicalJson(v)).toBe(JSON.stringify(v));
  });

  it('escapes lone surrogates, so distinct strings never collide after UTF-8 encoding', () => {
    expect(canonicalJson('\ud800')).not.toBe(canonicalJson('\ud801'));
  });

  it('handles 200k levels of nesting without recursion', () => {
    const depth = 200_000;
    const value = JSON.parse(`${'['.repeat(depth)}${']'.repeat(depth)}`);
    expect(canonicalJson(value)).toHaveLength(depth * 2);
  });
});

describe('parseEventTimestamp', () => {
  it.each([
    ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z'],
    [1_700_000_000, new Date(1_700_000_000_000).toISOString()],
    [1_700_000_000_000, new Date(1_700_000_000_000).toISOString()],
  ])('accepts %p', (raw, iso) => {
    expect(parseEventTimestamp(raw)).toBe(iso);
  });

  it.each([undefined, null, 'nope', 1e20, Number.NaN, '+010000-01-01T00:00:00Z', {}])(
    'rejects %p',
    (raw) => {
      expect(parseEventTimestamp(raw)).toBeNull();
    },
  );
});

describe('eventIdFor (recipe v2)', () => {
  const ev = { type: 't', ts: '2026-01-01T00:00:00Z', payload: { a: 1 } };

  it('is the documented recipe: v8 UUID over SHA-256 of tag, producer key, canonical JSON', () => {
    const digest = createHash('sha256')
      .update(`aitp-event:v2\0apikey:0123456789abcdef\0${canonicalJson(ev, { signedContent: true })}`)
      .digest();
    const b = Buffer.from(digest.subarray(0, 16));
    b[6] = (b[6] & 0x0f) | 0x80;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = b.toString('hex');
    const expected = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    expect(eventIdFor(ev, 'apikey:0123456789abcdef')).toBe(expected);
    expect(expected[14]).toBe('8');
    expect('89ab').toContain(expected[19]);
  });

  it('is stable, key-order independent, and producer-scoped', () => {
    const reordered = { payload: { a: 1 }, ts: '2026-01-01T00:00:00Z', type: 't' };
    expect(eventIdFor(ev, 'k')).toBe(eventIdFor(reordered, 'k'));
    expect(eventIdFor(ev, 'k')).not.toBe(eventIdFor(ev, 'j'));
    expect(eventIdFor(ev, null)).toBe(eventIdFor(ev, null));
  });

  // RFC-AITP-0001 §5.4.3: never key dedup on a signed object's raw bytes.
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${b64({ alg: 'EdDSA', typ: 'aitp-tct+jwt' })}.${b64({ jti: 'x', iss: 'a' })}`;

  it('keys an embedded compact JWS on its signing input, not its signature', () => {
    const at = (sig: string) => ({
      type: 'tct.issued',
      ts: '2026-01-01T00:00:00Z',
      payload: { tct: { token: `${signingInput}.${sig}`, claims: { jti: 'x' } } },
    });
    expect(eventIdFor(at('c2lnQQ'), 'k')).toBe(eventIdFor(at('c2lnQR'), 'k'));
    const otherClaims = `${b64({ alg: 'EdDSA' })}.${b64({ jti: 'y' })}.c2lnQQ`;
    expect(eventIdFor(at('c2lnQQ'), 'k')).not.toBe(
      eventIdFor({ ...at('c2lnQQ'), payload: { tct: { token: otherClaims, claims: { jti: 'x' } } } }, 'k'),
    );
  });

  it('drops the detached signature of a manifest / revocation_list envelope', () => {
    const at = (signature: string) => ({
      type: 'agent.registered',
      ts: '2026-01-01T00:00:00Z',
      payload: { envelope: { manifest: { aid: 'a', version: 'aitp/0.3' }, signature } },
    });
    expect(eventIdFor(at('ed25519:AAAA'), 'k')).toBe(eventIdFor(at('AAAA'), 'k'));
    // A bare `signature` field with no signed sibling is ordinary content.
    const bare = (signature: string) => ({ type: 't', ts: '2026-01-01T00:00:00Z', payload: { signature } });
    expect(eventIdFor(bare('a'), 'k')).not.toBe(eventIdFor(bare('b'), 'k'));
  });

  it('leaves dotted strings that are not a JWS untouched', () => {
    const at = (v: string) => ({ type: 't', ts: '2026-01-01T00:00:00Z', payload: { v } });
    expect(eventIdFor(at('a.b.c'), 'k')).not.toBe(eventIdFor(at('a.b.d'), 'k'));
    expect(canonicalJson({ v: 'a.b.c' }, { signedContent: true })).toBe('{"v":"a.b.c"}');
  });

  it('is random when ts is absent or invalid', () => {
    const noTs = { type: 't' };
    expect(eventIdFor(noTs, 'k')).not.toBe(eventIdFor(noTs, 'k'));
    expect(eventIdFor({ ...noTs, ts: 1e20 }, 'k')).not.toBe(eventIdFor({ ...noTs, ts: 1e20 }, 'k'));
  });
});
