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

  // Regression for #73: the manifest is built once, at process start, with a
  // 24h TTL, and previously was never rebuilt — any process alive longer than
  // that served a manifest that verifies as `expired` forever. This test
  // simulates that 24h+ uptime by mutating the cached manifest's expires_at
  // directly, rather than faking the system clock: expires_at is stamped by
  // the native buildManifest binding from the OS clock, which Jest's fake
  // timers (a JS Date shim) cannot reach.
  it('rebuilds the manifest once it nears its own expiry (24h+ uptime)', () => {
    const fresh = getCpManifestJson();
    const freshParsed = JSON.parse(fresh) as { manifest: { aid: string } };

    const staleExpiresAt = Math.floor(Date.now() / 1000) - 1;
    const stale = JSON.stringify({
      manifest: { ...JSON.parse(fresh).manifest, expires_at: staleExpiresAt },
    });
    (globalThis as { __cpManifestJson?: string }).__cpManifestJson = stale;

    const rebuilt = getCpManifestJson();
    expect(rebuilt).not.toBe(stale);
    expect(() => verifyManifestJson(rebuilt)).not.toThrow();

    const rebuiltParsed = JSON.parse(rebuilt) as { manifest: { expires_at: number; aid: string } };
    expect(rebuiltParsed.manifest.expires_at).toBeGreaterThan(staleExpiresAt);
    // Same identity — a rebuild must not mint a new key.
    expect(rebuiltParsed.manifest.aid).toBe(freshParsed.manifest.aid);
  });
});
