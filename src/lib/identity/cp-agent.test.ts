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
});
