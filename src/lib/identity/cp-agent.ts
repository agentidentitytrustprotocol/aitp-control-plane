import { AitpAgent } from 'aitp';
import { randomBytes } from 'node:crypto';
import { config } from '../config';
import { logger } from '../logger';

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
    agent = AitpAgent.fromSeed(seed);
    // NEVER log the seed: it is the CP's Ed25519 private key material and
    // reconstructs the key that signs the revocation list and manifest.
    // Log only the public AID so the ephemeral identity is still traceable.
    logger.warn(
      { aid: agent.aid },
      'CP_AID_SEED_HEX not set — using ephemeral key (regenerated each restart)',
    );
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
