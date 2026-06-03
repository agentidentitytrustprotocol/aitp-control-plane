// Unit tests for the registry store functions. We mock `../db` so the
// drizzle query-builder chain captures the args we want to assert on
// without needing a live Postgres.

import { jest } from '@jest/globals';

type Recorded = { kind: string; args: unknown[] };
const recorded: Recorded[] = [];
let updateRowsToReturn: Array<{ aid: string }> = [];
let selectRowsToReturn: unknown[] = [];

jest.mock('../db', () => {
  // SELECT chain: select().from().where().orderBy().limit().offset() → rows
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.where = (arg: unknown) => {
    recorded.push({ kind: 'select.where', args: [arg] });
    return selectChain;
  };
  selectChain.orderBy = () => selectChain;
  selectChain.limit = (arg: unknown) => {
    recorded.push({ kind: 'select.limit', args: [arg] });
    return selectChain;
  };
  selectChain.offset = () => Promise.resolve(selectRowsToReturn);

  // UPDATE chain: update().set().where().returning() OR no .returning()
  const updateChain: Record<string, unknown> = {};
  updateChain.set = (arg: unknown) => {
    recorded.push({ kind: 'update.set', args: [arg] });
    return updateChain;
  };
  updateChain.where = (arg: unknown) => {
    recorded.push({ kind: 'update.where', args: [arg] });
    return updateChain;
  };
  updateChain.returning = () =>
    Promise.resolve(updateRowsToReturn as unknown);
  // touchLastSeen* doesn't call .returning() — make the chain itself awaitable.
  (updateChain as unknown as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
  ) => resolve(undefined as unknown);

  // INSERT chain: insert().values().onConflictDoUpdate({set: …})
  const insertChain: Record<string, unknown> = {};
  insertChain.values = (arg: unknown) => {
    recorded.push({ kind: 'insert.values', args: [arg] });
    return insertChain;
  };
  insertChain.onConflictDoUpdate = (arg: unknown) => {
    recorded.push({ kind: 'insert.onConflictDoUpdate', args: [arg] });
    return Promise.resolve(undefined as unknown);
  };

  const updateCalls: Recorded[] = [];
  return {
    db: {
      __recorded: recorded,
      select: () => {
        recorded.push({ kind: 'select.call', args: [] });
        return selectChain;
      },
      update: () => {
        recorded.push({ kind: 'update.call', args: [] });
        updateCalls.push({ kind: 'update.call', args: [] });
        return updateChain;
      },
      insert: () => {
        recorded.push({ kind: 'insert.call', args: [] });
        return insertChain;
      },
    },
  };
});

import {
  deactivateAgent,
  listAgents,
  touchLastSeenBatch,
  upsertAgent,
} from './store';

beforeEach(() => {
  recorded.length = 0;
  updateRowsToReturn = [];
  selectRowsToReturn = [];
});

describe('deactivateAgent (Plan Bug 2)', () => {
  it("writes status='deregistered', NOT the legacy 'inactive'", async () => {
    updateRowsToReturn = [{ aid: 'aid:pubkey:foo' }];
    const ok = await deactivateAgent('aid:pubkey:foo');
    expect(ok).toBe(true);
    const setCall = recorded.find((r) => r.kind === 'update.set');
    expect(setCall).toBeDefined();
    expect(setCall!.args[0]).toEqual({ status: 'deregistered' });
  });

  it('returns false when no row matched', async () => {
    updateRowsToReturn = [];
    const ok = await deactivateAgent('aid:pubkey:missing');
    expect(ok).toBe(false);
  });
});

describe('touchLastSeenBatch (Plan Bug 4)', () => {
  it('issues exactly one UPDATE regardless of how many AIDs are passed', async () => {
    await touchLastSeenBatch([
      'aid:pubkey:a',
      'aid:pubkey:b',
      'aid:pubkey:c',
      'aid:pubkey:d',
      'aid:pubkey:e',
    ]);
    const updateCalls = recorded.filter((r) => r.kind === 'update.call');
    expect(updateCalls.length).toBe(1);
    const setArg = recorded.find((r) => r.kind === 'update.set')!.args[0] as {
      lastSeenAt: string;
    };
    expect(typeof setArg.lastSeenAt).toBe('string');
    // ISO-8601 sanity
    expect(setArg.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('no-ops on an empty AID list (no DB round-trip)', async () => {
    await touchLastSeenBatch([]);
    expect(recorded.filter((r) => r.kind === 'update.call').length).toBe(0);
  });
});

describe('listAgents (Plan Bug 3)', () => {
  it('drives a SELECT and returns the rows the DB hands back', async () => {
    selectRowsToReturn = [
      { aid: 'aid:pubkey:one', status: 'active' },
      { aid: 'aid:pubkey:two', status: 'active' },
    ];
    const rows = await listAgents({});
    expect(rows.length).toBe(2);
    // Composed WHERE always present (status default + expiry exclusion + …).
    expect(recorded.find((r) => r.kind === 'select.where')).toBeDefined();
  });
});

describe('upsertAgent (Plan 2.2 + 2.6)', () => {
  it('persists `namespace` and `lastEnrolledAt` on both insert AND conflict-update', async () => {
    await upsertAgent({
      aid: 'aid:pubkey:up',
      displayName: 'up',
      handshakeEndpoint: 'https://up.example.com/handshake',
      offeredCaps: ['demo.echo'],
      manifestJson: '{"manifest":{"aid":"aid:pubkey:up"}}',
      manifestExpiresAt: null,
      namespace: 'production',
    });
    const insertValues = recorded.find((r) => r.kind === 'insert.values')!
      .args[0] as Record<string, unknown>;
    expect(insertValues.namespace).toBe('production');
    expect(insertValues.lastEnrolledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(insertValues.status).toBe('active');

    const conflict = recorded.find((r) => r.kind === 'insert.onConflictDoUpdate')!
      .args[0] as { set: Record<string, unknown> };
    expect(conflict.set.namespace).toBe('production');
    expect(conflict.set.lastEnrolledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // On re-enrollment we re-activate stale rows.
    expect(conflict.set.status).toBe('active');
  });

  it("defaults namespace to 'default' when caller omits it", async () => {
    await upsertAgent({
      aid: 'aid:pubkey:nd',
      displayName: 'nd',
      handshakeEndpoint: 'https://nd.example.com/handshake',
      offeredCaps: [],
      manifestJson: '{}',
      manifestExpiresAt: null,
    });
    const insertValues = recorded.find((r) => r.kind === 'insert.values')!
      .args[0] as Record<string, unknown>;
    expect(insertValues.namespace).toBe('default');
  });
});
