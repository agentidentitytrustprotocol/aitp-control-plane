// Unit tests for the enrollment error primitives:
//   • sdkVerifyCode returns the SDK's `.code` verbatim when it is a
//     non-empty string inside the 64-char bound, and `undefined` for every
//     other shape — including the shapes that would otherwise reach a
//     public response body as junk
//   • sdkVerifyCode never throws, even on a throwing `.code` getter (it
//     runs inside a catch block; a throw there would turn a 400 into a 500)
//   • ManifestRejectedError is a real Error subclass carrying `cpCode`, and
//     is invisible to sdkVerifyCode — the invariant the two-error-source
//     design rests on
//
// No SDK, no DB. The real-SDK proof that `.code` is where sdkVerifyCode
// looks for it lives in enrollment.test.ts, which already loads `aitp`.

import { ManifestRejectedError, sdkVerifyCode } from './verify-error';

describe('sdkVerifyCode', () => {
  it('returns the code for an SDK-shaped error', () => {
    const err = Object.assign(new Error('x'), { code: 'signature_invalid' });
    expect(sdkVerifyCode(err)).toBe('signature_invalid');
  });

  it('returns the code for a plain object carrying one (no instanceof gate)', () => {
    // The SDK's error IS an Error, but the duck-typed read is what matters,
    // and `instanceof` is unreliable across realms.
    expect(sdkVerifyCode({ code: 'pop_failed' })).toBe('pop_failed');
  });

  it.each([
    ['an Error with no code', new Error('x')],
    ['null', null],
    ['undefined', undefined],
    ['a thrown string', 'a string'],
    ['a thrown number', 42],
    ['a numeric code', { code: 123 }],
    ['an object code', { code: {} }],
    ['an empty-string code', { code: '' }],
    ['a whitespace-only code', { code: '   ' }],
    ['a tab/newline-only code', { code: '\t\n' }],
    ['a null code', { code: null }],
    ['a boolean code', { code: true }],
    ['a symbol code', { code: Symbol('nope') }],
  ])('returns undefined for %s', (_label, input) => {
    expect(sdkVerifyCode(input)).toBeUndefined();
  });

  it('accepts a 64-char code and rejects a 65-char one (both sides of the bound)', () => {
    const atBound = 'a'.repeat(64);
    expect(sdkVerifyCode({ code: atBound })).toBe(atBound);
    expect(sdkVerifyCode({ code: 'a'.repeat(65) })).toBeUndefined();
  });

  it('returns a padded code verbatim rather than trimming it', () => {
    // Blankness is a rejection rule, not a normalization rule: the SDK owns
    // this vocabulary, so a non-blank value must reach the wire intact.
    expect(sdkVerifyCode({ code: ' expired ' })).toBe(' expired ');
  });

  it('checks the length bound on the raw value, not the trimmed one', () => {
    // Otherwise 64 spaces + a code would smuggle an over-long value through.
    expect(sdkVerifyCode({ code: `${' '.repeat(60)}abcde` })).toBeUndefined();
  });

  it('does not truncate an over-long code', () => {
    // A truncated code is a *wrong* code a client may match against.
    expect(sdkVerifyCode({ code: `signature_invalid${'x'.repeat(64)}` })).toBeUndefined();
  });

  it('does not throw when .code is a throwing getter', () => {
    const err = new Error('boom');
    Object.defineProperty(err, 'code', {
      get() {
        throw new Error('getter exploded');
      },
    });
    expect(() => sdkVerifyCode(err)).not.toThrow();
    expect(sdkVerifyCode(err)).toBeUndefined();
  });

  it('reads an inherited code from the prototype chain', () => {
    const proto = { code: 'aid_mismatch' };
    expect(sdkVerifyCode(Object.create(proto))).toBe('aid_mismatch');
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
    // The whole two-source design rests on this: our own rejections must
    // never be mistakable for an SDK verification failure, in either
    // direction.
    const err = new ManifestRejectedError('x', 'MANIFEST_INVALID');
    expect('code' in err).toBe(false);
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
