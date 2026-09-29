// Unit tests for /api/pinned-keys.
//   • GET    — list mode vs single-lookup mode (?aid=, namespace defaults
//              to 'default'), 404 when the (namespace, aid) pair is missing
//   • POST   — validation: aid required, pubkey must be 43-char base64url,
//              expiresAt must parse; 201 upsert on success
//   • DELETE — 400 without ?aid=, 404 when nothing deleted, 204 on success
//
// @/lib/db is mocked with chained stubs (insert supports onConflictDoUpdate).
// No Idempotency-Key header is sent, so withIdempotency runs directly.

import { jest } from '@jest/globals';

let selectResults: unknown[][] = [];
let deleteReturning: unknown[] = [];
const insertedValues: unknown[] = [];
const conflictSets: unknown[] = [];

jest.mock('@/lib/db', () => {
  const makeSelectChain = () => {
    const result = selectResults.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => Promise.resolve(result);
    chain.limit = () => Promise.resolve(result);
    return chain;
  };
  return {
    db: {
      select: () => makeSelectChain(),
      insert: () => ({
        values: (v: unknown) => {
          insertedValues.push(v);
          return {
            onConflictDoUpdate: (arg: { set: unknown }) => {
              conflictSets.push(arg.set);
              return Promise.resolve();
            },
          };
        },
      }),
      delete: () => ({
        where: () => ({ returning: () => Promise.resolve(deleteReturning) }),
      }),
    },
  };
});

const writeAdminAuditMock = jest.fn(async (_e: unknown) => undefined);
jest.mock('@/lib/audit-log/service', () => ({
  writeAdminAudit: (e: unknown) => writeAdminAuditMock(e),
}));

import { GET, POST, DELETE } from './route';
import { NextRequest } from 'next/server';

function makeReq(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(`http://localhost:4000${path}`, init));
}

const GOOD_PUBKEY = 'A'.repeat(43); // 43-char base64url

function keyRow(over: Record<string, unknown> = {}) {
  return {
    namespace: 'default',
    aid: 'aid:pubkey:abc',
    pubkey: GOOD_PUBKEY,
    label: null,
    expiresAt: null,
    addedBy: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  selectResults = [];
  deleteReturning = [];
  insertedValues.length = 0;
  conflictSets.length = 0;
  writeAdminAuditMock.mockReset();
  writeAdminAuditMock.mockResolvedValue(undefined);
});

