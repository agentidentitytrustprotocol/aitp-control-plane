import { AitpAgent } from 'aitp';
import { randomBytes } from 'node:crypto';
import { config } from '../config';

declare global {
  // eslint-disable-next-line no-var
  var __cpAgent: AitpAgent | undefined;
  // eslint-disable-next-line no-var
  var __cpManifestJson: string | undefined;
}

export function initCpIdentity(): void {
  if (globalThis.__cpAgent) return;

  const seedHex = config.cpAidSeedHex;
  let agent: AitpAgent;
  if (!seedHex) {
    if (config.isProduction) {
      throw new Error('CP_AID_SEED_HEX is required in production');
    }
    const seed = randomBytes(32);
    console.warn(
      `[aitp-control-plane] CP_AID_SEED_HEX not set — using ephemeral key (${seed.toString('hex')})`,
    );
    agent = AitpAgent.fromSeed(seed);
  } else {
    agent = AitpAgent.fromSeed(Buffer.from(seedHex, 'hex'));
  }

  const manifestJson = agent.buildManifest({
    displayName: 'aitp-control-plane',
    handshakeEndpoint: `${config.cpBaseUrl}/api/aitp/handshake/hello`,
    offeredCaps: [],
    requiredCaps: [],
    ttlSecs: 86_400,
  });

  globalThis.__cpAgent = agent;
  globalThis.__cpManifestJson = manifestJson;
}

export function getCpAgent(): AitpAgent {
  if (!globalThis.__cpAgent) initCpIdentity();
  return globalThis.__cpAgent!;
}

export function getCpManifestJson(): string {
  if (!globalThis.__cpManifestJson) initCpIdentity();
  return globalThis.__cpManifestJson!;
}
