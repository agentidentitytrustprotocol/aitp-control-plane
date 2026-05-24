// Pure logic test: simulate the SQL that `enforceManifestExpiry` issues
// without spinning up Postgres. We mock the `../db` module so the same
// drizzle query-builder chain that the job uses returns canned data.

import { jest } from '@jest/globals';

jest.mock('../db', () => {
  // UPDATE … RETURNING returns the canned rows the job has just
  // claimed/transitioned. The new implementation no longer SELECTs
  // first, so the only chain that needs canned data is `update`.
  const updateChain: Record<string, unknown> = {};
  updateChain.set = () => updateChain;
  updateChain.where = () => updateChain;
  updateChain.returning = () =>
    Promise.resolve([
      { aid: 'aid:pubkey:one', displayName: 'one', namespace: 'default' },
      { aid: 'aid:pubkey:two', displayName: 'two', namespace: 'production' },
    ]);

  // INSERT chain — for ingestOneEvent best-effort calls
  const insertChain: Record<string, unknown> = {};
  insertChain.values = () => insertChain;
  insertChain.onConflictDoNothing = () => Promise.resolve(undefined as unknown);

  return {
    db: {
      update: () => updateChain,
      insert: () => insertChain,
    },
  };
});

// Don't fan out to real webhook handlers (which would themselves hit the DB)
jest.mock('../webhooks/service', () => ({
  dispatchWebhooks: jest.fn(async () => undefined),
}));

import { enforceManifestExpiry } from './expiry-job';
import { eventBus } from '../audit/stream';

describe('enforceManifestExpiry', () => {
  it('transitions active→expired, emits agent.expired events, returns count', async () => {
    const seen: string[] = [];
    const unsubscribe = eventBus.subscribe((e) => {
      if (e.type === 'agent.expired') seen.push(e.aidA ?? '');
    });
    try {
      const count = await enforceManifestExpiry();
      expect(count).toBe(2);
      expect(seen).toEqual(
        expect.arrayContaining(['aid:pubkey:one', 'aid:pubkey:two']),
      );
    } finally {
      unsubscribe();
    }
  });
});
