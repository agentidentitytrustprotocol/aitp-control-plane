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

const MANIFEST_TTL_SECS = 86_400;

// The well-known route caches the manifest response for up to an hour
// (Cache-Control: max-age=3600). Rebuilding once the manifest is within that
// same window of its own expires_at guarantees a cached response is never
// stale by the time a client's copy goes stale too — a process alive longer
// than MANIFEST_TTL_SECS otherwise serves a permanently `expired` manifest
// (aitp-control-plane#73).
const MANIFEST_REBUILD_MARGIN_SECS = 3_600;

function buildManifestJson(agent: AitpAgent): string {
  return agent.buildManifest({
    displayName: 'aitp-control-plane',
    handshakeEndpoint: `${config.cpBaseUrl}/api/aitp/handshake/hello`,
    offeredCaps: [],
    requiredCaps: [],
    ttlSecs: MANIFEST_TTL_SECS,
  });
}

function manifestExpiresAt(manifestJson: string): number {
  return (JSON.parse(manifestJson) as { manifest: { expires_at: number } }).manifest.expires_at;
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

  globalThis.__cpAgent = agent;
  globalThis.__cpManifestJson = buildManifestJson(agent);
}

export function getCpAgent(): AitpAgent {
  if (!globalThis.__cpAgent) initCpIdentity();
  return globalThis.__cpAgent!;
}

export function getCpManifestJson(): string {
  if (!globalThis.__cpManifestJson) initCpIdentity();

  const nowSecs = Math.floor(Date.now() / 1000);
  if (manifestExpiresAt(globalThis.__cpManifestJson!) - nowSecs <= MANIFEST_REBUILD_MARGIN_SECS) {
    // Rebuild in place, rather than clearing the cache and re-entering
    // initCpIdentity(): init gates on __cpAgent alone, so clearing only
    // __cpManifestJson would make init a no-op and this function would
    // then return `undefined` through the non-null assertion below.
    globalThis.__cpManifestJson = buildManifestJson(globalThis.__cpAgent!);
    logger.info(
      { aid: globalThis.__cpAgent!.aid, expiresAt: manifestExpiresAt(globalThis.__cpManifestJson) },
      'CP manifest neared expiry — rebuilt',
    );
  }

  return globalThis.__cpManifestJson!;
}
