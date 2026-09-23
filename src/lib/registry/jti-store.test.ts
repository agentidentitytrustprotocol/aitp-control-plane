// Unit tests for consumeEnrollmentJti — verifies the one-time-token
// consumption contract:
//   • first consumption of a jti returns true and inserts the right row
//   • a replay (onConflictDoNothing yields no returned row) returns false
//
// @/lib/db is mocked with a chained stub. No database.

import { jest } from '@jest/globals';

const valuesArgs: unknown[] = [];
const conflictTargets: unknown[] = [];
let returningResult: unknown[] = [];

jest.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  chain.values = (v: unknown) => {
    valuesArgs.push(v);
    return chain;
  };
  chain.onConflictDoNothing = (opts: unknown) => {
    conflictTargets.push(opts);
    return chain;
  };
  chain.returning = () => Promise.resolve(returningResult);
  return {
    db: {
      insert: () => chain,
    },
  };
});

import { consumeEnrollmentJti } from './jti-store';
import { enrollmentJtis } from '../db/schema';

beforeEach(() => {
  valuesArgs.length = 0;
  conflictTargets.length = 0;
  returningResult = [];
});

describe('consumeEnrollmentJti', () => {
  it('returns true and inserts (jti, expiresAt) on first consumption', async () => {
    returningResult = [{ jti: 'jti-1' }];
    const ok = await consumeEnrollmentJti('jti-1', 1_700_000_000);
    expect(ok).toBe(true);
    expect(valuesArgs).toEqual([
      { jti: 'jti-1', expiresAt: new Date(1_700_000_000 * 1000).toISOString() },
    ]);
    expect(conflictTargets).toEqual([{ target: enrollmentJtis.jti }]);
  });

  it('returns false when the jti was already consumed (no row returned)', async () => {
    returningResult = [];
    const ok = await consumeEnrollmentJti('jti-replayed', 1_700_000_000);
    expect(ok).toBe(false);
  });
});
