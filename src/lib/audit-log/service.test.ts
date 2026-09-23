// Unit tests for the admin-audit-log service — verifies:
//   • writeAdminAudit persists the right row shape, defaulting optional
//     fields to null/{}
//   • a DB failure on writeAdminAudit is swallowed (never throws) and
//     increments the exported failure counter instead
//   • listAdminAudit clamps limit to [1,1000] and offset to >=0
//
// @/lib/db is mocked with a chained stub. No database.

import { jest } from '@jest/globals';

const insertValuesArgs: unknown[] = [];
let insertShouldReject = false;
const limitArgs: number[] = [];
const offsetArgs: number[] = [];
let rowsToReturn: unknown[] = [];

jest.mock('../db', () => {
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.orderBy = () => selectChain;
  selectChain.limit = (n: number) => {
    limitArgs.push(n);
    return selectChain;
  };
  selectChain.offset = (n: number) => {
    offsetArgs.push(n);
    return Promise.resolve(rowsToReturn);
  };

  return {
    db: {
      insert: () => ({
        values: (v: unknown) => {
          insertValuesArgs.push(v);
          if (insertShouldReject) return Promise.reject(new Error('db down'));
          return Promise.resolve(undefined);
        },
      }),
      select: () => selectChain,
    },
  };
});

jest.mock('node:crypto', () => ({
  randomUUID: () => 'fixed-uuid',
}));

import {
  writeAdminAudit,
  listAdminAudit,
  getAdminAuditInsertFailures,
} from './service';

beforeEach(() => {
  insertValuesArgs.length = 0;
  insertShouldReject = false;
  limitArgs.length = 0;
  offsetArgs.length = 0;
  rowsToReturn = [];
});

describe('writeAdminAudit', () => {
  it('inserts the full row, defaulting optional fields', async () => {
    await writeAdminAudit({ action: 'agent.deregister' });
    expect(insertValuesArgs).toEqual([
      {
        id: 'fixed-uuid',
        action: 'agent.deregister',
        actorId: null,
        targetId: null,
        details: {},
        requestId: null,
      },
    ]);
  });

  it('passes through provided optional fields', async () => {
    await writeAdminAudit({
      action: 'webhook.delete',
      actorId: 'apikey:abcd',
      targetId: 'wh-1',
      details: { reason: 'rotated' },
      requestId: 'req-1',
    });
    expect(insertValuesArgs).toEqual([
      {
        id: 'fixed-uuid',
        action: 'webhook.delete',
        actorId: 'apikey:abcd',
        targetId: 'wh-1',
        details: { reason: 'rotated' },
        requestId: 'req-1',
      },
    ]);
  });

  it('never throws on a DB failure and increments the failure counter instead', async () => {
    insertShouldReject = true;
    const before = getAdminAuditInsertFailures();
    await expect(writeAdminAudit({ action: 'x' })).resolves.toBeUndefined();
    expect(getAdminAuditInsertFailures()).toBe(before + 1);
  });
});

describe('listAdminAudit', () => {
  it('defaults to limit 100, offset 0', async () => {
    await listAdminAudit();
    expect(limitArgs).toEqual([100]);
    expect(offsetArgs).toEqual([0]);
  });

  it('clamps an over-large limit down to 1000', async () => {
    await listAdminAudit(5000, 10);
    expect(limitArgs).toEqual([1000]);
    expect(offsetArgs).toEqual([10]);
  });

  it('floors a non-positive limit up to 1', async () => {
    await listAdminAudit(0, 0);
    expect(limitArgs).toEqual([1]);
  });

  it('clamps a negative offset up to 0', async () => {
    await listAdminAudit(50, -5);
    expect(offsetArgs).toEqual([0]);
  });

  it('returns the rows from the query', async () => {
    rowsToReturn = [{ id: 'a' }, { id: 'b' }];
    const rows = await listAdminAudit();
    expect(rows).toEqual(rowsToReturn);
  });
});
