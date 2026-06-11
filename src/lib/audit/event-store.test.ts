// Unit tests for the pure query-shaping logic in queryHistory: ISO-date
// validation (parseIsoOrThrow) and limit/offset clamping. The DB chain is
// mocked so we assert the parameters the query builder computes, not the
// SQL execution (that lives in integration tests).
import { jest } from '@jest/globals';

const captured: { limit?: number; offset?: number; whereCalled: boolean } = {
  whereCalled: false,
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
  return { db: { select: () => chain } };
});

import { InvalidFilterError, queryHistory } from './event-store';

beforeEach(() => {
  captured.limit = undefined;
  captured.offset = undefined;
  captured.whereCalled = false;
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
