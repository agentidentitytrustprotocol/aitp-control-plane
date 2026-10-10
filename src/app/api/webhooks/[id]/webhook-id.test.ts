// Unit tests for /api/webhooks/[id].
//   • both   — 400 ID_INVALID for a non-UUID :id, before the service runs
//   • PATCH  — 400 on non-JSON / non-object body; 400 BODY_INVALID for a
//     secret > 255 code points or a NUL in url/events/secret; 400
//     URL_NOT_ALLOWED when the SSRF guard rejects a new url; 404 when the id
//     is unknown; 200 with only correctly-typed fields forwarded (secret
//     accepted in the patch but never echoed back in the response, and never
//     written to the admin audit details — only `secretRotated: true`)
//   • DELETE — 404 when the id is unknown, {id, deleted:true} on success
//
// @/lib/webhooks/service and the url-guard are mocked; params arrive as a
// Promise per the Next 15 dynamic-route handler signature.

import { jest } from '@jest/globals';

jest.mock('@/lib/webhooks/url-guard', () => {
  class UnsafeWebhookUrlError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'UnsafeWebhookUrlError';
    }
  }
  return {
    UnsafeWebhookUrlError,
    assertSafeWebhookUrl: jest.fn(async (_url: string) => undefined),
  };
});

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

const updateWebhookMock = jest.fn(
  async (_id: string, _patch: unknown): Promise<WebhookRow | undefined> => undefined,
);
const deleteWebhookMock = jest.fn(async (_id: string) => false);
const writeAdminAuditMock = jest.fn(async (_e: unknown) => undefined);

jest.mock('@/lib/webhooks/service', () => ({
  updateWebhook: (id: string, p: unknown) => updateWebhookMock(id, p),
  deleteWebhook: (id: string) => deleteWebhookMock(id),
}));
jest.mock('@/lib/audit-log/service', () => ({
  writeAdminAudit: (e: unknown) => writeAdminAuditMock(e),
}));

import { PATCH, DELETE } from './route';
import { NextRequest } from 'next/server';
import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from '@/lib/webhooks/url-guard';

const assertSafeMock = assertSafeWebhookUrl as jest.MockedFunction<
  typeof assertSafeWebhookUrl
>;

// Path ids are validated as UUIDs, so fixtures use real (v4) ones.
const ID = '3f2b8c1e-9a4d-4e5f-8a6b-7c8d9e0f1a2b';
const MISSING = '9b1d6a2c-5e4f-4a3b-9c8d-0e1f2a3b4c5d';

function fakeWebhook(over: Partial<WebhookRow> = {}): WebhookRow {
  return {
    id: ID,
    url: 'https://receiver.example.com/hook',
    events: ['tct.revoked'],
    secret: 'whsec_abc',
    active: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    ...over,
  };
}

function patchReq(id: string, body: unknown): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(
      new Request(`http://localhost:4000/api/webhooks/${id}`, {
        method: 'PATCH',
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    ),
    { params: Promise.resolve({ id }) },
  ];
}

beforeEach(() => {
  updateWebhookMock.mockReset();
  updateWebhookMock.mockResolvedValue(undefined);
  deleteWebhookMock.mockReset();
  deleteWebhookMock.mockResolvedValue(false);
  writeAdminAuditMock.mockReset();
  writeAdminAuditMock.mockResolvedValue(undefined);
  assertSafeMock.mockReset();
  assertSafeMock.mockResolvedValue(undefined);
});

