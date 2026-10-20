// Revocation producer against the REAL SDK signer (producer.test.ts mocks it).
// aitp verifiers (>= 0.14) and signers (>= 0.18) accept only a lowercase
// hyphenated UUID v4 `entries[].jti`. Pins: a v4 list signs as aitp/0.3 and
// verifies; a non-v4 row fails LOUD (error log naming the row) but contained
// (typed RevocationUnavailableError, never a dropped row or an untyped throw);
// and JTI_V4_RE -- shared by the producer guard and POST
// /api/revocation/entries -- accepts exactly what the SDK signer does.

import { jest } from '@jest/globals';
import { AitpAgent, verifyRevocationList } from 'aitp';

let rowsToReturn: { jti: string; revokedAt: number; reason: string | null }[] = [];

jest.mock('../db', () => ({
  db: { select: () => ({ from: () => Promise.resolve(rowsToReturn) }) },
}));

const agent = AitpAgent.generate();
agent.buildManifest({
  displayName: 'cp',
  handshakeEndpoint: 'https://cp.example/h',
  offeredCaps: [],
});
jest.mock('../identity/cp-agent', () => ({ getCpAgent: () => agent }));

jest.mock('../config', () => ({
  config: {
    revocationListTtlSecs: 600,
    revocationFailMode: 'fail_closed',
    revocationMaxStalenessSecs: 300,
  },
}));

const errorCalls: { obj: Record<string, unknown>; msg: string }[] = [];
jest.mock('../logger', () => ({
  logger: {
    warn: () => {},
    info: () => {},
    debug: () => {},
    error: (obj: Record<string, unknown>, msg: string) => {
      errorCalls.push({ obj, msg });
    },
  },
}));

import { revocationProducer, RevocationUnavailableError } from './producer';
import { JTI_V4_RE } from '../http/validate';

const V4 = '3f1d2c4b-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const V1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => {
  revocationProducer.invalidate();
  errorCalls.length = 0;
});

describe('revocationProducer with the real signer', () => {
  it('signs a v4 list as aitp/0.3 that verifies under the CP AID', async () => {
    rowsToReturn = [{ jti: V4, revokedAt: NOW - 10, reason: 'test' }];
    const envelope = await revocationProducer.getEnvelopeJson();
    expect(() => verifyRevocationList(envelope, agent.aid)).not.toThrow();
    const parsed = JSON.parse(envelope) as { revocation_list: { version: string } };
    expect(parsed.revocation_list.version).toBe('aitp/0.3');
    expect(errorCalls).toHaveLength(0);
  });

  it('fails loud and contained on a non-v4 row, without dropping it', async () => {
    rowsToReturn = [
      { jti: V4, revokedAt: NOW - 10, reason: null },
      { jti: V1, revokedAt: NOW - 5, reason: null },
    ];
    await expect(revocationProducer.getEnvelopeJson()).rejects.toBeInstanceOf(
      RevocationUnavailableError,
    );
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].msg).toBe('revocation list signing failed, refusing to publish a list');
    expect(errorCalls[0].obj).toMatchObject({ nonV4Jtis: [V1], nonV4Count: 1, entryCount: 2 });
  });

  // One table, three judges: the regex (route + guard), the raw SDK signer,
  // and the producer end to end. Any disagreement is either a list the CP
  // would publish that nobody can verify, or a valid jti the route turns away.
  describe.each([
    ['lowercase v4', V4, true],
    ['uppercase v4', V4.toUpperCase(), false],
    ['braced v4', `{${V4}}`, false],
    ['urn v4', `urn:uuid:${V4}`, false],
    ['unhyphenated v4', V4.replace(/-/g, ''), false],
    ['lowercase v1', V1, false],
  ])('%s', (_label, jti, valid) => {
    it(`the regex ${valid ? 'accepts' : 'rejects'} it, like the SDK signer`, () => {
      expect(JTI_V4_RE.test(jti)).toBe(valid);
      const sign = () => agent.signRevocationList([{ jti, revokedAt: NOW - 1 }], 600);
      if (valid) expect(sign).not.toThrow();
      else expect(sign).toThrow(/not a lowercase UUID v4/);
    });

    it(`the producer ${valid ? 'publishes' : 'refuses'} a list carrying it`, async () => {
      rowsToReturn = [{ jti, revokedAt: NOW - 1, reason: null }];
      const run = revocationProducer.getEnvelopeJson();
      if (valid) await expect(run).resolves.toEqual(expect.any(String));
      else await expect(run).rejects.toBeInstanceOf(RevocationUnavailableError);
    });
  });
});
