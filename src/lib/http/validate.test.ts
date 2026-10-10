// Unit tests for the shared request-validation helpers.

import {
  JTI_UUID_RE,
  badRequest,
  checkColumnString,
  checkQueryParam,
  invalidId,
  isHttpUrl,
  isUniqueViolation,
  isUuid,
  readJsonObject,
} from './validate';

const V4 = '3f2b8c1e-9a4d-4e5f-8a6b-7c8d9e0f1a2b';
const V7 = '0190a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';

describe('JTI_UUID_RE (v1-5 only — the historical jti rule)', () => {
  it('accepts v1-v5 in either case', () => {
    expect(JTI_UUID_RE.test(V4)).toBe(true);
    expect(JTI_UUID_RE.test(V4.toUpperCase())).toBe(true);
    expect(JTI_UUID_RE.test('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true); // v1
  });

  it('rejects v6/v7/v8, the nil uuid, a bad variant, and non-uuids', () => {
    expect(JTI_UUID_RE.test(V7)).toBe(false);
    expect(JTI_UUID_RE.test('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(JTI_UUID_RE.test('3f2b8c1e-9a4d-4e5f-ca6b-7c8d9e0f1a2b')).toBe(false); // variant c
    expect(JTI_UUID_RE.test('not-a-uuid')).toBe(false);
  });
});

describe('isUuid (syntax-only, any version)', () => {
  it('accepts any version/variant in canonical form, either case', () => {
    expect(isUuid(V4)).toBe(true);
    expect(isUuid(V7)).toBe(true);
    expect(isUuid(V4.toUpperCase())).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('rejects non-uuids and non-strings', () => {
    for (const v of ['', 'not-a-uuid', 'ta-1', '42', `${V4}x`, ` ${V4}`, V4.replace(/-/g, ''), `{${V4}}`, `${V4}\u0000`]) {
      expect(isUuid(v)).toBe(false);
    }
    expect(isUuid(42)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('invalidId', () => {
  it('is 400 ID_INVALID with the standard shape', async () => {
    const res = invalidId();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'id must be a UUID', code: 'ID_INVALID' });
  });
});

describe('badRequest', () => {
  it('defaults the code to BODY_INVALID and accepts another', async () => {
    const a = badRequest('nope');
    expect(a.status).toBe(400);
    expect(await a.json()).toEqual({ error: 'nope', code: 'BODY_INVALID' });
    expect(await badRequest('q', 'BAD_REQUEST').json()).toEqual({ error: 'q', code: 'BAD_REQUEST' });
  });
});

describe('checkColumnString', () => {
  it('accepts exactly max code points and rejects max+1', () => {
    expect(checkColumnString('a'.repeat(128), { field: 'label', max: 128 })).toBeNull();
    expect(checkColumnString('a'.repeat(129), { field: 'label', max: 128 })).toBe(
      'label exceeds 128 character limit',
    );
  });

  it('counts code points, not UTF-16 units', () => {
    const astral = '\u{1F600}'.repeat(128); // 256 UTF-16 units
    expect(astral.length).toBe(256);
    expect(checkColumnString(astral, { field: 'label', max: 128 })).toBeNull();
    expect(checkColumnString(astral + '\u{1F600}', { field: 'label', max: 128 })).not.toBeNull();
    expect(checkColumnString('é'.repeat(128), { field: 'label', max: 128 })).toBeNull();
  });

  it('rejects U+0000 anywhere, even when short', () => {
    expect(checkColumnString('a\u0000b', { field: 'namespace', max: 128 })).toBe(
      'namespace must not contain a NUL character',
    );
  });

  it('allows other control characters and lone surrogates', () => {
    expect(checkColumnString('a\nb\tc\u0001', { field: 'label', max: 128 })).toBeNull();
    expect(checkColumnString('\uD800', { field: 'label', max: 128 })).toBeNull();
  });

  it('applies an optional UTF-8 byte cap on top of the code-point cap', () => {
    const opts = { field: 'issuerUrl', max: 2048, maxBytes: 2048 };
    expect(checkColumnString('a'.repeat(2048), opts)).toBeNull();
    expect(checkColumnString('a'.repeat(2049), opts)).toBe('issuerUrl exceeds 2048 character limit');
    // 600 code points but 2400 bytes.
    expect(checkColumnString('\u{1F600}'.repeat(600), opts)).toBe(
      'issuerUrl exceeds 2048 byte limit',
    );
  });
});

describe('checkQueryParam', () => {
  it('passes absent and ordinary values', () => {
    expect(checkQueryParam(null, 'namespace')).toBeNull();
    expect(checkQueryParam('', 'namespace')).toBeNull();
    expect(checkQueryParam('prod', 'namespace')).toBeNull();
  });

  it('rejects a NUL', () => {
    expect(checkQueryParam('a\u0000', 'namespace')).toBe(
      'namespace must not contain a NUL character',
    );
  });
});

describe('readJsonObject', () => {
  function req(body: string): Request {
    return new Request('http://localhost/x', { method: 'POST', body });
  }

  it('returns the parsed object', async () => {
    const r = await readJsonObject(req('{"a":1}'));
    expect(r).toEqual({ ok: true, body: { a: 1 } });
  });

  it('400 BODY_INVALID for non-JSON and an empty body', async () => {
    for (const b of ['not json', '{{', '']) {
      const r = await readJsonObject(req(b));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(400);
        expect(await r.response.json()).toEqual({ error: 'body must be JSON', code: 'BODY_INVALID' });
      }
    }
  });

  it('400 BODY_INVALID for JSON that is not an object (null, array, primitives)', async () => {
    for (const b of ['null', '[]', '[{"a":1}]', '"s"', '5', 'true']) {
      const r = await readJsonObject(req(b));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(400);
        expect(await r.response.json()).toEqual({
          error: 'body must be a JSON object',
          code: 'BODY_INVALID',
        });
      }
    }
  });
});

describe('isUniqueViolation', () => {
  it('matches SQLSTATE 23505 only', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
    expect(isUniqueViolation({ code: '22001' })).toBe(false);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });

  it('reads the SQLSTATE through a wrapper\'s .cause (drizzle DrizzleQueryError)', () => {
    const pgErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(isUniqueViolation(new Error('Failed query: ...', { cause: pgErr }))).toBe(true);
    expect(
      isUniqueViolation(new Error('Failed query', { cause: { code: '22001' } })),
    ).toBe(false);
  });
});

describe('isHttpUrl', () => {
  it('requires an http:// or https:// prefix (case-sensitive, as before)', () => {
    expect(isHttpUrl('https://issuer.example.com')).toBe(true);
    expect(isHttpUrl('http://issuer.example.com')).toBe(true);
    expect(isHttpUrl('ftp://x')).toBe(false);
    expect(isHttpUrl('issuer.example.com')).toBe(false);
    expect(isHttpUrl('HTTPS://x')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl(42)).toBe(false);
  });
});
