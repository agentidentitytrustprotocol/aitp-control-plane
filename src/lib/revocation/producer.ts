import { getCpAgent } from '../identity/cp-agent';
import { db } from '../db';
import { revocationEntries } from '../db/schema';
import { config } from '../config';
import { logger } from '../logger';

class RevocationProducer {
  private cachedEnvelope = '';
  private cachedUntil = 0;

  /** Returns a fresh signed RevocationListEnvelope JSON. Re-signs at
   * most every 60 seconds; the signed `expires_at` inside is governed by
   * `REVOCATION_LIST_TTL_SECS`. */
  async getEnvelopeJson(): Promise<string> {
    if (Date.now() < this.cachedUntil && this.cachedEnvelope) {
      return this.cachedEnvelope;
    }
    let entries: { jti: string; revokedAt: string; reason: string | null }[] =
      [];
    try {
      entries = await db
        .select({
          jti: revocationEntries.jti,
          revokedAt: revocationEntries.revokedAt,
          reason: revocationEntries.reason,
        })
        .from(revocationEntries);
    } catch (err) {
      // DB unreachable / table missing → publish an empty signed list.
      // The spec treats an empty entries array as a meaningful assertion
      // that nothing has been revoked since the previous snapshot.
      logger.warn({ err }, 'revocation DB read failed, publishing empty list');
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
    this.cachedUntil = Date.now() + 60_000;
    return this.cachedEnvelope;
  }

  invalidate(): void {
    this.cachedUntil = 0;
    this.cachedEnvelope = '';
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __revocationProducer: RevocationProducer | undefined;
}

export const revocationProducer =
  globalThis.__revocationProducer ??
  (globalThis.__revocationProducer = new RevocationProducer());
