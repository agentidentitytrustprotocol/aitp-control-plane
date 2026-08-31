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
import { getCpAgent, getCpManifestJson, initCpIdentity } from './cp-agent';
import { pool } from '../db';
import { expectVerifyCode } from '@/test/expect-verify-code';

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

  // The two tests before this comment only assert the positive case
  // (verifies without throwing), which is a tautology whenever the SDK is
  // self-consistent — it cannot tell "the wire shape is what we expect"
  // apart from "the wire shape is whatever the SDK happens to produce", and
  // it cannot tell a real signature check from a no-op. The revocation path
  // (src/e2e/revocation-flow.integration.test.ts) has both a wire-shape
  // assertion and a negative (broken-signature) assertion; the manifest path
  // did not, until now.

  it("CP's manifest has the exact top-level member set, and omits extensions", () => {
    const parsed = JSON.parse(getCpManifestJson()) as { manifest: Record<string, unknown> };

    // Scoped to identityType "pinned_key": cp-agent.ts's buildManifest()
    // call passes no identityType, and the SDK defaults to "pinned_key"
    // (agent.rs:174) — an OIDC manifest is not guaranteed to carry the same
    // member set (e.g. proof_of_possession is a pinned-key-only concept).
    // Also scoped to the CP's current requiredCaps: [] usage (cp-agent.ts's
    // buildManifestJson): a non-empty requiredCaps adds a 13th key,
    // required_peer_capabilities, that this exact-member-set assertion
    // doesn't account for — if cp-agent.ts ever declares required peer
    // capabilities, this test needs updating too.
    expect(Object.keys(parsed.manifest).sort()).toEqual(
      [
        'accepted_identity_types',
        'accepted_trust_anchors',
        'aid',
        'display_name',
        'expires_at',
        'handshake_endpoint',
        'identity_hint',
        'offered_capabilities',
        'proof_of_possession',
        'published_at',
        'signature',
        'version',
      ].sort(),
    );
    // Pinning the current shape: if a future SDK starts emitting
    // "extensions":{} (or a populated extensions map) on a freshly-built
    // manifest, this test names the change instead of it slipping through.
    expect(parsed.manifest).not.toHaveProperty('extensions');
  });

  it('a manifest with a mutated field fails verification with signature_invalid', () => {
    const agent = getCpAgent();
    const fresh = agent.buildManifest({
      displayName: 'aitp-control-plane',
      handshakeEndpoint: 'https://cp.example.com/api/aitp/handshake/hello',
      offeredCaps: [],
      requiredCaps: [],
      ttlSecs: 3600,
    });

    // Prove the un-mutated manifest verifies, so the negative below can't be
    // vacuously green (e.g. a typo that makes every manifest fail).
    expect(() => verifyManifestJson(fresh)).not.toThrow();

    const parsed = JSON.parse(fresh) as { manifest: { expires_at: number } };
    // Mutating expires_at after signing must break the signature: the
    // signed bytes cover the whole manifest body, and the signature itself
    // is left untouched, so the SDK's own verifier must reject it.
    const mutated = JSON.stringify({
      manifest: { ...parsed.manifest, expires_at: parsed.manifest.expires_at + 1 },
    });

    expectVerifyCode(() => verifyManifestJson(mutated), 'signature_invalid');
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

  // Margin-boundary coverage for #73's fix: getCpManifestJson() rebuilds
  // proactively once `expires_at` is within MANIFEST_REBUILD_MARGIN_SECS
  // (3600, hardcoded here — it is not exported from cp-agent.ts, see that
  // file's comment for why), not only once the manifest is already fully
  // expired (the case the test above covers). The two tests below exercise
  // both sides of that `<=` comparison. Same technique as above: mutate the
  // cached manifest's expires_at directly rather than faking the system
  // clock, since expires_at is stamped by the native buildManifest binding.
  it('does not rebuild a manifest comfortably outside the rebuild margin', () => {
    const fresh = getCpManifestJson();

    const nowSecs = Math.floor(Date.now() / 1000);
    const outsideMarginExpiresAt = nowSecs + 3600 + 300;
    const notStale = JSON.stringify({
      manifest: { ...JSON.parse(fresh).manifest, expires_at: outsideMarginExpiresAt },
    });
    (globalThis as { __cpManifestJson?: string }).__cpManifestJson = notStale;

    const result = getCpManifestJson();
    // Reference-equal, not just deep-equal: proves getCpManifestJson()
    // returned the same cached string in place, i.e. no rebuild fired.
    expect(result).toBe(notStale);
  });

  it('rebuilds proactively once within the margin but before absolute expiry', () => {
    const fresh = getCpManifestJson();
    const freshParsed = JSON.parse(fresh) as { manifest: { aid: string } };

    const nowSecs = Math.floor(Date.now() / 1000);
    const staleExpiresAt = nowSecs + 3600 - 300;
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