describe('PATCH /api/webhooks/[id]', () => {
  it('returns 400 BODY_INVALID for a non-JSON body', async () => {
    const res = await PATCH(...patchReq(ID, '{{'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
  });

  it('returns 400 URL_NOT_ALLOWED when the guard rejects the new url', async () => {
    assertSafeMock.mockRejectedValue(new UnsafeWebhookUrlError('loopback address'));
    const res = await PATCH(...patchReq(ID, { url: 'http://127.0.0.1/x' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('URL_NOT_ALLOWED');
    expect(updateWebhookMock).not.toHaveBeenCalled();
  });

  it('returns 404 NOT_FOUND when the webhook does not exist', async () => {
    const res = await PATCH(...patchReq(MISSING, { active: false }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  it('forwards only typed fields and never echoes the secret back', async () => {
    updateWebhookMock.mockResolvedValue(fakeWebhook({ active: false }));
    const res = await PATCH(
      ...patchReq(ID, {
        url: 'https://new.example.com/hook',
        events: ['a', 1, 'b'],
        secret: 'whsec_new',
        active: false,
        bogus: 'ignored',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.active).toBe(false);
    expect('secret' in body).toBe(false);

    const [id, patch] = updateWebhookMock.mock.calls[0] as [
      string,
      { url?: string; events?: string[]; secret?: string; active?: boolean },
    ];
    expect(id).toBe(ID);
    expect(patch.url).toBe('https://new.example.com/hook');
    expect(patch.events).toEqual(['a', 'b']);
    expect(patch.secret).toBe('whsec_new');
    expect(patch.active).toBe(false);
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
  });

  it('records secretRotated in the admin audit, never the secret itself', async () => {
    updateWebhookMock.mockResolvedValue(fakeWebhook());
    const res = await PATCH(
      ...patchReq(ID, { url: 'https://new.example.com/hook', secret: 'whsec_TOPSECRET' }),
    );
    expect(res.status).toBe(200);
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
    const entry = writeAdminAuditMock.mock.calls[0][0] as {
      action: string;
      details: Record<string, unknown>;
    };
    expect(entry.action).toBe('webhook.update');
    expect(entry.details).toEqual({ url: 'https://new.example.com/hook', secretRotated: true });
    expect('secret' in entry.details).toBe(false);
    expect(JSON.stringify(entry)).not.toContain('whsec_TOPSECRET');
  });

  it('omits secretRotated from the audit when the secret is unchanged', async () => {
    updateWebhookMock.mockResolvedValue(fakeWebhook());
    await PATCH(...patchReq(ID, { active: false }));
    const entry = writeAdminAuditMock.mock.calls[0][0] as { details: Record<string, unknown> };
    expect(entry.details).toEqual({ active: false });
  });

  it('returns 400 BODY_INVALID for a JSON body that is not an object', async () => {
    for (const b of ['null', '[]', '5', '"x"']) {
      const res = await PATCH(...patchReq(ID, b));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'body must be a JSON object', code: 'BODY_INVALID' });
    }
    expect(updateWebhookMock).not.toHaveBeenCalled();
  });

  it('secret: 255 code points accepted, 256 rejected, NUL rejected', async () => {
    updateWebhookMock.mockResolvedValue(fakeWebhook());
    expect((await PATCH(...patchReq(ID, { secret: 's'.repeat(255) }))).status).toBe(200);
    updateWebhookMock.mockClear();
    for (const [secret, error] of [
      ['s'.repeat(256), 'secret exceeds 255 character limit'],
      ['s\u0000', 'secret must not contain a NUL character'],
    ]) {
      const res = await PATCH(...patchReq(ID, { secret }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error, code: 'BODY_INVALID' });
    }
    expect(updateWebhookMock).not.toHaveBeenCalled();
  });

  it('rejects a NUL in url or in an events entry before the URL guard', async () => {
    for (const [body, error] of [
      [{ url: 'https://x.example.com/\u0000' }, 'url must not contain a NUL character'],
      [{ events: ['tct.revoked', 'a\u0000'] }, 'events must not contain a NUL character'],
    ] as const) {
      const res = await PATCH(...patchReq(ID, body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error, code: 'BODY_INVALID' });
    }
    expect(assertSafeMock).not.toHaveBeenCalled();
    expect(updateWebhookMock).not.toHaveBeenCalled();
  });

  it('returns 400 ID_INVALID for a non-UUID id without reading the body', async () => {
    const res = await PATCH(...patchReq('not-a-uuid', '{{'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'id must be a UUID', code: 'ID_INVALID' });
    expect(updateWebhookMock).not.toHaveBeenCalled();
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  it('skips the URL guard entirely when no url is in the patch', async () => {
    updateWebhookMock.mockResolvedValue(fakeWebhook());
    const res = await PATCH(...patchReq(ID, { active: true }));
    expect(res.status).toBe(200);
    expect(assertSafeMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/webhooks/[id]', () => {
  function delReq(id: string): [NextRequest, { params: Promise<{ id: string }> }] {
    return [
      new NextRequest(
        new Request(`http://localhost:4000/api/webhooks/${id}`, { method: 'DELETE' }),
      ),
      { params: Promise.resolve({ id }) },
    ];
  }

  it('returns 404 NOT_FOUND for an unknown id', async () => {
    const res = await DELETE(...delReq(MISSING));
    expect(res.status).toBe(404);
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  it('returns 400 ID_INVALID for a non-UUID id without calling the service', async () => {
    const res = await DELETE(...delReq('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'id must be a UUID', code: 'ID_INVALID' });
    expect(deleteWebhookMock).not.toHaveBeenCalled();
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  it('returns {id, deleted:true} on success', async () => {
    deleteWebhookMock.mockResolvedValue(true);
    const res = await DELETE(...delReq(ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID, deleted: true });
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
  });
});