describe('GET /api/pinned-keys', () => {
  it('lists rows under the pinnedKeys envelope when no ?aid is given', async () => {
    selectResults = [[keyRow()]];
    const res = await GET(makeReq('/api/pinned-keys'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pinnedKeys: unknown[] };
    expect(body.pinnedKeys).toHaveLength(1);
    expect(body.pinnedKeys[0]).toEqual(keyRow());
  });

  it('returns a single bare object for ?aid= lookup', async () => {
    selectResults = [[keyRow()]];
    const res = await GET(makeReq('/api/pinned-keys?aid=aid%3Apubkey%3Aabc'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aid: string; pinnedKeys?: unknown };
    expect(body.aid).toBe('aid:pubkey:abc');
    expect(body.pinnedKeys).toBeUndefined();
  });

  it('returns 404 NOT_FOUND when the (namespace, aid) pair is missing', async () => {
    selectResults = [[]];
    const res = await GET(makeReq('/api/pinned-keys?aid=aid%3Apubkey%3Amissing'));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('POST /api/pinned-keys', () => {
  function post(body: unknown) {
    return POST(
      makeReq('/api/pinned-keys', { method: 'POST', body: JSON.stringify(body) }),
    );
  }

  it('returns 400 BODY_INVALID for a non-JSON body', async () => {
    const res = await POST(
      makeReq('/api/pinned-keys', { method: 'POST', body: 'nope' }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
  });

  it('requires aid', async () => {
    const res = await post({ pubkey: GOOD_PUBKEY });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('aid is required');
  });

  it('rejects malformed pubkeys (wrong length or non-base64url chars)', async () => {
    for (const pubkey of ['A'.repeat(42), 'A'.repeat(44), '+'.repeat(43), 7]) {
      const res = await post({ aid: 'aid:pubkey:abc', pubkey });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/base64url/);
    }
    expect(insertedValues).toHaveLength(0);
  });

  it('rejects an unparseable expiresAt', async () => {
    const res = await post({
      aid: 'aid:pubkey:abc',
      pubkey: GOOD_PUBKEY,
      expiresAt: 'not-a-date',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/expiresAt/);
  });

  // The window is what this route can WRITE: `toISOString()` leaves the
  // four-digit-year form outside 0000-9999 and Postgres cannot parse the
  // expanded form, and Postgres has no year zero, so the floor sits a year
  // above where the serialization changes. Both ends are pinned by the
  // millisecond either side, so widening or narrowing the bound fails here
  // rather than in production.
  describe('expiresAt range', () => {
    const INSIDE = [
      ['the low bound exactly', '0001-01-01T00:00:00.000Z'],
      ['the high bound exactly', '9999-12-31T23:59:59.999Z'],
      ['a year Postgres stores but the epoch would exclude', '0099-12-31T23:59:59.999Z'],
      ['a pre-epoch instant', '1969-12-31T23:59:59.999Z'],
    ] as const;

    const OUTSIDE = [
      // One millisecond under the floor. Renders as `0000-12-31T…`, which
      // `new Date` is perfectly happy with and Postgres answers 22008.
      ['one ms below the low bound', '0000-12-31T23:59:59.999Z'],
      // One millisecond over the ceiling — `toISOString()` would emit
      // `+010000-01-01T00:00:00.000Z` (22009).
      ['one ms above the high bound', '+010000-01-01T00:00:00.000Z'],
      // Negative years reach Postgres as `-000001-…` (22007).
      ['a negative year', '-000001-12-31T23:59:59.999Z'],
      // The JS extremes, which the NaN check does not catch.
      ['the maximum Date', '+275760-09-13T00:00:00.000Z'],
      ['the minimum Date', '-271821-04-20T00:00:00.000Z'],
      // The bound is on the UTC instant, not the digits: these two read as
      // in-range years but are 0000-12-31T10:00Z and +010000-01-01T00:59Z.
      ['year 0001 pushed below zero by a +14:00 offset', '0001-01-01T00:00:00.000+14:00'],
      ['year 9999 pushed past it by a -01:00 offset', '9999-12-31T23:59:59.999-01:00'],
    ] as const;

    it.each(OUTSIDE)('rejects %s with 400 BODY_INVALID and no insert', async (_w, v) => {
      const res = await post({ aid: 'aid:pubkey:abc', pubkey: GOOD_PUBKEY, expiresAt: v });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('BODY_INVALID');
      expect(body.error).toMatch(/expiresAt must be between/);
      // The whole point: decided from the body, before any SQL runs.
      expect(insertedValues).toHaveLength(0);
    });

    it.each(INSIDE)('accepts %s', async (_w, v) => {
      selectResults = [[keyRow()]];
      const res = await post({ aid: 'aid:pubkey:abc', pubkey: GOOD_PUBKEY, expiresAt: v });
      expect(res.status).toBe(201);
      expect(insertedValues).toHaveLength(1);
      // Stored normalized, and still inside the window after normalization.
      const stored = (insertedValues[0] as { expiresAt: string }).expiresAt;
      expect(stored).toBe(new Date(v).toISOString());
      expect(stored).toMatch(/^\d{4}-/);
    });
  });

  // `label` is varchar(128), not unbounded text, so both a 129th character
  // (22001) and a U+0000 (22021) are values the column cannot hold. Same
  // unguarded insert, same misclassified 500.
  describe('label', () => {
    it('accepts exactly 128 characters', async () => {
      selectResults = [[keyRow()]];
      const res = await post({
        aid: 'aid:pubkey:abc',
        pubkey: GOOD_PUBKEY,
        label: 'x'.repeat(128),
      });
      expect(res.status).toBe(201);
      expect(insertedValues).toHaveLength(1);
    });

    it('rejects 129 characters with 400 BODY_INVALID and no insert', async () => {
      const res = await post({
        aid: 'aid:pubkey:abc',
        pubkey: GOOD_PUBKEY,
        label: 'x'.repeat(129),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('BODY_INVALID');
      expect(body.error).toMatch(/label exceeds 128/);
      expect(insertedValues).toHaveLength(0);
    });

    // Postgres counts varchar(n) in code points, so these 65 astral
    // characters — 130 UTF-16 units, 260 bytes — fit in varchar(128). A
    // `.length` check would reject them; that would be a fabricated 400.
    it('counts code points, not UTF-16 units: 65 astral characters fit', async () => {
      selectResults = [[keyRow()]];
      const label = '\u{1F600}'.repeat(65);
      expect(label.length).toBe(130); // the trap this guards against
      const res = await post({ aid: 'aid:pubkey:abc', pubkey: GOOD_PUBKEY, label });
      expect(res.status).toBe(201);
      expect(insertedValues).toHaveLength(1);
    });

    it('rejects a NUL character, reachable through the \\u0000 JSON escape', async () => {
      // Built by parsing the escape, which is how a real caller sends it —
      // a raw NUL byte is invalid JSON and dies at req.json() instead.
      const parsed = JSON.parse('{"label":"ops\\u0000team"}') as { label: string };
      expect(parsed.label).toContain(' ');
      const res = await post({
        aid: 'aid:pubkey:abc',
        pubkey: GOOD_PUBKEY,
        label: parsed.label,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('BODY_INVALID');
      expect(body.error).toMatch(/NUL/);
      expect(insertedValues).toHaveLength(0);
    });

    it('allows other control characters — a newline in operator prose stores fine', async () => {
      selectResults = [[keyRow()]];
      const res = await post({
        aid: 'aid:pubkey:abc',
        pubkey: GOOD_PUBKEY,
        label: 'ops\n\tteam',
      });
      expect(res.status).toBe(201);
      expect((insertedValues[0] as { label: string }).label).toBe('ops\n\tteam');
    });
  });

  it('upserts and returns 201 with the stored row (namespace defaults, expiresAt normalized to ISO)', async () => {
    selectResults = [[keyRow({ label: 'ops' })]]; // re-read after upsert
    const res = await post({
      aid: 'aid:pubkey:abc',
      pubkey: GOOD_PUBKEY,
      label: 'ops',
      expiresAt: '2026-12-31T00:00:00Z',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { aid: string; label: string };
    expect(body.aid).toBe('aid:pubkey:abc');
    expect(body.label).toBe('ops');

    expect(insertedValues).toHaveLength(1);
    const inserted = insertedValues[0] as Record<string, unknown>;
    expect(inserted.namespace).toBe('default');
    expect(inserted.expiresAt).toBe('2026-12-31T00:00:00.000Z');
    // Conflict branch updates the same pubkey/label/expiresAt.
    const set = conflictSets[0] as Record<string, unknown>;
    expect(set.pubkey).toBe(GOOD_PUBKEY);
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/pinned-keys', () => {
  it('returns 400 BAD_REQUEST when ?aid is missing', async () => {
    const res = await DELETE(makeReq('/api/pinned-keys', { method: 'DELETE' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('returns 404 when no row matched', async () => {
    deleteReturning = [];
    const res = await DELETE(
      makeReq('/api/pinned-keys?aid=aid%3Apubkey%3Amissing', { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  it('returns 204 with an empty body on success', async () => {
    deleteReturning = [{ aid: 'aid:pubkey:abc' }];
    const res = await DELETE(
      makeReq('/api/pinned-keys?aid=aid%3Apubkey%3Aabc', { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
  });
});
