// Unit tests for the session monitor. We mock `../db` so the drizzle
// insert/update chains capture the values written for each handshake
// lifecycle event: `handshake.started` inserts a row (with boundary
// derived from the payload), `handshake.complete` / `handshake.failed`
// update status. DB errors must be swallowed (logged), never thrown
// back into the audit pipeline.

import { jest } from '@jest/globals';

type Recorded = { kind: string; args: unknown[] };
const recorded: Recorded[] = [];
let throwOnWrite = false;

jest.mock('../db', () => {
  // INSERT chain: insert().values().onConflictDoNothing()
  const insertChain: Record<string, unknown> = {};
  insertChain.values = (arg: unknown) => {
    if (throwOnWrite) throw new Error('db down');
    recorded.push({ kind: 'insert.values', args: [arg] });
    return insertChain;
  };
  insertChain.onConflictDoNothing = () => {
    recorded.push({ kind: 'insert.onConflictDoNothing', args: [] });
    return Promise.resolve(undefined);
  };

  // UPDATE chain: update().set().where()
  const updateChain: Record<string, unknown> = {};
  updateChain.set = (arg: unknown) => {
    if (throwOnWrite) throw new Error('db down');
    recorded.push({ kind: 'update.set', args: [arg] });
    return updateChain;
  };
  updateChain.where = (arg: unknown) => {
    recorded.push({ kind: 'update.where', args: [arg] });
    return Promise.resolve(undefined);
  };

  return {
    db: {
      insert: () => insertChain,
      update: () => updateChain,
    },
  };
});

import { sessionMonitor } from './monitor';
import type { AuditEventRecord } from '../audit/stream';

const ts = '2026-07-07T10:00:00.000Z';

function event(overrides: Partial<AuditEventRecord>): AuditEventRecord {
  return { id: 'evt-1', type: 'handshake.started', ts, payload: {}, ...overrides };
}

beforeEach(() => {
  recorded.length = 0;
  throwOnWrite = false;
});

describe('sessionMonitor.onEvent — handshake.started', () => {
  it('inserts a started row with fields from the event', async () => {
    await sessionMonitor.onEvent(
      event({
        sessionId: 'sess-1',
        aidA: 'aid:pubkey:A',
        aidB: 'aid:pubkey:B',
        runId: 'run-9',
        payload: { boundary: 'org-a<->org-b' },
      }),
    );
    const values = recorded.find((r) => r.kind === 'insert.values')!
      .args[0] as Record<string, unknown>;
    expect(values).toEqual({
      sessionId: 'sess-1',
      aidA: 'aid:pubkey:A',
      aidB: 'aid:pubkey:B',
      status: 'started',
      runId: 'run-9',
      boundary: 'org-a<->org-b',
      startedAt: ts,
    });
    // Replayed events must not clobber existing rows.
    expect(
      recorded.find((r) => r.kind === 'insert.onConflictDoNothing'),
    ).toBeDefined();
  });

  it('nulls out missing aids/runId and non-string boundary', async () => {
    await sessionMonitor.onEvent(
      event({ sessionId: 'sess-2', payload: { boundary: 42 } }),
    );
    const values = recorded.find((r) => r.kind === 'insert.values')!
      .args[0] as Record<string, unknown>;
    expect(values.aidA).toBeNull();
    expect(values.aidB).toBeNull();
    expect(values.runId).toBeNull();
    expect(values.boundary).toBeNull();
  });
});

describe('sessionMonitor.onEvent — handshake.complete', () => {
  it('marks the session complete with grants and completedAt', async () => {
    await sessionMonitor.onEvent(
      event({
        type: 'handshake.complete',
        sessionId: 'sess-1',
        grants: ['demo.echo', 'demo.sum'],
      }),
    );
    const set = recorded.find((r) => r.kind === 'update.set')!
      .args[0] as Record<string, unknown>;
    expect(set.status).toBe('complete');
    expect(set.completedAt).toBe(ts);
    expect(set.grants).toEqual(['demo.echo', 'demo.sum']);
    expect(typeof set.updatedAt).toBe('string');
  });

  it('defaults grants to [] when the event carries none', async () => {
    await sessionMonitor.onEvent(
      event({ type: 'handshake.complete', sessionId: 'sess-1' }),
    );
    const set = recorded.find((r) => r.kind === 'update.set')!
      .args[0] as Record<string, unknown>;
    expect(set.grants).toEqual([]);
  });
});

describe('sessionMonitor.onEvent — handshake.failed', () => {
  it('marks the session failed with the payload error string', async () => {
    await sessionMonitor.onEvent(
      event({
        type: 'handshake.failed',
        sessionId: 'sess-1',
        payload: { error: 'signature mismatch' },
      }),
    );
    const set = recorded.find((r) => r.kind === 'update.set')!
      .args[0] as Record<string, unknown>;
    expect(set.status).toBe('failed');
    expect(set.error).toBe('signature mismatch');
  });

  it('stores error=null when the payload error is not a string', async () => {
    await sessionMonitor.onEvent(
      event({
        type: 'handshake.failed',
        sessionId: 'sess-1',
        payload: { error: { code: 42 } },
      }),
    );
    const set = recorded.find((r) => r.kind === 'update.set')!
      .args[0] as Record<string, unknown>;
    expect(set.error).toBeNull();
  });
});

describe('sessionMonitor.onEvent — filtering and resilience', () => {
  it('ignores events without a sessionId', async () => {
    await sessionMonitor.onEvent(event({ sessionId: undefined }));
    expect(recorded.length).toBe(0);
  });

  it('ignores event types outside the handshake lifecycle', async () => {
    await sessionMonitor.onEvent(
      event({ type: 'capability.invoked', sessionId: 'sess-1' }),
    );
    expect(recorded.length).toBe(0);
  });

  it('swallows DB errors instead of rejecting (audit path must not break)', async () => {
    throwOnWrite = true;
    await expect(
      sessionMonitor.onEvent(event({ sessionId: 'sess-1' })),
    ).resolves.toBeUndefined();
    await expect(
      sessionMonitor.onEvent(
        event({ type: 'handshake.complete', sessionId: 'sess-1' }),
      ),
    ).resolves.toBeUndefined();
  });
});
