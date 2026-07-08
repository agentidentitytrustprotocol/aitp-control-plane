// Unit test for GET /api/dashboard/agents.
// Verifies the route wraps the service result in an { agents } envelope
// and returns it untouched. The dashboard service is mocked.

import { jest } from '@jest/globals';

const metrics = [
  { aid: 'aid:pubkey:a', displayName: 'a', sessions24h: 2 },
  { aid: 'aid:pubkey:b', displayName: 'b', sessions24h: 0 },
];

const getAgentMetricsMock = jest.fn(async () => metrics);
jest.mock('@/lib/dashboard/service', () => ({
  getAgentMetrics: () => getAgentMetricsMock(),
}));

import { GET } from './route';

describe('GET /api/dashboard/agents', () => {
  it('returns the service metrics under an agents envelope', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: metrics });
    expect(getAgentMetricsMock).toHaveBeenCalledTimes(1);
  });
});
