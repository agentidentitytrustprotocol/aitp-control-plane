// Unit tests for the webhook circuit-breaker admin surface:
//   • GET  /api/webhooks/[id]/circuit-breaker        — snapshot (closed by
//     default for unknown ids; open after threshold failures)
//   • POST /api/webhooks/[id]/circuit-breaker/reset  — re-arms the breaker
//     and returns the fresh (closed) snapshot; writes an admin audit entry
//   • both — 400 ID_INVALID for a non-UUID id, with no breaker entry created
//     and no audit row written
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

// Path ids are validated as UUIDs, so fixtures use real (v4) ones.
const UNKNOWN = '9b1d6a2c-5e4f-4a3b-9c8d-0e1f2a3b4c5d';
const FLAKY = '3f2b8c1e-9a4d-4e5f-8a6b-7c8d9e0f1a2b';
const WH1 = '6d0c2b9a-1f3e-4d5c-b6a7-8e9f0a1b2c3d';

beforeEach(() => {
  webhookBreaker.reset_all();
  writeAdminAuditMock.mockReset();
  writeAdminAuditMock.mockResolvedValue(undefined);
});

describe('GET /api/webhooks/[id]/circuit-breaker', () => {
  it('returns a pristine closed snapshot for an unknown webhook id', async () => {
    const res = await GET(getReq(UNKNOWN), ctx(UNKNOWN));
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
    for (let i = 0; i < 5; i++) webhookBreaker.recordFailure(FLAKY);
    const res = await GET(getReq(FLAKY), ctx(FLAKY));
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
    for (let i = 0; i < 5; i++) webhookBreaker.recordFailure(FLAKY);
    expect(webhookBreaker.getSnapshot(FLAKY).state).toBe('open');

    const res = await RESET(resetReq(FLAKY), ctx(FLAKY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: 'closed',
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      nextProbeAt: null,
    });
    expect(webhookBreaker.getSnapshot(FLAKY).state).toBe('closed');
  });

  it('writes an admin audit entry with the webhook id as target', async () => {
    await RESET(resetReq(WH1), ctx(WH1));
    expect(writeAdminAuditMock).toHaveBeenCalledTimes(1);
    const entry = writeAdminAuditMock.mock.calls[0][0] as {
      action: string;
      targetId: string;
    };
    expect(entry.action).toBe('webhook.circuit-breaker.reset');
    expect(entry.targetId).toBe(WH1);
  });
});

describe('circuit-breaker routes — path-id validation', () => {
  const BAD = 'not-a-uuid';

  it('GET with a non-UUID id is 400 ID_INVALID and creates no breaker entry', async () => {
    const res = await GET(getReq(BAD), ctx(BAD));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'id must be a UUID', code: 'ID_INVALID' });
    expect(Object.keys(webhookBreaker.getAllSnapshots())).not.toContain(BAD);
  });

  it('reset with a non-UUID id is 400 ID_INVALID and writes no audit entry', async () => {
    const res = await RESET(resetReq(BAD), ctx(BAD));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'id must be a UUID', code: 'ID_INVALID' });
    expect(writeAdminAuditMock).not.toHaveBeenCalled();
  });
});
