// Unit tests for GET /api/registry/agents/[aid]/manifest.
// Verifies 404 for unknown aids and that the stored manifestJson is
// returned verbatim (raw signed envelope, not re-serialized) with
// Content-Type: application/json and a 60s cache header. The aid path
// param is percent-decoded before lookup. Registry store is mocked.

import { jest } from '@jest/globals';
import type { Agent } from '@/lib/db/schema';

const getAgentMock = jest.fn(async (_aid: string): Promise<Agent | undefined> => undefined);
jest.mock('@/lib/registry/store', () => ({
  getAgent: (aid: string) => getAgentMock(aid),
}));

import { GET } from './route';
import { NextRequest } from 'next/server';

const AID = 'aid:pubkey:abc123';
const AID_ENC = encodeURIComponent(AID);
const MANIFEST_JSON = '{"manifest":{"aid":"aid:pubkey:abc123"},"sig":"zzz"}';

function makeReq(): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:4000/api/registry/agents/${AID_ENC}/manifest`),
  );
}

beforeEach(() => {
  getAgentMock.mockReset();
  getAgentMock.mockResolvedValue(undefined);
});

describe('GET /api/registry/agents/[aid]/manifest', () => {
  it('returns 404 NOT_FOUND for an unknown aid', async () => {
    const res = await GET(makeReq(), { params: Promise.resolve({ aid: AID_ENC }) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('returns the stored manifestJson verbatim with cache + content-type headers', async () => {
    getAgentMock.mockResolvedValue({ manifestJson: MANIFEST_JSON } as Agent);
    const res = await GET(makeReq(), { params: Promise.resolve({ aid: AID_ENC }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('max-age=60');
    expect(await res.text()).toBe(MANIFEST_JSON);
    // Lookup used the DECODED aid.
    expect(getAgentMock).toHaveBeenCalledWith(AID);
  });
});
