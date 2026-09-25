// Unit tests for POST /api/registry/enroll — verifies the route's own
// pre-validation and error mapping (the happy path plus
// verifyAndIssueToken's internal manifest-verification logic are covered
// separately by src/e2e/flow.integration.test.ts and enrollment.test.ts):
//   • non-JSON body -> 400 BODY_INVALID
//   • JSON body missing/wrong-typed `manifest` -> 400 MANIFEST_INVALID,
//     without ever calling into the enrollment service
//   • a well-shaped body is passed through verbatim to
//     verifyAndIssueToken, whose result is returned as-is on success
//   • the route classifies what verifyAndIssueToken throws, rather than
//     mapping everything to 400:
//       - ManifestRejectedError (we rejected it) -> 400 with its cpCode,
//         never a verifyCode
//       - an error carrying a usable SDK code    -> 400 plus that verifyCode;
//         the code is the contract, the wording is not
//       - anything else                          -> RETHROWN, so the
//         framework renders a 500 instead of blaming the caller
//
//   • which `code` each 400 carries, and the two OPPOSITE allowlist rules that
//     decide it. `cpCode` is ours, so an unrecognized value falls back to
//     MANIFEST_INVALID rather than being published. `verifyCode` is the SDK's,
//     so an unrecognized value passes through verbatim. Exactly one SDK code is
//     translated — `expired` -> MANIFEST_EXPIRED — so both expiry paths (the
//     SDK's and our 5-minute guard's) report the one code the sibling register
//     route has always used for this condition.
//   • a server that cannot construct EnrollmentService at all (unset/short
//     ENROLLMENT_SECRET) -> 503 SERVER_MISCONFIGURED, with no config detail
//     in the body, and without ever calling the service
//
//   • instrumentation: exactly one `logger.warn` per classified failure,
//     carrying only the code pair and a length-capped request id — never the
//     manifest body or the AID — plus one counter increment; neither is
//     allowed to change the response, and neither may suppress the other
//
// `verifyCode`'s ABSENCE is asserted with `'verifyCode' in body`, never
// `toBeUndefined()`, which would also pass on an explicitly-undefined key.
//
// @/lib/registry/enrollment is mocked, so the SDK-shaped errors here are
// hand-built. The proof that a real SDK code reaches a real HTTP body is in
// src/e2e/flow.integration.test.ts, which mocks nothing.

import { jest } from '@jest/globals';

const verifyAndIssueTokenMock = jest.fn((_body: string): unknown => ({}));
// Lets a test simulate a server that cannot construct EnrollmentService at
// all (an unset/short ENROLLMENT_SECRET), which is a different failure class
// from anything verifyAndIssueToken can throw.
let getServiceImpl: () => { verifyAndIssueToken: (body: string) => unknown };

jest.mock('@/lib/registry/enrollment', () => ({
  getEnrollmentService: () => getServiceImpl(),
}));

const warnMock = jest.fn((..._args: unknown[]) => {});
const childLoggerMock = jest.fn((_bindings: Record<string, unknown>) => ({
  warn: (...args: unknown[]) => warnMock(...args),
}));
jest.mock('@/lib/logger', () => ({
  childLogger: (bindings: Record<string, unknown>) => childLoggerMock(bindings),
}));

const recordEnrollFailureMock = jest.fn((_code: string | undefined) => {});
jest.mock('@/lib/registry/enroll-metrics', () => ({
  recordEnrollFailure: (code: string | undefined) =>
    recordEnrollFailureMock(code),
}));

