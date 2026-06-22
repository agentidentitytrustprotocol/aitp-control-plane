/**
 * Unit: the tolerant TCT/delegation claim parsers.
 *
 * These exercise the pure projection functions (no DB) across the v0.2
 * `{ token, claims }` JWS event shape and the v0.1 flat shape, proving the
 * tolerant-parsing contract holds through the migration: JWT claim names
 * (`iss/sub/aud/iat/exp`, `cnf.jkt`, `src_jti`) project onto the same
 * columns as their v0.1 predecessors, and malformed input is dropped
 * rather than throwing.
 */

import { parseTct, parseDelegation } from './monitor';

const JTI = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const TS = '2026-06-13T00:00:00.000Z';

// Matches a synthetic delegation jti: an RFC-4122 v5 UUID.
const UUID_V5_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Encode claims as a minimal unsigned compact JWS (header.payload.sig).
 *  The CP never verifies the signature, so a placeholder `sig` is fine. */
function jws(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('parseTct', () => {
  it('projects a v0.2 { token, claims } TCT with JWT claim names', () => {
    const raw = {
      token: 'eyJhbGciOiJFZERTQSJ9.eyJqdGkiOiIuLi4ifQ.sig',
      claims: {
        ver: 'aitp/0.2',
        jti: JTI,
        iss: 'aid:test:issuer',
        sub: 'aid:test:subject',
        aud: 'aid:test:subject',
        grants: ['demo.echo'],
        iat: 1_750_000_000,
        exp: 1_750_003_600,
        cnf: { jkt: 'abc123thumbprint' },
      },
    };
    expect(parseTct(raw, TS)).toEqual({
      jti: JTI,
      issuerAid: 'aid:test:issuer',
      subjectAid: 'aid:test:subject',
      audienceAid: 'aid:test:subject',
      grants: ['demo.echo'],
      bindingCnf: 'abc123thumbprint',
      issuedAt: new Date(1_750_000_000 * 1000).toISOString(),
      expiresAt: new Date(1_750_003_600 * 1000).toISOString(),
    });
  });

  it('projects a v0.1 flat TCT (issuer/subject/binding.cnf)', () => {
    const raw = {
      jti: JTI,
      issuer: 'aid:test:issuer',
      subject: 'aid:test:subject',
      audience: 'aid:test:audience',
      grants: ['demo.echo'],
      issued_at: 1_750_000_000,
      expires_at: 1_750_003_600,
      binding: { cnf: 'rawPubkeyB64u' },
    };
    expect(parseTct(raw, TS)).toMatchObject({
      jti: JTI,
      issuerAid: 'aid:test:issuer',
      subjectAid: 'aid:test:subject',
      audienceAid: 'aid:test:audience',
      bindingCnf: 'rawPubkeyB64u',
    });
  });

  it('defaults audience to subject and issuedAt to the event ts', () => {
    const raw = { claims: { jti: JTI, iss: 'aid:i', sub: 'aid:s' } };
    expect(parseTct(raw, TS)).toMatchObject({
      audienceAid: 'aid:s',
      issuedAt: TS,
      expiresAt: null,
      bindingCnf: null,
      grants: [],
    });
  });

  it('drops entries missing jti/iss/sub or with a non-UUID jti', () => {
    expect(parseTct({ claims: { iss: 'aid:i', sub: 'aid:s' } }, TS)).toBeNull();
    expect(parseTct({ claims: { jti: 'not-a-uuid', iss: 'aid:i', sub: 'aid:s' } }, TS)).toBeNull();
    expect(parseTct(null, TS)).toBeNull();
    expect(parseTct('nope', TS)).toBeNull();
  });
});

describe('parseDelegation', () => {
  it('projects a v0.2 delegation: parent from src_jti, iss/sub actors', () => {
    const payload = {
      tct: {
        token: 'eyJ...del',
        claims: {
          jti: JTI,
          src_jti: PARENT,
          iss: 'aid:test:delegator',
          sub: 'aid:test:delegatee',
          aud: 'aid:test:grantor',
          scope: ['demo.echo'],
          iat: 1_750_000_000,
          exp: 1_750_003_600,
        },
      },
    };
    expect(parseDelegation(payload, TS)).toEqual({
      jti: JTI,
      parentJti: PARENT,
      delegatorAid: 'aid:test:delegator',
      delegateeAid: 'aid:test:delegatee',
      scope: ['demo.echo'],
      issuedAt: new Date(1_750_000_000 * 1000).toISOString(),
      expiresAt: new Date(1_750_003_600 * 1000).toISOString(),
    });
  });

  it('projects a real single-hop token: parent from voucher.src_jti, synthetic jti', () => {
    // The real SDK v0.2 single-hop delegation: no top-level jti, no
    // top-level src_jti — the parent TCT jti lives only inside the
    // embedded grant voucher.
    const voucher = jws({
      ver: 'aitp/0.2',
      iss: 'aid:test:grantor',
      sub: 'aid:test:delegator',
      src_jti: PARENT,
      grants: ['demo.echo'],
      iat: 1_750_000_000,
      exp: 1_750_003_600,
    });
    const payload = {
      tct: {
        token: 'eyJhbGciOiJFZERTQSJ9.ZGVsZWdhdGlvbi1ib2R5.sig',
        claims: {
          ver: 'aitp/0.2',
          iss: 'aid:test:delegator',
          sub: 'aid:test:delegatee',
          aud: 'aid:test:grantor',
          scope: ['demo.echo'],
          exp: 1_750_003_600,
          cnf: { jkt: 'delegateeThumbprint' },
          voucher,
        },
      },
    };

    const out = parseDelegation(payload, TS);
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      parentJti: PARENT,
      delegatorAid: 'aid:test:delegator',
      delegateeAid: 'aid:test:delegatee',
      scope: ['demo.echo'],
      issuedAt: TS, // no top-level iat on a single-hop token → event ts
      expiresAt: new Date(1_750_003_600 * 1000).toISOString(),
    });
    expect(out?.jti).toMatch(UUID_V5_RE);

    // Idempotent: re-ingesting the same token yields the same synthetic
    // jti, so onConflictDoNothing keeps deduping.
    expect(parseDelegation(payload, TS)?.jti).toBe(out?.jti);

    // A different token yields a different synthetic jti.
    const other = {
      tct: { ...payload.tct, token: 'eyJhbGciOiJFZERTQSJ9.b3RoZXI.sig' },
    };
    expect(parseDelegation(other, TS)?.jti).not.toBe(out?.jti);
  });

  it('reads voucher.src_jti for a single-hop token even with an explicit jti', () => {
    const voucher = jws({ src_jti: PARENT });
    const payload = {
      tct: {
        token: 'eyJ0.b2s.sig',
        claims: { jti: JTI, iss: 'aid:d', sub: 'aid:e', voucher },
      },
    };
    expect(parseDelegation(payload, TS)).toMatchObject({ jti: JTI, parentJti: PARENT });
  });

  it('projects an explicit-field delegation event verbatim', () => {
    const payload = {
      jti: JTI,
      parent_jti: PARENT,
      delegator_aid: 'aid:test:delegator',
      delegatee_aid: 'aid:test:delegatee',
      scope: ['demo.echo'],
    };
    expect(parseDelegation(payload, TS)).toMatchObject({
      jti: JTI,
      parentJti: PARENT,
      delegatorAid: 'aid:test:delegator',
      delegateeAid: 'aid:test:delegatee',
      scope: ['demo.echo'],
    });
  });

  it('drops a single-hop shape with no opaque token (no jti can be synthesized)', () => {
    const voucher = jws({ src_jti: PARENT });
    const payload = { tct: { claims: { iss: 'aid:d', sub: 'aid:e', voucher } } };
    expect(parseDelegation(payload, TS)).toBeNull();
  });

  it('projects a v0.1 flat delegation (parent_jti/delegator/delegatee)', () => {
    const payload = {
      jti: JTI,
      parent_jti: PARENT,
      delegator: 'aid:test:delegator',
      delegatee: 'aid:test:delegatee',
      scope: ['demo.echo'],
    };
    expect(parseDelegation(payload, TS)).toMatchObject({
      jti: JTI,
      parentJti: PARENT,
      delegatorAid: 'aid:test:delegator',
      delegateeAid: 'aid:test:delegatee',
      scope: ['demo.echo'],
      issuedAt: TS,
    });
  });

  it('falls back to grants when scope is absent', () => {
    const payload = {
      claims: {
        jti: JTI,
        src_jti: PARENT,
        iss: 'aid:d',
        sub: 'aid:e',
        grants: ['cap.a', 'cap.b'],
      },
    };
    expect(parseDelegation(payload, TS)?.scope).toEqual(['cap.a', 'cap.b']);
  });

  it('drops payloads missing jti/parent or with non-UUID identifiers', () => {
    expect(parseDelegation({ claims: { iss: 'a', sub: 'b' } }, TS)).toBeNull();
    expect(
      parseDelegation({ claims: { jti: JTI, src_jti: 'nope', iss: 'a', sub: 'b' } }, TS),
    ).toBeNull();
    expect(
      parseDelegation({ claims: { jti: JTI, src_jti: PARENT, iss: 'a' } }, TS),
    ).toBeNull();
  });
});
