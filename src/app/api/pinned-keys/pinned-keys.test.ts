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
