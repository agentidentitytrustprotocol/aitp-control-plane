// Unit tests for /api/webhooks/[id].
//   • PATCH  — 400 on non-JSON body; 400 URL_NOT_ALLOWED when the SSRF
//     guard rejects a new url; 404 when the id is unknown; 200 with only
//     correctly-typed fields forwarded (secret accepted in the patch but
//     never echoed back in the response)
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

function fakeWebhook(over: Partial<WebhookRow> = {}): WebhookRow {
  return {
    id: 'wh-1',
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
    const res = await PATCH(...patchReq('wh-1', '{{'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
  });

  it('returns 400 URL_NOT_ALLOWED when the guard rejects the new url', async () => {
    assertSafeMock.mockRejectedValue(new UnsafeWebhookUrlError('loopback address'));
    const res = await PATCH(...patchReq('wh-1', { url: 'http://127.0.0.1/x' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('URL_NOT_ALLOWED');
    expect(updateWebhookMock).not.toHaveBeenCalled();
  });

  it('returns 404 NOT_FOUND when the webhook does not exist', async () => {
    const res = await PATCH(...patchReq('missing', { active: false }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  it('forwards only typed fields and never echoes the secret back', async () => {
    updateWebhookMock.mockResolvedValue(fakeWebhook({ active: false }));
    const res = await PATCH(
      ...patchReq('wh-1', {
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
    expect(id).toBe('wh-1');
    expect(patch.url).toBe('https://new.example.com/hook');
    expect(patch.events).toEqual(['a', 'b']);
    expect(patch.secret).toBe('whsec_new');
    expect(patch.active).toBe(false);
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
  });

  it('skips the URL guard entirely when no url is in the patch', async () => {
    updateWebhookMock.mockResolvedValue(fakeWebhook());
    const res = await PATCH(...patchReq('wh-1', { active: true }));
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
    const res = await DELETE(...delReq('missing'));
    expect(res.status).toBe(404);
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });

  it('returns {id, deleted:true} on success', async () => {
    deleteWebhookMock.mockResolvedValue(true);
    const res = await DELETE(...delReq('wh-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'wh-1', deleted: true });
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
  });
});
