import { db } from '../db';
import { enrollmentJtis } from '../db/schema';

/**
 * Atomically consume an enrollment token's `jti`. Returns `true` if this
 * is the first time the jti has been seen (the caller may proceed), or
 * `false` if it was already consumed (a replay — the caller must reject).
 *
 * The `(jti)` primary key + `onConflictDoNothing` makes this a single
 * atomic insert: concurrent replays of the same token race on the PK and
 * only one wins. `expiresAt` lets the retention sweep drop the row once
 * the token can no longer be presented anyway.
 */
export async function consumeEnrollmentJti(
  jti: string,
  expiresAtUnixSecs: number,
): Promise<boolean> {
  const inserted = await db
    .insert(enrollmentJtis)
    .values({
      jti,
      expiresAt: new Date(expiresAtUnixSecs * 1000).toISOString(),
    })
    .onConflictDoNothing({ target: enrollmentJtis.jti })
    .returning({ jti: enrollmentJtis.jti });
  return inserted.length > 0;
}
