// Unit tests for POST /api/registry/enroll — verifies the route's own
// pre-validation and error mapping (the happy path plus
// verifyAndIssueToken's internal manifest-verification logic are covered
// separately by src/e2e/flow.integration.test.ts and enrollment.test.ts):
//   • non-JSON body -> 400 BODY_INVALID
//   • JSON body missing/wrong-typed `manifest` -> 400 MANIFEST_INVALID,
//     without ever calling into the enrollment service
//   • a well-shaped body is passed through verbatim to
//     verifyAndIssueToken, whose result is returned as-is on success
//   • a thrown Error from verifyAndIssueToken -> 400 MANIFEST_INVALID
//     with the error's message
//
// @/lib/registry/enrollment is mocked. No database.

import { jest } from '@jest/globals';

const verifyAndIssueTokenMock = jest.fn((_body: string): unknown => ({}));

jest.mock('@/lib/registry/enrollment', () => ({
  getEnrollmentService: () => ({
    verifyAndIssueToken: (body: string) => verifyAndIssueTokenMock(body),
  }),
}));

import { POST } from './route';
import { NextRequest } from 'next/server';

function makeReq(body: string): NextRequest {
  return new NextRequest(
    new Request('http://localhost:4000/api/registry/enroll', {
      method: 'POST',
      body,
    }),
  );
}

beforeEach(() => {
  verifyAndIssueTokenMock.mockReset();
  verifyAndIssueTokenMock.mockReturnValue({ token: 'tok', aid: 'aid:pubkey:x' });
});

describe('POST /api/registry/enroll', () => {
  it('rejects non-JSON bodies with 400 BODY_INVALID, without calling the service', async () => {
    const res = await POST(makeReq('not json'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'body must be valid JSON',
      code: 'BODY_INVALID',
    });
    expect(verifyAndIssueTokenMock).not.toHaveBeenCalled();
  });

  it('rejects a JSON body missing `manifest` with 400 MANIFEST_INVALID', async () => {
    const res = await POST(makeReq(JSON.stringify({ foo: 'bar' })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'body must be a ManifestEnvelope: {"manifest": {...}}',
      code: 'MANIFEST_INVALID',
    });
    expect(verifyAndIssueTokenMock).not.toHaveBeenCalled();
  });

  it('rejects a JSON body whose `manifest` is not an object', async () => {
    const res = await POST(makeReq(JSON.stringify({ manifest: 'nope' })));
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toEqual(
      expect.objectContaining({ code: 'MANIFEST_INVALID' }),
    );
  });

  it('passes a well-shaped body through and returns the service result with 200', async () => {
    const body = JSON.stringify({ manifest: { aid: 'aid:pubkey:x' } });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'tok', aid: 'aid:pubkey:x' });
    expect(verifyAndIssueTokenMock).toHaveBeenCalledWith(body);
  });

  it('maps a thrown Error from the service to 400 MANIFEST_INVALID', async () => {
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw new Error('signature verification failed');
    });
    const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'signature verification failed',
      code: 'MANIFEST_INVALID',
    });
  });
});
