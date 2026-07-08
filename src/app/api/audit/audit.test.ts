// Unit tests for GET /api/audit — verifies:
//   • listAdminAudit receives the parsed limit/offset (defaults 100/0)
//   • limit is clamped to [1,1000], offset floored at 0, malformed input
//     falls back to defaults
//   • response shape { entries, count }.
//
// The admin-audit service is mocked — no database.

import { jest } from '@jest/globals';

const listAdminAuditMock = jest.fn(
  async (_limit: number, _offset: number) => [] as unknown[],
);

jest.mock('@/lib/audit-log/service', () => ({
  listAdminAudit: (limit: number, offset: number) =>
    listAdminAuditMock(limit, offset),
}));

import { GET } from './route';
import { NextRequest } from 'next/server';

function makeReq(qs: string): NextRequest {
  return new NextRequest(new Request(`http://localhost:4000/api/audit${qs}`));
}

beforeEach(() => {
  listAdminAuditMock.mockReset();
  listAdminAuditMock.mockResolvedValue([]);
});

describe('GET /api/audit', () => {
  it('defaults to limit=100, offset=0', async () => {
    const res = await GET(makeReq(''));
    expect(res.status).toBe(200);
    expect(listAdminAuditMock).toHaveBeenCalledWith(100, 0);
  });

  it('passes explicit limit/offset through', async () => {
    await GET(makeReq('?limit=7&offset=3'));
    expect(listAdminAuditMock).toHaveBeenCalledWith(7, 3);
  });

  it('clamps limit to 1000 and floors it at 1', async () => {
    await GET(makeReq('?limit=99999'));
    expect(listAdminAuditMock).toHaveBeenLastCalledWith(1000, 0);
    await GET(makeReq('?limit=0'));
    expect(listAdminAuditMock).toHaveBeenLastCalledWith(1, 0);
  });

  it('falls back to defaults on malformed limit/offset and floors negative offset', async () => {
    await GET(makeReq('?limit=abc&offset=-12'));
    expect(listAdminAuditMock).toHaveBeenLastCalledWith(100, 0);
  });

  it('returns { entries, count } with the service rows', async () => {
    listAdminAuditMock.mockResolvedValue([
      { id: 1, action: 'webhook.create' },
      { id: 2, action: 'agent.revoke' },
    ]);
    const res = await GET(makeReq(''));
    const body = (await res.json()) as { entries: unknown[]; count: number };
    expect(body.entries).toEqual([
      { id: 1, action: 'webhook.create' },
      { id: 2, action: 'agent.revoke' },
    ]);
    expect(body.count).toBe(2);
  });
});
