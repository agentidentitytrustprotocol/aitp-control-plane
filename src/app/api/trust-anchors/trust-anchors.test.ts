// Unit tests for /api/trust-anchors (collection).
//   • GET  — lists anchors via rowOut projection; ?namespace= adds a WHERE
//   • POST — 400 on non-JSON body / non-http(s) issuerUrl, 201 on success
//            (defaulting namespace to 'default'), 409 ALREADY_EXISTS when
//            the unique-violation (PG 23505) surfaces from the insert.
//
// @/lib/db is mocked with chained stubs (no Postgres). No Idempotency-Key
// header is sent, so withIdempotency runs the handler directly.

import { jest } from '@jest/globals';

let selectResults: unknown[][] = [];
const whereCalls: unknown[] = [];
const insertedValues: unknown[] = [];
let insertError: unknown = null;

jest.mock('@/lib/db', () => {
  const makeSelectChain = () => {
    const result = selectResults.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = (arg: unknown) => {
      whereCalls.push(arg);
      return chain;
    };
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
          return insertError ? Promise.reject(insertError) : Promise.resolve();
        },
      }),
    },
  };
});

const writeAdminAuditMock = jest.fn(async (_e: unknown) => undefined);
jest.mock('@/lib/audit-log/service', () => ({
  writeAdminAudit: (e: unknown) => writeAdminAuditMock(e),
}));

import { GET, POST } from './route';
import { NextRequest } from 'next/server';

function makeReq(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(`http://localhost:4000${path}`, init));
}

function anchorRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ta-1',
    namespace: 'default',
    issuerUrl: 'https://issuer.example.com',
    jwksUrl: null,
    label: null,
    jwksCachedAt: null,
    addedBy: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  selectResults = [];
  whereCalls.length = 0;
  insertedValues.length = 0;
  insertError = null;
  writeAdminAuditMock.mockReset();
  writeAdminAuditMock.mockResolvedValue(undefined);
});

describe('GET /api/trust-anchors', () => {
  it('lists anchors through the rowOut projection', async () => {
    selectResults = [[anchorRow()]];
    const res = await GET(makeReq('/api/trust-anchors'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trustAnchors: Record<string, unknown>[] };
    expect(body.trustAnchors).toHaveLength(1);
    expect(body.trustAnchors[0]).toEqual(anchorRow());
    // No namespace filter → no WHERE clause.
    expect(whereCalls).toHaveLength(0);
  });

  it('applies a WHERE clause when ?namespace= is given', async () => {
    selectResults = [[]];
    const res = await GET(makeReq('/api/trust-anchors?namespace=prod'));
    expect(res.status).toBe(200);
    expect(whereCalls).toHaveLength(1);
  });
});

describe('POST /api/trust-anchors', () => {
  it('returns 400 BODY_INVALID for a non-JSON body', async () => {
    const res = await POST(
      makeReq('/api/trust-anchors', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
  });

  it('returns 400 BODY_INVALID when issuerUrl is not an http(s) URL', async () => {
    for (const issuerUrl of ['ftp://x.example.com', 'issuer.example.com', 42]) {
      const res = await POST(
        makeReq('/api/trust-anchors', {
          method: 'POST',
          body: JSON.stringify({ issuerUrl }),
        }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
    }
    expect(insertedValues).toHaveLength(0);
  });

  it('creates with defaulted namespace and returns 201 + the created row', async () => {
    selectResults = [[anchorRow({ id: 'ta-new' })]]; // re-read after insert
    const res = await POST(
      makeReq('/api/trust-anchors', {
        method: 'POST',
        body: JSON.stringify({ issuerUrl: 'https://issuer.example.com' }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; namespace: string };
    expect(body.id).toBe('ta-new');
    expect(insertedValues).toHaveLength(1);
    const inserted = insertedValues[0] as { namespace: string; jwksUrl: unknown };
    expect(inserted.namespace).toBe('default');
    expect(inserted.jwksUrl).toBeNull();
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
  });

  it('translates a PG 23505 unique violation into 409 ALREADY_EXISTS with the existing id', async () => {
    insertError = { code: '23505' };
    selectResults = [[{ id: 'ta-existing' }]]; // lookup of the conflicting row
    const res = await POST(
      makeReq('/api/trust-anchors', {
        method: 'POST',
        body: JSON.stringify({
          namespace: 'prod',
          issuerUrl: 'https://issuer.example.com',
        }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; existing?: { id: string } };
    expect(body.code).toBe('ALREADY_EXISTS');
    expect(body.existing).toEqual({ id: 'ta-existing' });
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });
});
