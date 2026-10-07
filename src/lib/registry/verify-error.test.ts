// Unit tests for the enrollment error primitives:
//   • sdkVerifyCode answers ONLY for a value markSdkVerifyFailure attested came
//     from the SDK's verifier — the provenance gate that is issue #102's fix
//   • for a marked value it returns the SDK's `.code` verbatim when it is a
//     non-empty string inside the 64-char bound, and `undefined` for every
//     other shape — including the shapes that would otherwise reach a
//     public response body as junk
//   • sdkVerifyCode never throws, even on a throwing `.code` getter (it
//     runs inside a catch block; a throw there would turn a 400 into a 500)
//   • ManifestRejectedError is a real Error subclass carrying `cpCode`, and
//     is invisible to sdkVerifyCode — the invariant the error-source design
//     rests on
//
// EVERY SHAPE CASE BELOW IS MARKED FIRST, deliberately. Once provenance gates
// the read, an unmarked fixture returns `undefined` for the wrong reason, and a
// suite of shape tests would silently stop testing shape at all — it would pass
// against a `sdkVerifyCode` that had lost its length bound, its blank check and
// its string check entirely. `marked()` keeps each case testing the rule it was
// written for; the gate itself is tested separately, in its own describe.
//
// No SDK, no DB. The real-SDK proof that `.code` is where sdkVerifyCode
// looks for it — and that production really does mark it — lives in
// enrollment.test.ts, which already loads `aitp`.

import {
  ManifestRejectedError,
  markSdkVerifyFailure,
  sdkVerifyCode,
} from './verify-error';

/** `v`, marked as having come out of the SDK's verifier. Mirrors what
 *  `enrollment.ts` does in its catch around `verifyManifestJson`. */
function marked<T>(v: T): T {
  markSdkVerifyFailure(v);
  return v;
}

describe('sdkVerifyCode — the provenance gate', () => {
  it('returns undefined for an UNMARKED error that looks exactly like an SDK one', () => {
    // The assertion issue #102 is about, in one line. Identical shape to the
    // marked fixture in the next describe; the only difference is provenance.
    const err = Object.assign(new Error('x'), { code: 'signature_invalid' });
    expect(sdkVerifyCode(err)).toBeUndefined();
  });

  it.each([
    ['ERR_CRYPTO_INVALID_DIGEST', 'Digest method not supported'],
    ['ERR_OSSL_EVP_UNSUPPORTED', 'unsupported'],
    ['ERR_OUT_OF_RANGE', 'value out of range'],
  ])(
    'returns undefined for a Node-shaped %s error, which used to be published as a verifyCode',
    (code, message) => {
      // These are the real shapes `randomUUID`, `Buffer.from` and `createHmac`
      // throw from inside `verifyAndIssueToken`'s minting tail — after the SDK
      // has already ACCEPTED the manifest. Each one used to become
      // `400 MANIFEST_INVALID` with this code echoed as the SDK's verdict and
      // this message echoed to an unauthenticated caller.
      expect(sdkVerifyCode(Object.assign(new Error(message), { code }))).toBeUndefined();
    },
  );

  it('marking is per-value, not a global switch', () => {
    // Otherwise one marked error would unlock every later unmarked one, which is
    // the bug again with extra steps.
    const sdk = marked(Object.assign(new Error('sdk'), { code: 'pop_failed' }));
    const node = Object.assign(new Error('node'), {
      code: 'ERR_CRYPTO_INVALID_DIGEST',
    });
    expect(sdkVerifyCode(sdk)).toBe('pop_failed');
    expect(sdkVerifyCode(node)).toBeUndefined();
  });

  it('marking a primitive is a silent no-op rather than a throw', () => {
    // markSdkVerifyFailure runs inside a catch, so it must never throw — a
    // WeakSet cannot hold a primitive, and a primitive carries no `.code`
    // anyway, so there is nothing to lose.
    for (const primitive of ['a string', 42, true, null, undefined, Symbol('s')]) {
      expect(() => markSdkVerifyFailure(primitive)).not.toThrow();
      expect(sdkVerifyCode(primitive)).toBeUndefined();
    }
  });

  it('marks a frozen error, which a stamped property could not', () => {
    // Why the mark is a registry and not `Object.defineProperty(err, BRAND)`:
    // that throws on a frozen object, and an SDK is free to freeze what it
    // throws. Losing the mark here would turn a genuine 400 into a 500.
    const err = Object.freeze(
      Object.assign(new Error('frozen'), { code: 'aid_mismatch' }),
    );
    expect(() => markSdkVerifyFailure(err)).not.toThrow();
    expect(sdkVerifyCode(err)).toBe('aid_mismatch');
  });
});

