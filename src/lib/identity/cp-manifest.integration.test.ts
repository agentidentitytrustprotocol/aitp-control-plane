/**
 * Conformance smoke: the CP's own AITP manifest (served at
 * /.well-known/aitp-manifest) must verify against the aitp-rs Rust
 * binding's `verifyManifestJson`. This catches schema drift between
 * the CP's manifest builder and the spec-aligned verifier.
 *
 * Full RFC conformance (the 44-fixture suite in aitp-conformance) is
 * out of scope here — that's a multi-language matrix. This test pins
 * the CP-specific surface: the manifest the CP itself publishes.
 */

import { verifyManifestJson } from 'aitp';
import { getCpManifestJson, initCpIdentity } from './cp-agent';
import { pool } from '../db';

describe('integration: CP self-manifest conformance', () => {
  beforeAll(() => {
    process.env.CP_AID_SEED_HEX ||=
      '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    initCpIdentity();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("CP's manifest verifies under the aitp-rs binding", () => {
    const manifest = getCpManifestJson();
    expect(typeof manifest).toBe('string');
    expect(() => verifyManifestJson(manifest)).not.toThrow();
  });

  it('manifest re-verification is idempotent', () => {
    const manifest = getCpManifestJson();
    for (let i = 0; i < 5; i++) {
      expect(() => verifyManifestJson(manifest)).not.toThrow();
    }
  });
});
