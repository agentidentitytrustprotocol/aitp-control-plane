// Unit tests for POST /api/registry/enroll — verifies the route's own
// pre-validation and error mapping (the happy path plus
// verifyAndIssueToken's internal manifest-verification logic are covered
// separately by src/e2e/flow.integration.test.ts and enrollment.test.ts):
//   • non-JSON body -> 400 BODY_INVALID
//   • JSON body missing/wrong-typed `manifest` -> 400 MANIFEST_INVALID,
//     without ever calling into the enrollment service
//   • a well-shaped body is passed through verbatim to
//     verifyAndIssueToken, whose result is returned as-is on success
//   • a thrown Error from verifyAndIssueToken -> 400 MANIFEST_INVALID,
//     carrying `verifyCode` when (and only when) the aitp SDK was the thing
//     that rejected the manifest — the SDK's code is the stable contract,
//     its message wording is not
//
// `verifyCode`'s ABSENCE is asserted with `'verifyCode' in body`, never
// `toBeUndefined()`, which would also pass on an explicitly-undefined key.
//
// @/lib/registry/enrollment is mocked, so the SDK-shaped errors here are
// hand-built. The proof that a real SDK code reaches a real HTTP body is in
// src/e2e/flow.integration.test.ts, which mocks nothing.

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

  it('surfaces the SDK verification code as `verifyCode` on a 400', async () => {
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw Object.assign(new Error('manifest verification failed'), {
        code: 'signature_invalid',
      });
    });
    const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
    expect(res.status).toBe(400);
    // Strict toEqual, deliberately not toMatchObject: a full-body assertion
    // is what made this response-shape change visible in the first place,
    // and weakening it would forfeit that for the next change.
    expect(await res.json()).toEqual({
      error: 'manifest verification failed',
      code: 'MANIFEST_INVALID',
      verifyCode: 'signature_invalid',
    });
  });

  it('omits `verifyCode` entirely when the error carries no SDK code', async () => {
    // This is the in-repo rejection path (the aid check and the 5-minute
    // expiry guard both throw plain Errors). Absence is the signal that the
    // SDK is not what rejected this manifest.
    // Verbatim the message enrollment.ts:68-70 actually throws, so this test
    // does not read as a paraphrase of a string it is not pinning. (The one
    // that genuinely pins those messages is in enrollment.test.ts; the
    // service is mocked here.)
    const guardMessage =
      'manifest expires_at is in the past or within 5 minutes — re-issue with a longer TTL';
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw new Error(guardMessage);
    });
    const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: guardMessage,
      code: 'MANIFEST_INVALID',
    });
    expect('verifyCode' in body).toBe(false);
  });

  it('still produces a well-formed 400 when the service throws a non-Error', async () => {
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw 'oops';
    });
    const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'oops', code: 'MANIFEST_INVALID' });
    expect('verifyCode' in body).toBe(false);
  });

  it('drops an over-long SDK code rather than echoing it', async () => {
    // Proves the 64-char bound holds end-to-end through the route, not just
    // in sdkVerifyCode's own unit test — the route is where an unbounded
    // value would actually reach a public, unauthenticated caller.
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw Object.assign(new Error('nope'), { code: 'a'.repeat(65) });
    });
    const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect('verifyCode' in body).toBe(false);
  });

  it('does not add `verifyCode` to pre-validation failures', async () => {
    // route.ts's pre-validation rejects before the SDK is ever reached, so a
    // verifyCode there would be a lie. Guards the asymmetry explicitly
    // rather than leaving it to the two toEqual assertions above.
    for (const badBody of ['not json', JSON.stringify({ foo: 'bar' })]) {
      const res = await POST(makeReq(badBody));
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(400);
      expect('verifyCode' in body).toBe(false);
    }
    expect(verifyAndIssueTokenMock).not.toHaveBeenCalled();
  });
});
