// Unit tests for GET /api/dashboard/overview.
// Verifies range-param handling: defaults to '24h', passes valid ranges
// through, and silently coerces invalid values back to '24h'. The
// dashboard service is mocked; the route returns its result as-is.

import { jest } from '@jest/globals';

const getDashboardOverviewMock = jest.fn(async (range: unknown) => ({
  range,
  totals: { agents: 3 },
}));
jest.mock('@/lib/dashboard/service', () => ({
  getDashboardOverview: (r: unknown) => getDashboardOverviewMock(r),
}));

import { GET } from './route';
import { NextRequest } from 'next/server';

function makeReq(qs: string): NextRequest {
  return new NextRequest(new Request(`http://localhost:4000/api/dashboard/overview${qs}`));
}

beforeEach(() => {
  getDashboardOverviewMock.mockClear();
});

describe('GET /api/dashboard/overview', () => {
  it('defaults to the 24h range when ?range is absent', async () => {
    const res = await GET(makeReq(''));
    expect(res.status).toBe(200);
    expect(getDashboardOverviewMock).toHaveBeenCalledWith('24h');
    const body = (await res.json()) as { range: string; totals: { agents: number } };
    expect(body).toEqual({ range: '24h', totals: { agents: 3 } });
  });

  it.each(['1h', '24h', '7d', '30d'])('passes valid range %s through', async (range) => {
    await GET(makeReq(`?range=${range}`));
    expect(getDashboardOverviewMock).toHaveBeenCalledWith(range);
  });

  it('coerces an invalid range back to 24h instead of erroring', async () => {
    const res = await GET(makeReq('?range=90d'));
    expect(res.status).toBe(200);
    expect(getDashboardOverviewMock).toHaveBeenCalledWith('24h');
  });
});
