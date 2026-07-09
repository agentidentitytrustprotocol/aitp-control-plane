// Unit tests for /api/webhooks (collection).
//   • GET  — lists webhooks WITHOUT leaking the secret
//   • POST — 400 on non-JSON body / missing url; 400 URL_NOT_ALLOWED when
//     the SSRF guard rejects; 201 on success (secret IS returned once at
//     create time), non-string events filtered out, active defaults true.
//
// @/lib/webhooks/service and the url-guard are mocked; the guard mock keeps
// its own UnsafeWebhookUrlError class so the route's instanceof check works.

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

const listWebhooksMock = jest.fn(async () => [] as WebhookRow[]);
const createWebhookMock = jest.fn(async (_input: unknown) => fakeWebhook());
const writeAdminAuditMock = jest.fn(async (_e: unknown) => undefined);

jest.mock('@/lib/webhooks/service', () => ({
  listWebhooks: () => listWebhooksMock(),
  createWebhook: (i: unknown) => createWebhookMock(i),
}));
jest.mock('@/lib/audit-log/service', () => ({
  writeAdminAudit: (e: unknown) => writeAdminAuditMock(e),
}));

import { GET, POST } from './route';
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
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest(
      new Request('http://localhost:4000/api/webhooks', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    ),
  );
}

beforeEach(() => {
  listWebhooksMock.mockReset();
  listWebhooksMock.mockResolvedValue([]);
  createWebhookMock.mockReset();
  createWebhookMock.mockResolvedValue(fakeWebhook());
  writeAdminAuditMock.mockReset();
  writeAdminAuditMock.mockResolvedValue(undefined);
  assertSafeMock.mockReset();
  assertSafeMock.mockResolvedValue(undefined);
});

describe('GET /api/webhooks', () => {
  it('lists webhooks without exposing the secret', async () => {
    listWebhooksMock.mockResolvedValue([fakeWebhook()]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhooks: Record<string, unknown>[] };
    expect(body.webhooks).toHaveLength(1);
    expect(body.webhooks[0].id).toBe('wh-1');
    expect(body.webhooks[0].url).toBe('https://receiver.example.com/hook');
    expect('secret' in body.webhooks[0]).toBe(false);
  });
});

describe('POST /api/webhooks', () => {
  it('returns 400 BODY_INVALID for a non-JSON body', async () => {
    const res = await post('not json');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
  });

  it('returns 400 BODY_INVALID when url is missing or not a string', async () => {
    const res = await post({ url: 42, events: ['x'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
    expect(createWebhookMock).not.toHaveBeenCalled();
  });

  it('returns 400 URL_NOT_ALLOWED when the SSRF guard rejects the url', async () => {
    assertSafeMock.mockRejectedValue(
      new UnsafeWebhookUrlError('resolves to a private address'),
    );
    const res = await post({ url: 'http://169.254.169.254/latest' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('URL_NOT_ALLOWED');
    expect(body.error).toBe('resolves to a private address');
    expect(createWebhookMock).not.toHaveBeenCalled();
  });

  it('creates the webhook: 201, secret returned once, events filtered, active defaulted', async () => {
    const res = await post({
      url: 'https://receiver.example.com/hook',
      events: ['tct.revoked', 42, null, 'agent.registered'],
      secret: 'whsec_abc',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe('wh-1');
    expect(body.secret).toBe('whsec_abc'); // create response includes secret

    expect(createWebhookMock).toHaveBeenCalledTimes(1);
    const input = createWebhookMock.mock.calls[0][0] as {
      events: string[];
      active: boolean;
      secret?: string;
    };
    expect(input.events).toEqual(['tct.revoked', 'agent.registered']);
    expect(input.active).toBe(true); // defaulted when absent
    expect(input.secret).toBe('whsec_abc');
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
  });
});
