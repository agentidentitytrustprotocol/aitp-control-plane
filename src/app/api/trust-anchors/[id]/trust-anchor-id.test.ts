// Unit tests for /api/trust-anchors/[id].
//   • all    — 400 ID_INVALID for a non-UUID :id, before any db access
//   • GET    — 404 when the id is unknown, 200 + rowOut projection otherwise
//   • PATCH  — 400 on non-JSON / non-object body, 400 on unstorable fields
//              (label > 128 code points or NUL, issuerUrl/jwksUrl > 2048 or
//              NUL), 404 when update matches no row, 200 with only
//              whitelisted fields applied (issuerUrl must be a string;
//              jwksUrl/label accept string or null; '' jwksUrl clears)
//   • DELETE — 404 when nothing was deleted, 204 (empty body) on success
//
// @/lib/db is mocked with chained stubs; params arrive as a Promise per the
// Next 15 dynamic-route handler signature.

import { jest } from '@jest/globals';

let selectResult: unknown[] = [];
let updateReturning: unknown[] = [];
let deleteReturning: unknown[] = [];
const setCalls: unknown[] = [];
let dbCalls = 0;

jest.mock('@/lib/db', () => {
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.limit = () => Promise.resolve(selectResult);
  return {
    db: {
      select: () => {
        dbCalls++;
        return selectChain;
      },
      update: () => ({
        set: (patch: unknown) => {
          dbCalls++;
          setCalls.push(patch);
          return {
            where: () => ({ returning: () => Promise.resolve(updateReturning) }),
          };
        },
      }),
      delete: () => {
        dbCalls++;
        return {
          where: () => ({ returning: () => Promise.resolve(deleteReturning) }),
        };
      },
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

// Path ids are validated as UUIDs, so fixtures use real (v4) ones.
const ID = '3f2b8c1e-9a4d-4e5f-8a6b-7c8d9e0f1a2b';
const UNKNOWN_ID = '9b1d6a2c-5e4f-4a3b-9c8d-0e1f2a3b4c5d';

function anchorRow(over: Record<string, unknown> = {}) {
  return {
    id: ID,
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
  dbCalls = 0;
  writeAdminAuditMock.mockReset();
  writeAdminAuditMock.mockResolvedValue(undefined);
});

describe('GET /api/trust-anchors/[id]', () => {
  it('returns 404 NOT_FOUND for an unknown id', async () => {
    const res = await GET(makeReq(`/api/trust-anchors/${UNKNOWN_ID}`), ctx(UNKNOWN_ID));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('returns the projected row (no addedBy field on this route)', async () => {
    selectResult = [anchorRow()];
    const res = await GET(makeReq(`/api/trust-anchors/${ID}`), ctx(ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(ID);
    expect(body.issuerUrl).toBe('https://issuer.example.com');
    // rowOut on the [id] route intentionally omits addedBy.
    expect('addedBy' in body).toBe(false);
  });
});

describe('PATCH /api/trust-anchors/[id]', () => {
  it('returns 400 BODY_INVALID for a non-JSON body', async () => {
    const res = await PATCH(
      makeReq(`/api/trust-anchors/${ID}`, { method: 'PATCH', body: '{{' }),
      ctx(ID),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
  });

  it('returns 404 when the update matches no row', async () => {
    updateReturning = [];
    const res = await PATCH(
      makeReq(`/api/trust-anchors/${UNKNOWN_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ label: 'x' }),
      }),
      ctx(UNKNOWN_ID),
    );
    expect(res.status).toBe(404);
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  it('applies only whitelisted, correctly-typed fields', async () => {
    updateReturning = [anchorRow({ label: 'renamed' })];
    const res = await PATCH(
      makeReq(`/api/trust-anchors/${ID}`, {
        method: 'PATCH',
        body: JSON.stringify({
          issuerUrl: 12345, // wrong type — must be ignored
          jwksUrl: null, // explicit null is allowed
          label: 'renamed',
          namespace: 'evil', // not a patchable field
        }),
      }),
      ctx(ID),
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
    const res = await DELETE(makeReq(`/api/trust-anchors/${UNKNOWN_ID}`), ctx(UNKNOWN_ID));
    expect(res.status).toBe(404);
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  it('returns 204 with an empty body on success', async () => {
    deleteReturning = [{ id: ID }];
    const res = await DELETE(makeReq(`/api/trust-anchors/${ID}`), ctx(ID));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
  });
});

describe('/api/trust-anchors/[id] path-id validation', () => {
  const BAD = 'not-a-uuid';

  async function expectIdInvalid(res: Response) {
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'id must be a UUID', code: 'ID_INVALID' });
    expect(dbCalls).toBe(0);
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  }

  it('GET with a non-UUID id is 400 ID_INVALID and never queries', async () => {
    await expectIdInvalid(await GET(makeReq(`/api/trust-anchors/${BAD}`), ctx(BAD)));
  });

  it('PATCH with a non-UUID id is 400 ID_INVALID, even with a bad body', async () => {
    await expectIdInvalid(
      await PATCH(makeReq(`/api/trust-anchors/${BAD}`, { method: 'PATCH', body: '{{' }), ctx(BAD)),
    );
  });

  it('DELETE with a non-UUID id is 400 ID_INVALID and never queries', async () => {
    await expectIdInvalid(
      await DELETE(makeReq(`/api/trust-anchors/${BAD}`, { method: 'DELETE' }), ctx(BAD)),
    );
  });

  it('accepts a UUID of any version (syntax-only check)', async () => {
    const v7 = '0190a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
    const res = await GET(makeReq(`/api/trust-anchors/${v7}`), ctx(v7));
    expect(res.status).toBe(404);
    expect(dbCalls).toBe(1);
  });
});

describe('PATCH /api/trust-anchors/[id] body validation', () => {
  function patch(body: unknown) {
    return PATCH(
      makeReq(`/api/trust-anchors/${ID}`, {
        method: 'PATCH',
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      ctx(ID),
    );
  }

  async function expectBodyInvalid(res: Response, error?: string) {
    expect(res.status).toBe(400);
    const b = (await res.json()) as { code: string; error: string };
    expect(b.code).toBe('BODY_INVALID');
    if (error) expect(b.error).toBe(error);
    expect(setCalls).toHaveLength(0);
  }

  it('rejects a JSON body that is not an object (null, array, primitive)', async () => {
    for (const b of ['null', '[]', '5', '"x"']) {
      await expectBodyInvalid(await patch(b), 'body must be a JSON object');
    }
  });

  it('label: 128 code points accepted, 129 rejected, NUL rejected', async () => {
    updateReturning = [anchorRow()];
    expect((await patch({ label: 'a'.repeat(128) })).status).toBe(200);
    expect((await patch({ label: '\u{1F600}'.repeat(128) })).status).toBe(200);
    setCalls.length = 0;
    await expectBodyInvalid(await patch({ label: 'a'.repeat(129) }), 'label exceeds 128 character limit');
    await expectBodyInvalid(await patch({ label: 'a\u0000b' }), 'label must not contain a NUL character');
  });

  it('issuerUrl / jwksUrl: over 2048 or NUL rejected', async () => {
    const long = 'https://x.example.com/' + 'a'.repeat(2048);
    await expectBodyInvalid(await patch({ issuerUrl: long }), 'issuerUrl exceeds 2048 character limit');
    await expectBodyInvalid(await patch({ issuerUrl: 'https://x\u0000' }), 'issuerUrl must not contain a NUL character');
    await expectBodyInvalid(await patch({ jwksUrl: long }), 'jwksUrl exceeds 2048 character limit');
    await expectBodyInvalid(await patch({ jwksUrl: 'https://x\u0000' }), 'jwksUrl must not contain a NUL character');
  });

  it('an empty-string jwksUrl clears it (stored as null); label null clears', async () => {
    updateReturning = [anchorRow()];
    const res = await patch({ jwksUrl: '', label: null });
    expect(res.status).toBe(200);
    const p = setCalls[0] as Record<string, unknown>;
    expect(p.jwksUrl).toBeNull();
    expect(p.label).toBeNull();
  });
});
