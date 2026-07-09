// Unit tests for withIdempotency — the DB-free half of the behavior
// (the live-Postgres paths are covered by idempotency.integration.test.ts).
// We mock `./db` with queued select results and a recording insert chain.
// Verifies: header-absent passthrough, key validation (empty/too-long/
// control chars, raw-before-trim check), replay of cached rows with the
// Idempotency-Replayed header, which statuses get persisted (2xx + stable
// 4xx, never 5xx/auth), JSONB body normalization, lost-race replay of the
// winning row, and resilience to a failing insert.

import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

let selectQueue: unknown[][] = [];
let selectCallCount = 0;
const insertValues: Record<string, unknown>[] = [];
let insertShouldThrow = false;

jest.mock('./db', () => ({
  db: {
    select: () => {
      selectCallCount += 1;
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => Promise.resolve(selectQueue.shift() ?? []);
      return chain;
    },
    insert: () => ({
      values: (arg: Record<string, unknown>) => {
        insertValues.push(arg);
        return {
          onConflictDoNothing: () =>
            insertShouldThrow
              ? Promise.reject(new Error('unique_violation storm'))
              : Promise.resolve(undefined),
        };
      },
    }),
  },
}));

import { withIdempotency, type IdempotentResult } from './idempotency';

function makeReq(key?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return new NextRequest(
    new Request('http://localhost:4000/api/registry/agents', {
      method: 'POST',
      headers,
    }),
  );
}

/** The WHATWG Headers class rejects NUL/CR/LF outright and strips
 * leading/trailing whitespace, so raw control-character values can never
 * survive a real NextRequest round-trip in this test. Stub the one
 * method withIdempotency reads to exercise the raw validator directly. */
function makeRawHeaderReq(raw: string): NextRequest {
  return {
    headers: { get: (name: string) => (name === 'idempotency-key' ? raw : null) },
  } as unknown as NextRequest;
}

function execReturning(result: IdempotentResult) {
  const exec = jest.fn<() => Promise<IdempotentResult>>();
  exec.mockResolvedValue(result);
  return exec;
}

beforeEach(() => {
  selectQueue = [];
  selectCallCount = 0;
  insertValues.length = 0;
  insertShouldThrow = false;
});

describe('withIdempotency — header absent', () => {
  it('runs the handler and returns its result with no lookup, no persist, no replay header', async () => {
    const exec = execReturning({ status: 201, body: { id: 'a-1' } });
    const res = await withIdempotency(makeReq(), 'scope', exec);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'a-1' });
    expect(res.headers.get('Idempotency-Replayed')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(selectCallCount).toBe(0);
    expect(insertValues).toEqual([]);
  });
});

describe('withIdempotency — key validation', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['over 255 chars', 'k'.repeat(256)],
  ])('rejects %s with 400 and never runs the handler', async (_name, key) => {
    const exec = execReturning({ status: 201, body: { id: 'x' } });
    const res = await withIdempotency(makeReq(key), 'scope', exec);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(exec).not.toHaveBeenCalled();
    expect(selectCallCount).toBe(0);
  });

  it.each([
    ['embedded newline', 'bad\nkey'],
    ['embedded tab', 'bad\tkey'],
    ['leading control chars that trim() would hide', '\n\nkey'],
    ['NUL byte', 'a\x00b'],
  ])(
    'rejects a raw header value with %s (validated before trim)',
    async (_name, raw) => {
      const exec = execReturning({ status: 201, body: { id: 'x' } });
      const res = await withIdempotency(makeRawHeaderReq(raw), 'scope', exec);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(exec).not.toHaveBeenCalled();
      expect(selectCallCount).toBe(0);
    },
  );

  it('accepts a key of exactly 255 chars', async () => {
    selectQueue = [[], []];
    const exec = execReturning({ status: 200, body: { ok: true } });
    const res = await withIdempotency(makeReq('k'.repeat(255)), 'scope', exec);
    expect(res.status).toBe(200);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('trims surrounding whitespace before persisting the key', async () => {
    selectQueue = [[], []];
    const exec = execReturning({ status: 201, body: { id: 'a-1' } });
    await withIdempotency(makeReq('  my-key  '), 'agents.register', exec);
    expect(insertValues).toEqual([
      {
        scope: 'agents.register',
        key: 'my-key',
        responseStatus: 201,
        responseBody: { id: 'a-1' },
      },
    ]);
  });
});

describe('withIdempotency — cache hit', () => {
  it('replays the stored response without running the handler', async () => {
    selectQueue = [
      [
        {
          scope: 'scope',
          key: 'k1',
          responseStatus: 201,
          responseBody: { id: 'original' },
        },
      ],
    ];
    const exec = execReturning({ status: 201, body: { id: 'would-be-new' } });
    const res = await withIdempotency(makeReq('k1'), 'scope', exec);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'original' });
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(exec).not.toHaveBeenCalled();
    expect(insertValues).toEqual([]);
  });
});

