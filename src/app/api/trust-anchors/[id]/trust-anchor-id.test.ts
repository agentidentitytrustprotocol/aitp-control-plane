// Unit tests for /api/trust-anchors/[id].
//   • GET    — 404 when the id is unknown, 200 + rowOut projection otherwise
//   • PATCH  — 400 on non-JSON body, 404 when update matches no row,
//              200 with only whitelisted fields applied (issuerUrl must be a
//              string; jwksUrl/label accept string or null)
//   • DELETE — 404 when nothing was deleted, 204 (empty body) on success
//
// @/lib/db is mocked with chained stubs; params arrive as a Promise per the
// Next 15 dynamic-route handler signature.

import { jest } from '@jest/globals';

let selectResult: unknown[] = [];
let updateReturning: unknown[] = [];
let deleteReturning: unknown[] = [];
const setCalls: unknown[] = [];

jest.mock('@/lib/db', () => {
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.limit = () => Promise.resolve(selectResult);
  return {
    db: {
      select: () => selectChain,
      update: () => ({
        set: (patch: unknown) => {
          setCalls.push(patch);
          return {
            where: () => ({ returning: () => Promise.resolve(updateReturning) }),
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

import { GET, PATCH, DELETE } from './route';
import { NextRequest } from 'next/server';

function makeReq(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(`http://localhost:4000${path}`, init));
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function anchorRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ta-1',
    namespace: 'default',
    issuerUrl: 'https://issuer.example.com',
    jwksUrl: null,
    label: 'primary',
    jwksCachedAt: null,
    addedBy: 'admin',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  selectResult = [];
  updateReturning = [];
  deleteReturning = [];
  setCalls.length = 0;
  writeAdminAuditMock.mockReset();
  writeAdminAuditMock.mockResolvedValue(undefined);
});

describe('GET /api/trust-anchors/[id]', () => {
  it('returns 404 NOT_FOUND for an unknown id', async () => {
    const res = await GET(makeReq('/api/trust-anchors/nope'), ctx('nope'));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('returns the projected row (no addedBy field on this route)', async () => {
    selectResult = [anchorRow()];
    const res = await GET(makeReq('/api/trust-anchors/ta-1'), ctx('ta-1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe('ta-1');
    expect(body.issuerUrl).toBe('https://issuer.example.com');
    // rowOut on the [id] route intentionally omits addedBy.
    expect('addedBy' in body).toBe(false);
  });
});

describe('PATCH /api/trust-anchors/[id]', () => {
  it('returns 400 BODY_INVALID for a non-JSON body', async () => {
    const res = await PATCH(
      makeReq('/api/trust-anchors/ta-1', { method: 'PATCH', body: '{{' }),
      ctx('ta-1'),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
  });

  it('returns 404 when the update matches no row', async () => {
    updateReturning = [];
    const res = await PATCH(
      makeReq('/api/trust-anchors/gone', {
        method: 'PATCH',
        body: JSON.stringify({ label: 'x' }),
      }),
      ctx('gone'),
    );
    expect(res.status).toBe(404);
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  it('applies only whitelisted, correctly-typed fields', async () => {
    updateReturning = [anchorRow({ label: 'renamed' })];
    const res = await PATCH(
      makeReq('/api/trust-anchors/ta-1', {
        method: 'PATCH',
        body: JSON.stringify({
          issuerUrl: 12345, // wrong type — must be ignored
          jwksUrl: null, // explicit null is allowed
          label: 'renamed',
          namespace: 'evil', // not a patchable field
        }),
      }),
      ctx('ta-1'),
    );
    expect(res.status).toBe(200);
    const patch = setCalls[0] as Record<string, unknown>;
    expect(patch.issuerUrl).toBeUndefined();
    expect(patch.jwksUrl).toBeNull();
    expect(patch.label).toBe('renamed');
    expect('namespace' in patch).toBe(false);
    expect(typeof patch.updatedAt).toBe('string');
    const body = (await res.json()) as { label: string };
    expect(body.label).toBe('renamed');
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/trust-anchors/[id]', () => {
  it('returns 404 when nothing was deleted', async () => {
    const res = await DELETE(makeReq('/api/trust-anchors/gone'), ctx('gone'));
    expect(res.status).toBe(404);
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  it('returns 204 with an empty body on success', async () => {
    deleteReturning = [{ id: 'ta-1' }];
    const res = await DELETE(makeReq('/api/trust-anchors/ta-1'), ctx('ta-1'));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
  });
});