describe('sdkVerifyCode — reading the code off a marked value', () => {
  it('returns the code for an SDK-shaped error', () => {
    const err = marked(Object.assign(new Error('x'), { code: 'signature_invalid' }));
    expect(sdkVerifyCode(err)).toBe('signature_invalid');
  });

  it('returns the code for a plain object carrying one (no instanceof gate)', () => {
    // The SDK's error IS an Error, but the duck-typed READ is still what
    // matters, and `instanceof` is unreliable across realms. Provenance is
    // gated; the error's type is deliberately not.
    expect(sdkVerifyCode(marked({ code: 'pop_failed' }))).toBe('pop_failed');
  });

  it.each([
    ['an Error with no code', new Error('x')],
    ['a numeric code', { code: 123 }],
    ['an object code', { code: {} }],
    ['an empty-string code', { code: '' }],
    ['a whitespace-only code', { code: '   ' }],
    ['a tab/newline-only code', { code: '\t\n' }],
    ['a null code', { code: null }],
    ['a boolean code', { code: true }],
    ['a symbol code', { code: Symbol('nope') }],
  ])('returns undefined for %s, even when marked', (_label, input) => {
    expect(sdkVerifyCode(marked(input))).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a thrown string', 'a string'],
    ['a thrown number', 42],
  ])('returns undefined for %s', (_label, input) => {
    expect(sdkVerifyCode(input)).toBeUndefined();
  });

  it('accepts a 64-char code and rejects a 65-char one (both sides of the bound)', () => {
    const atBound = 'a'.repeat(64);
    expect(sdkVerifyCode(marked({ code: atBound }))).toBe(atBound);
    expect(sdkVerifyCode(marked({ code: 'a'.repeat(65) }))).toBeUndefined();
  });

  it('returns a padded code verbatim rather than trimming it', () => {
    // Blankness is a rejection rule, not a normalization rule: the SDK owns
    // this vocabulary, so a non-blank value must reach the wire intact.
    expect(sdkVerifyCode(marked({ code: ' expired ' }))).toBe(' expired ');
  });

  it('checks the length bound on the raw value, not the trimmed one', () => {
    // Otherwise 64 spaces + a code would smuggle an over-long value through.
    expect(sdkVerifyCode(marked({ code: `${' '.repeat(60)}abcde` }))).toBeUndefined();
  });

  it('does not truncate an over-long code', () => {
    // A truncated code is a *wrong* code a client may match against.
    expect(
      sdkVerifyCode(marked({ code: `signature_invalid${'x'.repeat(64)}` })),
    ).toBeUndefined();
  });

  it('does not throw when .code is a throwing getter', () => {
    const err = new Error('boom');
    Object.defineProperty(err, 'code', {
      get() {
        throw new Error('getter exploded');
      },
    });
    markSdkVerifyFailure(err);
    expect(() => sdkVerifyCode(err)).not.toThrow();
    expect(sdkVerifyCode(err)).toBeUndefined();
  });

  it('reads an inherited code from the prototype chain', () => {
    const proto = { code: 'aid_mismatch' };
    expect(sdkVerifyCode(marked(Object.create(proto)))).toBe('aid_mismatch');
  });

  it('does not treat a marked PROTOTYPE as marking its instances', () => {
    // The registry keys on identity, so marking a prototype must not launder
    // every object that inherits from it. Pins that the inherited-code read
    // above and the provenance gate are independent.
    const proto = marked({ code: 'aid_mismatch' });
    expect(sdkVerifyCode(Object.create(proto))).toBeUndefined();
  });
});

describe('ManifestRejectedError', () => {
  it('is an Error subclass with name, message and cpCode set', () => {
    const err = new ManifestRejectedError('manifest.aid missing', 'MANIFEST_INVALID');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ManifestRejectedError);
    expect(err.name).toBe('ManifestRejectedError');
    expect(err.message).toBe('manifest.aid missing');
    expect(err.cpCode).toBe('MANIFEST_INVALID');
  });

  it('carries any cpCode value it is given', () => {
    expect(new ManifestRejectedError('m', 'MANIFEST_EXPIRED').cpCode).toBe(
      'MANIFEST_EXPIRED',
    );
  });

  it('defines no `code` property, so sdkVerifyCode cannot see it', () => {
    // Our own rejections must never be mistakable for an SDK verification
    // failure, in either direction. Now belt AND braces — it is unmarked too —
    // so the `'code' in err` assertion is what keeps this honest: without it
    // the case would pass on the gate alone and stop testing the class.
    const err = new ManifestRejectedError('x', 'MANIFEST_INVALID');
    expect('code' in err).toBe(false);
    expect(sdkVerifyCode(err)).toBeUndefined();
  });

  it('stays invisible to sdkVerifyCode even if something marks it', () => {
    // Defence in depth against the reverse mix-up: a ManifestRejectedError that
    // somehow reached the SDK boundary's catch must still not produce a
    // verifyCode, because it has no `.code` to read. The two mechanisms are
    // independent, not alternatives.
    const err = new ManifestRejectedError('x', 'MANIFEST_INVALID');
    markSdkVerifyFailure(err);
    expect(sdkVerifyCode(err)).toBeUndefined();
  });

  it('has a usable stack (thrown and caught like any Error)', () => {
    let caught: unknown;
    try {
      throw new ManifestRejectedError('thrown', 'MANIFEST_INVALID');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ManifestRejectedError);
    expect(typeof (caught as Error).stack).toBe('string');
  });
});