describe('withIdempotency — persistence policy on a miss', () => {
  it.each([200, 201, 202, 400, 409, 422])(
    'persists stable outcome %i',
    async (status) => {
      selectQueue = [[], []];
      const exec = execReturning({ status, body: { s: status } });
      const res = await withIdempotency(makeReq('k1'), 'scope', exec);
      expect(res.status).toBe(status);
      expect(insertValues.length).toBe(1);
      expect(insertValues[0].responseStatus).toBe(status);
    },
  );

  it('persists a 204 and responds bodyless (null-body status)', async () => {
    selectQueue = [[], []];
    const exec = execReturning({ status: 204, body: undefined });
    const res = await withIdempotency(makeReq('k1'), 'scope', exec);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(insertValues.length).toBe(1);
    expect(insertValues[0].responseStatus).toBe(204);
  });

  it('replays a cached 204 bodyless with the replay header', async () => {
    selectQueue = [
      [{ scope: 'scope', key: 'k1', responseStatus: 204, responseBody: null }],
    ];
    const exec = execReturning({ status: 204, body: undefined });
    const res = await withIdempotency(makeReq('k1'), 'scope', exec);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(exec).not.toHaveBeenCalled();
  });

  it('skips caching an un-JSON-encodable body but still returns the status', async () => {
    selectQueue = [[]];
    const exec = execReturning({ status: 200, body: { n: BigInt(1) } });
    const res = await withIdempotency(makeReq('k1'), 'scope', exec);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull(); // body cannot be carried as JSON
    expect(insertValues).toEqual([]); // and must not be cached
  });

  it.each([500, 502, 401, 403, 429])(
    'does NOT persist transient/auth outcome %i',
    async (status) => {
      selectQueue = [[]];
      const exec = execReturning({ status, body: { s: status } });
      const res = await withIdempotency(makeReq('k1'), 'scope', exec);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ s: status });
      expect(res.headers.get('Idempotency-Replayed')).toBeNull();
      expect(insertValues).toEqual([]);
      expect(selectCallCount).toBe(1); // no winner re-read either
    },
  );

  it('normalizes the body JSONB-style before persisting (Dates → ISO, undefined dropped)', async () => {
    selectQueue = [[], []];
    const exec = execReturning({
      status: 201,
      body: {
        id: 'a-1',
        createdAt: new Date('2026-01-02T03:04:05.000Z') as unknown,
        skipMe: undefined,
      },
    });
    await withIdempotency(makeReq('k1'), 'scope', exec);
    expect(insertValues[0].responseBody).toEqual({
      id: 'a-1',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(
      Object.keys(insertValues[0].responseBody as Record<string, unknown>),
    ).toEqual(['id', 'createdAt']);
  });
});

describe('withIdempotency — insert race and failure handling', () => {
  it('returns our own response (not replayed) when we win the insert', async () => {
    selectQueue = [
      [], // cache miss
      [{ responseStatus: 201, responseBody: { id: 'mine' } }], // winner = us
    ];
    const exec = execReturning({ status: 201, body: { id: 'mine' } });
    const res = await withIdempotency(makeReq('k1'), 'scope', exec);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'mine' });
    expect(res.headers.get('Idempotency-Replayed')).toBeNull();
  });

  it("returns the racing peer's winning row, flagged as replayed", async () => {
    selectQueue = [
      [], // cache miss
      [{ responseStatus: 201, responseBody: { id: 'peer-won' } }],
    ];
    const exec = execReturning({ status: 201, body: { id: 'we-lost' } });
    const res = await withIdempotency(makeReq('k1'), 'scope', exec);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'peer-won' });
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
  });

  it('falls back to our normalized response if the winner re-read finds nothing', async () => {
    selectQueue = [[], []];
    const exec = execReturning({ status: 201, body: { id: 'a-1' } });
    const res = await withIdempotency(makeReq('k1'), 'scope', exec);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'a-1' });
    expect(res.headers.get('Idempotency-Replayed')).toBeNull();
  });

  it('still returns the handler response when the insert itself throws', async () => {
    insertShouldThrow = true;
    selectQueue = [[]];
    const exec = execReturning({ status: 201, body: { id: 'a-1' } });
    const res = await withIdempotency(makeReq('k1'), 'scope', exec);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'a-1' });
    expect(res.headers.get('Idempotency-Replayed')).toBeNull();
    expect(selectCallCount).toBe(1); // no winner re-read after a failed insert
  });
});
