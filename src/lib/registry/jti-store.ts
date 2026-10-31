import { db, type DbExecutor } from '../db';
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
 *
 * Pass a transaction as `executor` to make the consume commit or roll back
 * with other writes (`registerConsumingJti`). A concurrent consume of the same
 * jti then waits on the PK until that transaction ends: if it commits, the
 * waiter sees the conflict (a replay); if it rolls back, the waiter wins.
 */
export async function consumeEnrollmentJti(
  jti: string,
  expiresAtUnixSecs: number,
  executor: DbExecutor = db,
): Promise<boolean> {
  const inserted = await executor
    .insert(enrollmentJtis)
    .values({
      jti,
      expiresAt: new Date(expiresAtUnixSecs * 1000).toISOString(),
    })
    .onConflictDoNothing({ target: enrollmentJtis.jti })
    .returning({ jti: enrollmentJtis.jti });
  return inserted.length > 0;
}
