import { db } from '../db';
import { consumeEnrollmentJti } from './jti-store';
import { upsertAgent, type RegisterInput } from './store';

/**
 * Consume an enrollment token's `jti` and register the agent in ONE
 * transaction (issue #151), so the token is spent only by a registration that
 * commits. A failed upsert (a database fault) rolls the consume back and the
 * same token works on retry; a token whose registration committed stays spent,
 * so a second presentation is still a replay.
 *
 * Returns `false`, writing nothing, when the jti was already consumed.
 */
export async function registerConsumingJti(
  token: { jti: string; exp: number },
  input: RegisterInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await consumeEnrollmentJti(token.jti, token.exp, tx))) return false;
    await upsertAgent(input, tx);
    return true;
  });
}
