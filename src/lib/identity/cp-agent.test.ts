import { verifyManifestJson } from 'aitp';

describe('cp identity', () => {
  beforeAll(() => {
    delete process.env.CP_AID_SEED_HEX;
    // Reset module state so the singleton initializes inside the test.
    delete (globalThis as { __cpAgent?: unknown }).__cpAgent;
    delete (globalThis as { __cpManifestJson?: unknown }).__cpManifestJson;
  });

  it('initializes a CP identity and produces a verifiable manifest', async () => {
    const mod = await import('./cp-agent');
    const manifestJson = mod.getCpManifestJson();
    expect(() => verifyManifestJson(manifestJson)).not.toThrow();
    const parsed = JSON.parse(manifestJson) as { manifest: { aid: string } };
    expect(parsed.manifest.aid).toMatch(/^aid:pubkey:/);
    expect(parsed.manifest.aid).toBe(mod.getCpAgent().aid);
  });

  it('memoizes the identity so repeated lookups return the same instance', async () => {
    const mod = await import('./cp-agent');
    // Same object reference and same manifest bytes across calls — proves
    // the globalThis singleton is reused rather than regenerated per call
    // (a fresh ephemeral key each call would change the aid).
    expect(mod.getCpAgent()).toBe(mod.getCpAgent());
    expect(mod.getCpManifestJson()).toBe(mod.getCpManifestJson());
  });

  it('derives a deterministic identity from a fixed seed', async () => {
    const { AitpAgent } = await import('aitp');
    // Two agents from the same seed must yield the same AID — the property
    // CP_AID_SEED_HEX relies on for a stable production identity.
    const seed = Buffer.alloc(32, 7);
    expect(AitpAgent.fromSeed(seed).aid).toBe(AitpAgent.fromSeed(seed).aid);
  });
});