import { POST } from './route';
import { ManifestRejectedError } from '@/lib/registry/verify-error';
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
  getServiceImpl = () => ({
    verifyAndIssueToken: (body: string) => verifyAndIssueTokenMock(body),
  });
  warnMock.mockReset();
  childLoggerMock.mockReset();
  childLoggerMock.mockImplementation(() => ({
    warn: (...args: unknown[]) => warnMock(...args),
  }));
  recordEnrollFailureMock.mockReset();
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

  it('omits `verifyCode` entirely when we rejected the manifest ourselves', async () => {
    // This is the in-repo rejection path (the aid check and the 5-minute
    // expiry guard both throw ManifestRejectedError). Absence is the signal
    // that the SDK is not what rejected this manifest.
    //
    // Uses the AID guard's message-and-code pair, verbatim, rather than a
    // paraphrase or an invented combination: this is a pairing production
    // actually emits. (The expiry guard's pair is MANIFEST_EXPIRED, exercised
    // below.) The service is mocked here; the tests that genuinely pin both
    // guards' messages against the real code are in enrollment-guards.test.ts.
    const guardMessage = 'manifest.aid missing or not an AID string';
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw new ManifestRejectedError(guardMessage, 'MANIFEST_INVALID');
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

  it('forwards an allowlisted cpCode into the response `code`', async () => {
    // Pins the PLUMBING, not a hardcoded constant: verified by mutation that
    // hardcoding `code: 'MANIFEST_INVALID'` in the route passes every other
    // test in this file. "Allowlisted", not "whatever" — the next test covers a
    // value outside the allowlist, which is NOT forwarded.
    //
    // This is the mechanism the expiry guard's own code rides on:
    // `enrollment.ts` decides the condition and this route only has to accept
    // the value. (The route does name MANIFEST_EXPIRED itself, but only for the
    // separate SDK-`expired` translation, which never reaches this branch.)
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw new ManifestRejectedError('expiring too soon', 'MANIFEST_EXPIRED');
    });
    const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: 'expiring too soon',
      code: 'MANIFEST_EXPIRED',
    });
    expect('verifyCode' in body).toBe(false);
  });

  it('refuses to publish an unrecognized cpCode, falling back to MANIFEST_INVALID', async () => {
    // `cpCode` is OURS, so a value outside the allowlist is a bug in this repo
    // — not news from a dependency — and echoing it would publish a code no
    // client can look up and that `docs/api.md` does not document. Nothing
    // machine-readable would catch it either: `openapi.yaml` enumerates no
    // `code` value at all, so the allowlist is the only check there is.
    //
    // Note the deliberate asymmetry with `verifyCode` two tests down, which
    // passes an unknown value straight through: whoever owns the vocabulary
    // decides whether unknown values pass through.
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw new ManifestRejectedError('m', 'NOT_A_REAL_CODE');
    });
    const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'm', code: 'MANIFEST_INVALID' });
    // Nor may it reach the metric label or the log line under its own name.
    expect(recordEnrollFailureMock).toHaveBeenCalledWith(undefined);
    expect(warnMock).toHaveBeenCalledWith(
      { code: 'MANIFEST_INVALID', verifyCode: undefined },
      'enrollment verification failed',
    );
  });

  it("maps the SDK's `expired` to MANIFEST_EXPIRED, keeping verifyCode", async () => {
    // The second expiry path: a manifest already past `expires_at` never
    // reaches our own guard, because verifyManifestJson rejects it first. Both
    // paths must report one code — to a client both mean "re-issue with a
    // longer TTL" — with `verifyCode` distinguishing which guard fired.
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw Object.assign(new Error('manifest expired'), { code: 'expired' });
    });
    const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'manifest expired',
      code: 'MANIFEST_EXPIRED',
      verifyCode: 'expired',
    });
  });

  it.each(['signature_invalid', 'pop_failed', 'malformed', 'not_a_real_sdk_code'])(
    'leaves a non-expiry SDK code (%s) on MANIFEST_INVALID',
    async (sdkCode) => {
      // The negative half of the mapping above: exactly one SDK code is
      // translated, and an unknown one is NOT — it still reaches the wire
      // verbatim under MANIFEST_INVALID, because the SDK owns that vocabulary.
      // Without this, widening the mapping to every SDK code would pass.
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw Object.assign(new Error('nope'), { code: sdkCode });
      });
      const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'nope',
        code: 'MANIFEST_INVALID',
        verifyCode: sdkCode,
      });
    },
  );

  it('propagates an unclassifiable error instead of blaming the caller', async () => {
    // THE assertion that proves the misclassification is gone, and the one a
    // naive implementation fails. A bare Error is neither a rejection we made
    // (no cpCode) nor one the SDK made (no .code), so it is a bug in this
    // service — it must reach the framework as a 500, not be laundered into a
    // 400 that tells the caller to fix a manifest that was fine.
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(POST(makeReq(JSON.stringify({ manifest: {} })))).rejects.toThrow(
      'boom',
    );
  });

  it('propagates a thrown non-Error too', async () => {
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw 'oops';
    });
    // Previously this became `400 {error: 'oops'}`. A thrown string carries no
    // classification at all, so it is an internal fault by the same argument.
    await expect(
      POST(makeReq(JSON.stringify({ manifest: {} }))),
    ).rejects.toBe('oops');
  });

  it('handles a non-Error that DOES carry a usable SDK code', async () => {
    // Covers route.ts's `String(err)` arm, which is live rather than dead: a
    // future SDK throwing a plain object with `.code` would keep working (see
    // enrollment.test.ts's forward-compat note), and it would land here.
    // Pins what the caller actually sees in that case — `String({})` is
    // "[object Object]", which is poor prose but a correct `verifyCode`. The
    // code is the contract, so the response is still usable; asserted so the
    // shape is a known state rather than a surprise discovered in production.
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw { code: 'signature_invalid', message: 'not a real Error' };
    });
    const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: '[object Object]',
      code: 'MANIFEST_INVALID',
      verifyCode: 'signature_invalid',
    });
  });

  it('refuses to echo an over-long SDK code, and does not guess a 400 either', async () => {
    // The 64-char bound holds end-to-end through the route, not just in
    // sdkVerifyCode's own unit test — the route is where an unbounded value
    // would reach a public, unauthenticated caller. Note the consequence of
    // Phase 4's rethrow: an unusable code makes the error unclassifiable, so
    // this is now a 500 rather than a 400 with the field dropped. Unreachable
    // with today's SDK (it sets fixed short literals); asserted so the
    // behavior is a recorded decision rather than a surprise.
    verifyAndIssueTokenMock.mockImplementation(() => {
      throw Object.assign(new Error('nope'), { code: 'a'.repeat(65) });
    });
    await expect(POST(makeReq(JSON.stringify({ manifest: {} })))).rejects.toThrow(
      'nope',
    );
  });

  it('answers 503 SERVER_MISCONFIGURED when the service cannot be constructed', async () => {
    // A missing/short ENROLLMENT_SECRET is the server's fault. Before this it
    // answered 400 MANIFEST_INVALID, telling the whole fleet to stop retrying
    // and fix manifests that were never the problem.
    getServiceImpl = () => {
      throw new Error('ENROLLMENT_SECRET is required');
    };
    const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('SERVER_MISCONFIGURED');
    // Explicit no-leak assertions, not implied ones: the body must carry
    // neither the env var name nor the underlying message.
    expect(body.error).not.toContain('ENROLLMENT_SECRET');
    expect(body.error).not.toContain('required');
    expect(verifyAndIssueTokenMock).not.toHaveBeenCalled();
  });

  it('returns 503 for a short secret too, with the same opaque body', async () => {
    getServiceImpl = () => {
      throw new Error(
        'ENROLLMENT_SECRET must be at least 32 characters (got 9). Generate with: ...',
      );
    };
    const res = await POST(makeReq(JSON.stringify({ manifest: {} })));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('SERVER_MISCONFIGURED');
    expect(body.error).not.toContain('ENROLLMENT_SECRET');
    expect(body.error).not.toContain('32');
  });

  describe('observability', () => {
    function badManifestReq() {
      return makeReq(JSON.stringify({ manifest: { aid: 'aid:pubkey:x' } }));
    }

    it('counts and logs an SDK verification failure exactly once, by code', async () => {
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw Object.assign(new Error('bad sig'), { code: 'signature_invalid' });
      });
      await POST(badManifestReq());

      expect(recordEnrollFailureMock).toHaveBeenCalledTimes(1);
      expect(recordEnrollFailureMock).toHaveBeenCalledWith('signature_invalid');
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock).toHaveBeenCalledWith(
        { code: 'MANIFEST_INVALID', verifyCode: 'signature_invalid' },
        'enrollment verification failed',
      );
    });

    it('logs the RESOLVED code, not the raw SDK code, for an expiry', async () => {
      // The log line and the metric must agree with the response body, or an
      // operator charting MANIFEST_EXPIRED would not see the SDK half of the
      // condition. The counter still gets the SDK code — that is its own
      // vocabulary, and `expired` vs `none` is what distinguishes the two
      // expiry paths on a dashboard.
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw Object.assign(new Error('manifest expired'), { code: 'expired' });
      });
      await POST(badManifestReq());

      expect(recordEnrollFailureMock).toHaveBeenCalledWith('expired');
      expect(warnMock).toHaveBeenCalledWith(
        { code: 'MANIFEST_EXPIRED', verifyCode: 'expired' },
        'enrollment verification failed',
      );
    });

    it('counts our own rejection with no code, so the guard is visible', async () => {
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw new ManifestRejectedError('too soon', 'MANIFEST_INVALID');
      });
      await POST(badManifestReq());

      expect(recordEnrollFailureMock).toHaveBeenCalledWith(undefined);
      expect(warnMock).toHaveBeenCalledWith(
        { code: 'MANIFEST_INVALID', verifyCode: undefined },
        'enrollment verification failed',
      );
    });

    it('logs no manifest content and no AID', async () => {
      // The body is unauthenticated attacker-controlled input on a public
      // route; logging it at warn level is a log-volume amplification vector.
      const aid = 'aid:pubkey:z:secret-looking-value';
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw Object.assign(new Error('nope'), { code: 'aid_mismatch' });
      });
      await POST(makeReq(JSON.stringify({ manifest: { aid } })));

      const logged = warnMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.keys(logged).sort()).toEqual(['code', 'verifyCode']);
      expect('manifest' in logged).toBe(false);
      expect('aid' in logged).toBe(false);
      expect(JSON.stringify(warnMock.mock.calls)).not.toContain(aid);
    });

    it('does not count or log a successful enrollment', async () => {
      await POST(badManifestReq());
      expect(recordEnrollFailureMock).not.toHaveBeenCalled();
      expect(warnMock).not.toHaveBeenCalled();
    });

    // BOTH pre-validation branches, deliberately. They return different codes
    // (BODY_INVALID vs MANIFEST_INVALID) from two separate `return`s, so one
    // case pins only one of them: verified by mutation that instrumenting the
    // missing-`manifest` branch alone left the whole suite green.
    it.each([
      ['a non-JSON body', 'not json'],
      ['a JSON body with no manifest', JSON.stringify({ foo: 'bar' })],
    ])(
      'does not count a pre-validation failure (%s) — the SDK was never reached',
      async (_label, body) => {
        await POST(makeReq(body));
        expect(recordEnrollFailureMock).not.toHaveBeenCalled();
        expect(warnMock).not.toHaveBeenCalled();
      },
    );

    it('does not count a 503: a broken server is not a verification failure', async () => {
      getServiceImpl = () => {
        throw new Error('ENROLLMENT_SECRET is required');
      };
      const res = await POST(badManifestReq());
      expect(res.status).toBe(503);
      expect(recordEnrollFailureMock).not.toHaveBeenCalled();
    });

    it('does not count a rethrown internal error', async () => {
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw new Error('boom');
      });
      await expect(POST(badManifestReq())).rejects.toThrow('boom');
      expect(recordEnrollFailureMock).not.toHaveBeenCalled();
      expect(warnMock).not.toHaveBeenCalled();
    });

    it('binds the request id so the line can be correlated to a request', async () => {
      // Nothing else in this service puts a request id on a log line, so
      // without this binding the warn could not be tied to a request at all —
      // which would make "log only the code" useless rather than minimal.
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw Object.assign(new Error('bad sig'), { code: 'signature_invalid' });
      });
      const req = new NextRequest(
        new Request('http://localhost:4000/api/registry/enroll', {
          method: 'POST',
          body: JSON.stringify({ manifest: { aid: 'aid:pubkey:x' } }),
          headers: { 'x-request-id': 'req-abc-123' },
        }),
      );
      await POST(req);
      expect(childLoggerMock).toHaveBeenCalledWith({ requestId: 'req-abc-123' });
    });

    it('binds no requestId when the header is absent', async () => {
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw new ManifestRejectedError('too soon', 'MANIFEST_INVALID');
      });
      await POST(badManifestReq());
      expect(childLoggerMock).toHaveBeenCalledWith({});
    });

    it('caps a hostile request id rather than logging it whole', async () => {
      // x-request-id is client-settable on a public route, so an unbounded
      // value would be a log-volume amplification vector by itself.
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw new ManifestRejectedError('too soon', 'MANIFEST_INVALID');
      });
      const req = new NextRequest(
        new Request('http://localhost:4000/api/registry/enroll', {
          method: 'POST',
          body: JSON.stringify({ manifest: { aid: 'aid:pubkey:x' } }),
          headers: { 'x-request-id': 'z'.repeat(5000) },
        }),
      );
      await POST(req);
      const bound = childLoggerMock.mock.calls[0]?.[0] as { requestId: string };
      expect(bound.requestId).toHaveLength(200);
    });

    it('still counts the failure when the logger throws, and vice versa', async () => {
      // The two halves are guarded separately and the log runs first, so one
      // fault must not cost us the other signal.
      childLoggerMock.mockImplementation(() => {
        throw new Error('logger exploded');
      });
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw Object.assign(new Error('bad sig'), { code: 'signature_invalid' });
      });
      const res = await POST(badManifestReq());
      expect(res.status).toBe(400);
      expect(recordEnrollFailureMock).toHaveBeenCalledWith('signature_invalid');
    });

    it('still logs when the counter throws', async () => {
      recordEnrollFailureMock.mockImplementation(() => {
        throw new Error('counter exploded');
      });
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw Object.assign(new Error('bad sig'), { code: 'signature_invalid' });
      });
      await POST(badManifestReq());
      expect(warnMock).toHaveBeenCalledTimes(1);
    });

    it('still returns its 400 body when the counter throws', async () => {
      // Instrumentation must never change the response. A counter bug turning
      // a clean 400 into an unhandled 500 is strictly worse than a lost metric.
      recordEnrollFailureMock.mockImplementation(() => {
        throw new Error('counter exploded');
      });
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw Object.assign(new Error('bad sig'), { code: 'signature_invalid' });
      });
      const res = await POST(badManifestReq());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'bad sig',
        code: 'MANIFEST_INVALID',
        verifyCode: 'signature_invalid',
      });
    });

    it('still returns its 400 body when the logger throws', async () => {
      warnMock.mockImplementation(() => {
        throw new Error('logger exploded');
      });
      verifyAndIssueTokenMock.mockImplementation(() => {
        throw new ManifestRejectedError('too soon', 'MANIFEST_INVALID');
      });
      const res = await POST(badManifestReq());
      expect(res.status).toBe(400);
      expect(((await res.json()) as Record<string, string>).code).toBe(
        'MANIFEST_INVALID',
      );
    });
  });

  it('rejects a bad body before ever constructing the service', async () => {
    // Precedence check: pre-validation still runs first, so a misconfigured
    // server does not mask a genuinely malformed request with a 503.
    getServiceImpl = () => {
      throw new Error('ENROLLMENT_SECRET is required');
    };
    const res = await POST(makeReq('not json'));
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, string>).toEqual({
      error: 'body must be valid JSON',
      code: 'BODY_INVALID',
    });
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
