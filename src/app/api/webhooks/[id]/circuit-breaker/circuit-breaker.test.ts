// Unit tests for the webhook circuit-breaker admin surface:
//   • GET  /api/webhooks/[id]/circuit-breaker        — snapshot (closed by
//     default for unknown ids; open after threshold failures)
//   • POST /api/webhooks/[id]/circuit-breaker/reset  — re-arms the breaker
//     and returns the fresh (closed) snapshot; writes an admin audit entry
//
// The real in-memory webhookBreaker singleton is used (no DB); only the
// admin-audit writer is mocked.

import { jest } from '@jest/globals';

const writeAdminAuditMock = jest.fn(async (_e: unknown) => undefined);
jest.mock('@/lib/audit-log/service', () => ({
  writeAdminAudit: (e: unknown) => writeAdminAuditMock(e),
}));

import { GET } from './route';
import { POST as RESET } from './reset/route';
import { webhookBreaker } from '@/lib/webhooks/circuit-breaker';
import { NextRequest } from 'next/server';

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function getReq(id: string): Request {
  return new Request(`http://localhost:4000/api/webhooks/${id}/circuit-breaker`);
}

function resetReq(id: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:4000/api/webhooks/${id}/circuit-breaker/reset`, {
      method: 'POST',
    }),
  );
}

beforeEach(() => {
  webhookBreaker.reset_all();
  writeAdminAuditMock.mockReset();
  writeAdminAuditMock.mockResolvedValue(undefined);
});

describe('GET /api/webhooks/[id]/circuit-breaker', () => {
  it('returns a pristine closed snapshot for an unknown webhook id', async () => {
    const res = await GET(getReq('wh-unknown'), ctx('wh-unknown'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: 'closed',
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      nextProbeAt: null,
    });
  });

  it('reports open state with openedAt/nextProbeAt after threshold failures', async () => {
    for (let i = 0; i < 5; i++) webhookBreaker.recordFailure('wh-flaky');
    const res = await GET(getReq('wh-flaky'), ctx('wh-flaky'));
    const body = (await res.json()) as {
      state: string;
      failures: number;
      openedAt: number | null;
      nextProbeAt: number | null;
    };
    expect(body.state).toBe('open');
    expect(body.failures).toBe(5);
    expect(typeof body.openedAt).toBe('number');
    expect(body.nextProbeAt).toBe((body.openedAt as number) + 60_000);
  });
});

describe('POST /api/webhooks/[id]/circuit-breaker/reset', () => {
  it('re-arms an open breaker and returns the closed snapshot', async () => {
    for (let i = 0; i < 5; i++) webhookBreaker.recordFailure('wh-flaky');
    expect(webhookBreaker.getSnapshot('wh-flaky').state).toBe('open');

    const res = await RESET(resetReq('wh-flaky'), ctx('wh-flaky'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: 'closed',
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      nextProbeAt: null,
    });
    expect(webhookBreaker.getSnapshot('wh-flaky').state).toBe('closed');
  });

  it('writes an admin audit entry with the webhook id as target', async () => {
    await RESET(resetReq('wh-1'), ctx('wh-1'));
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
    const entry = writeAdminAuditMock.mock.calls[0][0] as {
      action: string;
      targetId: string;
    };
    expect(entry.action).toBe('webhook.circuit-breaker.reset');
    expect(entry.targetId).toBe('wh-1');
  });
});
