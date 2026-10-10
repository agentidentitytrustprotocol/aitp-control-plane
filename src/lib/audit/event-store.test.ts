// Unit tests for the pure query-shaping logic in queryHistory: ISO-date
// validation (parseIsoOrThrow) and limit/offset clamping. The DB chain is
// mocked so we assert the parameters the query builder computes, not the
// SQL execution (that lives in integration tests).
import { jest } from '@jest/globals';

const captured: {
  limit?: number;
  offset?: number;
  whereCalled: boolean;
  insertCalls: number;
  insertedValues?: unknown[];
  onConflict?: boolean;
  returningKeys?: string[];
  returnRows: Array<{ id: string }>;
} = {
  whereCalled: false,
  insertCalls: 0,
  returnRows: [],
};

jest.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => {
    captured.whereCalled = true;
    return chain;
  };
  chain.orderBy = () => chain;
  chain.limit = (n: number) => {
    captured.limit = n;
    return chain;
  };
  chain.offset = (n: number) => {
    captured.offset = n;
    return Promise.resolve([]);
  };
  const insertChain = {
    values: (rows: unknown[]) => {
      captured.insertedValues = rows;
      return insertChain;
    },
    onConflictDoNothing: () => {
      captured.onConflict = true;
      return insertChain;
    },
    returning: (shape: Record<string, unknown>) => {
      captured.returningKeys = Object.keys(shape);
      return Promise.resolve(captured.returnRows);
    },
  };
  return {
    db: {
      select: () => chain,
      insert: () => {
        captured.insertCalls += 1;
        return insertChain;
      },
    },
  };
});

import { InvalidFilterError, ingestEvents, queryHistory } from './event-store';
import type { AuditEventRecord } from './stream';

beforeEach(() => {
  captured.limit = undefined;
  captured.offset = undefined;
  captured.whereCalled = false;
  captured.insertCalls = 0;
  captured.insertedValues = undefined;
  captured.onConflict = undefined;
  captured.returningKeys = undefined;
  captured.returnRows = [];
});

describe('queryHistory date validation', () => {
  it('rejects an unparseable `since` with InvalidFilterError', async () => {
    await expect(queryHistory({ since: 'not-a-date' })).rejects.toBeInstanceOf(
      InvalidFilterError,
    );
  });

  it('rejects an unparseable `until` with InvalidFilterError', async () => {
    await expect(queryHistory({ until: 'whenever' })).rejects.toBeInstanceOf(
      InvalidFilterError,
    );
  });

  it('accepts a valid ISO `since` and applies a WHERE clause', async () => {
    await queryHistory({ since: '2026-01-01T00:00:00Z' });
    expect(captured.whereCalled).toBe(true);
  });

  it('applies no WHERE clause when there are no filters', async () => {
    await queryHistory({});
    expect(captured.whereCalled).toBe(false);
  });
});

describe('queryHistory limit/offset clamping', () => {
  it('defaults to limit 100 / offset 0', async () => {
    await queryHistory({});
    expect(captured.limit).toBe(100);
    expect(captured.offset).toBe(0);
  });

  it('caps limit at 1000', async () => {
    await queryHistory({ limit: 50_000 });
    expect(captured.limit).toBe(1000);
  });

  it('floors limit at 1', async () => {
    await queryHistory({ limit: 0 });
    expect(captured.limit).toBe(1);
  });

  it('floors a negative offset at 0', async () => {
    await queryHistory({ offset: -10 });
    expect(captured.offset).toBe(0);
  });
});

describe('ingestEvents', () => {
  const rec = (id: string): AuditEventRecord => ({
    id,
    type: 't',
    ts: '2026-01-01T00:00:00.000Z',
    payload: {},
  });

  it('returns [] without touching the DB for an empty batch', async () => {
    await expect(ingestEvents([])).resolves.toEqual([]);
    expect(captured.insertCalls).toBe(0);
  });

  it('inserts ON CONFLICT DO NOTHING and returns only the ids RETURNING yielded', async () => {
    captured.returnRows = [{ id: 'b' }];
    await expect(ingestEvents([rec('a'), rec('b')])).resolves.toEqual(['b']);
    expect(captured.insertCalls).toBe(1);
    expect(captured.insertedValues).toHaveLength(2);
    expect(captured.onConflict).toBe(true);
    expect(captured.returningKeys).toEqual(['id']);
  });

  it('returns [] when every row already existed', async () => {
    captured.returnRows = [];
    await expect(ingestEvents([rec('a')])).resolves.toEqual([]);
  });
});
