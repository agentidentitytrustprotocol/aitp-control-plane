import { getCpAgent } from '../identity/cp-agent';
import { db } from '../db';
import { revocationEntries } from '../db/schema';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Thrown when the DB read failed and policy forbids serving anything else.
 * The route maps it to `503 REVOCATION_UNAVAILABLE`. The message is fixed on
 * purpose: it reaches a client body, so it must never carry the DB error.
 */
export class RevocationUnavailableError extends Error {
  readonly code = 'REVOCATION_UNAVAILABLE';
  constructor() {
    super('revocation list temporarily unavailable');
    this.name = 'RevocationUnavailableError';
  }
}

class RevocationProducer {
  /** Last envelope signed from a SUCCESSFUL read. Outlives `cachedUntil` (the
   * 60s re-sign throttle) so serve_stale has something to fall back to;
   * cleared only by invalidate(). */
  private cachedEnvelope = '';
  private cachedUntil = 0;
  /** Epoch ms of the successful read behind `cachedEnvelope`. */
  private cachedAt = 0;

  /** Returns a fresh signed RevocationListEnvelope JSON. Re-signs at
   * most every 60 seconds; the signed `expires_at` inside is governed by
   * `REVOCATION_LIST_TTL_SECS`. */
  async getEnvelopeJson(): Promise<string> {
    if (Date.now() < this.cachedUntil && this.cachedEnvelope) {
      return this.cachedEnvelope;
    }
    let entries: { jti: string; revokedAt: string; reason: string | null }[];
    try {
      entries = await db
        .select({
          jti: revocationEntries.jti,
          revokedAt: revocationEntries.revokedAt,
          reason: revocationEntries.reason,
        })
        .from(revocationEntries);
    } catch (err) {
      return this.handleReadFailure(err);
    }
    const agent = getCpAgent();
    this.cachedEnvelope = agent.signRevocationList(
      entries.map((e) => ({
        jti: e.jti,
        revokedAt: Math.floor(new Date(e.revokedAt).getTime() / 1000),
        reason: e.reason ?? undefined,
      })),
      config.revocationListTtlSecs,
    );
    this.cachedAt = Date.now();
    this.cachedUntil = this.cachedAt + 60_000;
    return this.cachedEnvelope;
  }

  /**
   * DB read failed. NEVER signs a new list (an empty one would assert that
   * nothing is revoked). Either re-serves the last good envelope (serve_stale,
   * bounded age) or throws. The log text keeps the substring
   * `revocation DB read failed`, which scripts/verify-image.mjs greps for.
   */
  private handleReadFailure(err: unknown): string {
    const ageMs = Date.now() - this.cachedAt;
    // Never outlive the signed `expires_at` inside the envelope (~cachedAt+TTL).
    const boundMs =
      Math.min(config.revocationMaxStalenessSecs, config.revocationListTtlSecs) *
      1000;
    if (
      config.revocationFailMode === 'serve_stale' &&
      this.cachedEnvelope &&
      ageMs <= boundMs
    ) {
      logger.warn(
        { err, staleForMs: ageMs },
        'revocation DB read failed, serving last-known-good list',
      );
      return this.cachedEnvelope;
    }
    logger.error(
      {
        err,
        failMode: config.revocationFailMode,
        haveSnapshot: this.cachedEnvelope !== '',
      },
      'revocation DB read failed, refusing to publish a list',
    );
    throw new RevocationUnavailableError();
  }

  /** Called after a revocation is committed. Also drops the stale fallback:
   * that snapshot is now known to omit the new entry, so it must not be
   * served even in serve_stale mode. */
  invalidate(): void {
    this.cachedUntil = 0;
    this.cachedEnvelope = '';
    this.cachedAt = 0;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __revocationProducer: RevocationProducer | undefined;
}

export const revocationProducer =
  globalThis.__revocationProducer ??
  (globalThis.__revocationProducer = new RevocationProducer());
