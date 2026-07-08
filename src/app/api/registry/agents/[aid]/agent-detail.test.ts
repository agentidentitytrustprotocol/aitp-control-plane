// Unit tests for /api/registry/agents/[aid].
//   • GET    — 404 for unknown aid; 200 with the public discovery shape
//     (incl. encoded manifestUrl + 30s cache header); the aid path param
//     is percent-decoded before lookup
//   • DELETE — 404 when deactivation matched nothing; on success returns
//     {aid, status:'deregistered'}, writes admin audit, ingests + publishes
//     an agent.deregistered event, and dispatches webhooks
//
// Registry store and all side-effect services are mocked (no DB).

import { jest } from '@jest/globals';
import type { Agent } from '@/lib/db/schema';

const getAgentMock = jest.fn(async (_aid: string): Promise<Agent | undefined> => undefined);
const deactivateAgentMock = jest.fn(async (_aid: string) => false);
const writeAdminAuditMock = jest.fn(async (_e: unknown) => undefined);
const ingestOneEventMock = jest.fn(async (_e: unknown) => undefined);
const eventBusPublishMock = jest.fn();
const dispatchWebhooksMock = jest.fn(async (_e: unknown) => undefined);

jest.mock('@/lib/registry/store', () => ({
  getAgent: (aid: string) => getAgentMock(aid),
  deactivateAgent: (aid: string) => deactivateAgentMock(aid),
}));
jest.mock('@/lib/audit-log/service', () => ({
  writeAdminAudit: (e: unknown) => writeAdminAuditMock(e),
}));
jest.mock('@/lib/audit/event-store', () => ({
  ingestOneEvent: (e: unknown) => ingestOneEventMock(e),
}));
jest.mock('@/lib/audit/stream', () => ({
  eventBus: { publish: (e: unknown) => eventBusPublishMock(e) },
}));
jest.mock('@/lib/webhooks/service', () => ({
  dispatchWebhooks: (e: unknown) => dispatchWebhooksMock(e),
}));

import { GET, DELETE } from './route';
import { NextRequest } from 'next/server';

const AID = 'aid:pubkey:abc123';
const AID_ENC = encodeURIComponent(AID);

function fakeAgent(over: Partial<Agent> = {}): Agent {
  return {
    aid: AID,
    displayName: 'test-agent',
    handshakeEndpoint: 'https://agent.example.com/handshake',
    offeredCaps: ['demo.echo'],
    manifestJson: '{"manifest":{}}',
    manifestExpiresAt: null,
    status: 'active',
    registeredAt: '2026-05-01T00:00:00.000Z',
    lastEnrolledAt: '2026-05-01T00:00:00.000Z',
    lastSeenAt: null,
    org: null,
    cloud: null,
    namespace: 'default',
    metadata: {},
    ...over,
  } as Agent;
}

function makeReq(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(`http://localhost:4000${path}`, init));
}

function ctx(aid: string) {
  return { params: Promise.resolve({ aid }) };
}

beforeEach(() => {
  getAgentMock.mockReset();
  getAgentMock.mockResolvedValue(undefined);
  deactivateAgentMock.mockReset();
  deactivateAgentMock.mockResolvedValue(false);
  writeAdminAuditMock.mockReset();
  writeAdminAuditMock.mockResolvedValue(undefined);
  ingestOneEventMock.mockReset();
  ingestOneEventMock.mockResolvedValue(undefined);
  eventBusPublishMock.mockReset();
  dispatchWebhooksMock.mockReset();
  dispatchWebhooksMock.mockResolvedValue(undefined);
});

describe('GET /api/registry/agents/[aid]', () => {
  it('returns 404 NOT_FOUND for an unknown aid', async () => {
    const res = await GET(makeReq(`/api/registry/agents/${AID_ENC}`), ctx(AID_ENC));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('percent-decodes the aid param and returns the public shape + cache header', async () => {
    getAgentMock.mockResolvedValue(fakeAgent());
    const res = await GET(makeReq(`/api/registry/agents/${AID_ENC}`), ctx(AID_ENC));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');
    // Lookup used the DECODED aid.
    expect(getAgentMock).toHaveBeenCalledWith(AID);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      aid: AID,
      displayName: 'test-agent',
      handshakeEndpoint: 'https://agent.example.com/handshake',
      offeredCaps: ['demo.echo'],
      status: 'active',
      registeredAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: null,
      manifestUrl: `/api/registry/agents/${AID_ENC}/manifest`,
    });
    // Internal fields must not leak on the public discovery surface.
    expect('manifestJson' in body).toBe(false);
    expect('metadata' in body).toBe(false);
  });
});

describe('DELETE /api/registry/agents/[aid]', () => {
  it('returns 404 NOT_FOUND when deactivation matched nothing', async () => {
    const res = await DELETE(makeReq(`/api/registry/agents/${AID_ENC}`, { method: 'DELETE' }), ctx(AID_ENC));
    expect(res.status).toBe(404);
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
    expect(eventBusPublishMock).not.toHaveBeenCalled();
  });

  it('deregisters: audit written, agent.deregistered event ingested/published/dispatched', async () => {
    deactivateAgentMock.mockResolvedValue(true);
    const res = await DELETE(makeReq(`/api/registry/agents/${AID_ENC}`, { method: 'DELETE' }), ctx(AID_ENC));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ aid: AID, status: 'deregistered' });

    expect(deactivateAgentMock).toHaveBeenCalledWith(AID);
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
    expect(ingestOneEventMock).toHaveBeenCalledTimes(1);
    expect(eventBusPublishMock).toHaveBeenCalledTimes(1);
    expect(dispatchWebhooksMock).toHaveBeenCalledTimes(1);

    const event = eventBusPublishMock.mock.calls[0][0] as {
      type: string;
      aidA: string;
      payload: Record<string, unknown>;
    };
    expect(event.type).toBe('agent.deregistered');
    expect(event.aidA).toBe(AID);
    expect(event.payload).toEqual({ reason: 'admin_deregister' });
  });
});
