// Unit tests for /api/registry/agents. Behaviours covered:
//
// POST — token and server-fault handling
//   • 503 SERVER_MISCONFIGURED when EnrollmentService cannot be constructed
//     (unset or too-short ENROLLMENT_SECRET) — a server fault, not the
//     caller's, and the body names no configuration. Asserted for BOTH
//     unusable-secret cases, with explicit no-leak assertions rather than
//     implied ones.
//   • …and its complement: a throw from getEnrollmentService() that is NOT an
//     EnrollmentConfigError is RETHROWN, not laundered into a 503. The guard
//     discriminates by class; it used to catch everything and justify itself by
//     counting throw sites in another file.
//   • Precedence, BOTH directions, which is the whole ordering guarantee
//     docs/api.md publishes for this route:
//       - a malformed body and a missing manifest.aid still answer
//         400 BODY_INVALID on a misconfigured server, so a broken deployment
//         never masks a genuinely bad request; and
//       - the checks that FOLLOW the guard (MANIFEST_EXPIRED, the namespace
//         check) answer 503 on that same server. That half was true only by
//         straight-line control flow and would have survived a reordering
//         silently (issue #100); the same claim is asserted over real HTTP by
//         scripts/verify-enrollment-config.mjs.
//   • 401 TOKEN_INVALID when validateToken throws — and the message is
//     asserted verbatim, because it is deliberately echoed to the caller and
//     an over-broad redaction would otherwise remove their only signal.
//   • 401 TOKEN_REPLAYED when the jti was already consumed.
//
// POST — manifest handling
//   • 400 MANIFEST_EXPIRED for a manifest expiring inside the 5-minute guard.
//   • 400 BODY_INVALID for a non-string manifest.extensions.namespace. This is
//     one of the two 400s that follow the service construction rather than
//     preceding it, so on a misconfigured server it answers 503 instead —
//     as it answered 401 before the guard existed.
//   • 201 + persistence, event publish and webhook dispatch on success.
//
// GET
//   • ?include_manifest=true inlines the full ManifestEnvelope, and
//     manifestJson is omitted when the flag is absent.
//   • ?namespace=<X> forwards the filter into listAgents.
//   • responses always carry agentManifestHint.
//
// All upstream services are mocked so the tests stay fast and don't
// need Postgres, the playground, or a real CP-issued enrollment token.
// No test sets an Idempotency-Key, which is what keeps @/lib/db out of the
// picture: withIdempotency only queries when the header is present.

import { jest } from '@jest/globals';
import type { Agent } from '@/lib/db/schema';

// ── Mocks ──────────────────────────────────────────────────────────
const listAgentsMock = jest.fn(async (_filters: unknown) => [] as Agent[]);
const upsertAgentMock = jest.fn(async (_input: unknown) => undefined);
const validateTokenMock = jest.fn();
const consumeEnrollmentJtiMock = jest.fn(async (_jti: string, _exp: number) => true);
const ingestOneEventMock = jest.fn(async (_e: unknown) => undefined);
const dispatchWebhooksMock = jest.fn(async (_e: unknown) => undefined);
const writeAdminAuditMock = jest.fn(async (_e: unknown) => undefined);
const eventBusPublishMock = jest.fn();

jest.mock('@/lib/registry/store', () => ({
  listAgents: (f: unknown) => listAgentsMock(f),
  upsertAgent: (i: unknown) => upsertAgentMock(i),
}));
// Indirected through a mutable `let` rather than returning a fixed object, so
// a test can simulate a server that cannot construct EnrollmentService at all
// (an unset/short ENROLLMENT_SECRET). That is a different failure class from
// anything validateToken can throw, and with a fixed object literal there was
// no seam to express it. Same shape as enroll.test.ts.
let getServiceImpl: () => { validateToken: (...args: unknown[]) => unknown };

jest.mock('@/lib/registry/enrollment', () => ({
  getEnrollmentService: () => getServiceImpl(),
}));
jest.mock('@/lib/registry/jti-store', () => ({
  consumeEnrollmentJti: (jti: string, exp: number) =>
    consumeEnrollmentJtiMock(jti, exp),
}));
jest.mock('@/lib/audit/event-store', () => ({
  ingestOneEvent: (e: unknown) => ingestOneEventMock(e),
}));
jest.mock('@/lib/audit/stream', () => ({
  eventBus: { publish: (e: unknown) => eventBusPublishMock(e) },
}));
jest.mock('@/lib/audit-log/service', () => ({
  writeAdminAudit: (e: unknown) => writeAdminAuditMock(e),
}));
jest.mock('@/lib/webhooks/service', () => ({
  dispatchWebhooks: (e: unknown) => dispatchWebhooksMock(e),
}));

import { GET, POST } from './route';
// NOT mocked, deliberately, unlike `@/lib/registry/enrollment` above: the route
// tests this class with `instanceof`, so the test and the route must be holding
// the same class object. Mocking the module — or reconstructing a look-alike
// error here — would make every 503 case below pass for the wrong reason, or
// fail for one.
import { EnrollmentConfigError } from '@/lib/registry/enrollment-config';
import { NextRequest } from 'next/server';

function makeReq(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new Request(`http://localhost:4000${path}`, init),
  );
}

function fakeAgent(over: Partial<Agent> = {}): Agent {
  return {
    aid: 'aid:pubkey:fake',
    displayName: 'fake',
    handshakeEndpoint: 'https://fake.example.com/handshake',
    offeredCaps: ['demo.echo'],
    manifestJson: '{"manifest":{"aid":"aid:pubkey:fake"}}',
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

beforeEach(() => {
  getServiceImpl = () => ({
    validateToken: (...args: unknown[]) => validateTokenMock(...args),
  });
  listAgentsMock.mockReset();
  listAgentsMock.mockResolvedValue([]);
  upsertAgentMock.mockReset();
  upsertAgentMock.mockResolvedValue(undefined);
  validateTokenMock.mockReset();
  ingestOneEventMock.mockReset();
  ingestOneEventMock.mockResolvedValue(undefined);
  dispatchWebhooksMock.mockReset();
  dispatchWebhooksMock.mockResolvedValue(undefined);
  writeAdminAuditMock.mockReset();
  writeAdminAuditMock.mockResolvedValue(undefined);
  eventBusPublishMock.mockReset();
  consumeEnrollmentJtiMock.mockReset();
  consumeEnrollmentJtiMock.mockResolvedValue(true);
});

// validateToken returns the verified payload; the route reads .jti/.exp
// off it and then consumes the jti. Mock a valid payload for the
// success-path tests.
function okPayload() {
  return {
    sub: 'aid:pubkey:fake',
    scope: 'register' as const,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: 'jti-test-1',
  };
}

// ── POST — Bug 6: reject manifests expiring within 5 min ───────────
describe('POST /api/registry/agents (Plan Bug 6)', () => {
  function envelope(secondsUntilExpiry: number): string {
    return JSON.stringify({
      manifest: {
        aid: 'aid:pubkey:fake',
        display_name: 'fake',
        handshake_endpoint: 'https://fake.example.com/handshake',
        offered_capabilities: ['demo.echo'],
        expires_at: Math.floor(Date.now() / 1000) + secondsUntilExpiry,
      },
    });
  }

  it('returns 400 MANIFEST_EXPIRED for a manifest expiring in 60 s (inside the 5-min guard)', async () => {
    // The route validates the enrollment token BEFORE the expiry guard,
    // so the mocked validateToken must succeed for the guard to fire.
    validateTokenMock.mockImplementation(() => okPayload());
    const res = await POST(
      makeReq('/api/registry/agents', {
        method: 'POST',
        headers: { authorization: 'Bearer ok-token' },
        body: envelope(60),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('MANIFEST_EXPIRED');
    expect(body.error).toMatch(/5 minutes/);
    expect(upsertAgentMock).not.toHaveBeenCalled();
  });

  it('returns 201 + persists for a manifest expiring in 1 hour', async () => {
    validateTokenMock.mockImplementation(() => okPayload());
    const res = await POST(
      makeReq('/api/registry/agents', {
        method: 'POST',
        headers: { authorization: 'Bearer ok-token' },
        body: envelope(3600),
      }),
    );
    expect(res.status).toBe(201);
    expect(upsertAgentMock).toHaveBeenCalledTimes(1);
    // event published + webhook dispatched (Plan §3.6-related parity)
    expect(eventBusPublishMock).toHaveBeenCalledTimes(1);
    expect(dispatchWebhooksMock).toHaveBeenCalledTimes(1);
    const eventArg = eventBusPublishMock.mock.calls[0][0] as { type: string };
    expect(eventArg.type).toBe('agent.registered');
  });

  it('returns 401 TOKEN_INVALID when the enrollment token does not validate', async () => {
    validateTokenMock.mockImplementation(() => {
      throw new Error('signature invalid');
    });
    const res = await POST(
      makeReq('/api/registry/agents', {
        method: 'POST',
        headers: { authorization: 'Bearer bad-token' },
        body: envelope(3600),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('TOKEN_INVALID');
    // The message is pinned verbatim, not just the code. validateToken's
    // messages are deliberate caller-facing text about a credential the caller
    // supplied, and the 503 guard above this path exists precisely so that
    // server-fault detail never lands here. An over-broad "redact everything"
    // change would strip the caller's only signal about why their token
    // failed; this assertion is what makes that a test failure.
    expect(body.error).toBe('signature invalid');
    expect(upsertAgentMock).not.toHaveBeenCalled();
  });

  describe('when EnrollmentService cannot be constructed', () => {
    it('answers 503 SERVER_MISCONFIGURED for an unset ENROLLMENT_SECRET', async () => {
      // A missing/short ENROLLMENT_SECRET is the server's fault. Before this it
      // answered 401 TOKEN_INVALID with the env var name in the response body,
      // telling the whole fleet to stop retrying and re-enroll over tokens
      // that were never the problem.
      getServiceImpl = () => {
        throw new EnrollmentConfigError('ENROLLMENT_SECRET is required');
      };
      const res = await POST(
        makeReq('/api/registry/agents', {
          method: 'POST',
          headers: { authorization: 'Bearer ok-token' },
          body: envelope(3600),
        }),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, string>;
      expect(body.code).toBe('SERVER_MISCONFIGURED');
      // Explicit no-leak assertions, not implied ones: the body must carry
      // neither the env var name nor the underlying message.
      expect(body.error).not.toContain('ENROLLMENT_SECRET');
      expect(body.error).not.toContain('required');
      expect(validateTokenMock).not.toHaveBeenCalled();
      expect(upsertAgentMock).not.toHaveBeenCalled();
    });

    it('returns 503 for a short secret too, with the same opaque body', async () => {
      // The second unusable-secret case, and the more dangerous one: its message
      // embeds the observed length. (It is no longer a second THROW SITE — the
      // constructor has one, throwing EnrollmentConfigError for both cases. See
      // src/lib/registry/enrollment-config.ts.)
      getServiceImpl = () => {
        throw new EnrollmentConfigError(
          'ENROLLMENT_SECRET must be at least 32 characters (got 9). ' +
            'Generate with: node -e "..."',
        );
      };
      const res = await POST(
        makeReq('/api/registry/agents', {
          method: 'POST',
          headers: { authorization: 'Bearer ok-token' },
          body: envelope(3600),
        }),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, string>;
      expect(body.code).toBe('SERVER_MISCONFIGURED');
      expect(body.error).not.toContain('ENROLLMENT_SECRET');
      expect(body.error).not.toContain('32');
      expect(body.error).not.toContain('9');
      expect(upsertAgentMock).not.toHaveBeenCalled();
    });

    it('still rejects a malformed body with 400 before constructing the service', async () => {
      // Precedence check: the JSON pre-validation runs first, so a
      // misconfigured server does not mask a genuinely malformed request
      // behind a 503.
      getServiceImpl = () => {
        throw new EnrollmentConfigError('ENROLLMENT_SECRET is required');
      };
      const res = await POST(
        makeReq('/api/registry/agents', {
          method: 'POST',
          headers: { authorization: 'Bearer ok-token' },
          body: 'not json',
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('BODY_INVALID');
    });

    it('still rejects a missing manifest.aid with 400 before constructing the service', async () => {
      // The route's second pre-validation, which has no enroll analogue —
      // enroll only checks that `manifest` is an object.
      getServiceImpl = () => {
        throw new EnrollmentConfigError('ENROLLMENT_SECRET is required');
      };
      const res = await POST(
        makeReq('/api/registry/agents', {
          method: 'POST',
          headers: { authorization: 'Bearer ok-token' },
          body: JSON.stringify({ manifest: {} }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('BODY_INVALID');
    });

    // ── the OTHER half of the ordering guarantee ──────────────────────────
    //
    // The two tests above pin "400 BEFORE 503": the pre-validations run ahead of
    // the guard, so a broken deployment never masks a genuinely malformed
    // request. The two below pin the complement — "503 BEFORE 400" for every
    // check that FOLLOWS the guard — and that half had nothing holding it.
    //
    // docs/api.md publishes both halves as one sentence ("a malformed body or a
    // missing manifest.aid is still rejected with 400 even on a misconfigured
    // server … the later checks (MANIFEST_EXPIRED, the namespace check) sit
    // behind the 503"), and route.ts's guard comment states the same thing as
    // the reason the guard sits INSIDE the withIdempotency callback rather than
    // above it. Until now that second half was true only by straight-line
    // control flow: hoisting the guard one statement lower — or lifting either
    // later check one statement higher — would invert the published precedence
    // and every existing test would still pass.
    //
    // Both assert the complementary code is ABSENT, not merely that the status
    // is 503. `expect(status).toBe(503)` alone would also pass if the route
    // started answering 503 for the expiry itself, which is a different bug
    // wearing the same status.
    it('answers 503 rather than 400 MANIFEST_EXPIRED for a check BEHIND the guard', async () => {
      getServiceImpl = () => {
        throw new EnrollmentConfigError('ENROLLMENT_SECRET is required');
      };
      // Inside the 5-minute registration window, i.e. a manifest this route
      // WOULD reject with 400 MANIFEST_EXPIRED on a healthy server — asserted as
      // exactly that by the (Plan Bug 6) test above, which is what makes this
      // one a precedence test rather than a restatement.
      const res = await POST(
        makeReq('/api/registry/agents', {
          method: 'POST',
          headers: { authorization: 'Bearer ok-token' },
          body: envelope(60),
        }),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('SERVER_MISCONFIGURED');
      expect(body.code).not.toBe('MANIFEST_EXPIRED');
      // The expiry guard lives after validateToken, so reaching it at all would
      // have meant validating a token on a server that cannot verify any.
      expect(validateTokenMock).not.toHaveBeenCalled();
    });

    it('answers 503 rather than 400 BODY_INVALID for the namespace check BEHIND the guard', async () => {
      getServiceImpl = () => {
        throw new EnrollmentConfigError('ENROLLMENT_SECRET is required');
      };
      // A non-string manifest.extensions.namespace: the route's LAST 400, and
      // the one that most looks like a pre-validation (it is decidable from the
      // body alone) while actually sitting behind the guard. Asserted as a 400
      // on a healthy server by the '(Plan 2.2)' test below.
      const res = await POST(
        makeReq('/api/registry/agents', {
          method: 'POST',
          headers: { authorization: 'Bearer ok-token' },
          body: JSON.stringify({
            manifest: {
              aid: 'aid:pubkey:fake',
              display_name: 'fake',
              handshake_endpoint: 'https://fake.example.com/handshake',
              offered_capabilities: ['demo.echo'],
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              extensions: { namespace: { tenant: 'x' } },
            },
          }),
        }),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('SERVER_MISCONFIGURED');
      expect(body.code).not.toBe('BODY_INVALID');
      expect(upsertAgentMock).not.toHaveBeenCalled();
    });

    it('RETHROWS a non-configuration throw instead of calling it misconfigured', async () => {
      // The point of discriminating by class, and the behaviour that replaced a
      // comment in route.ts counting throw sites in another file. Before this,
      // ANY throw out of getEnrollmentService() became 503 SERVER_MISCONFIGURED
      // — so a bug or an exhausted resource would send an operator to check an
      // env var that was fine. A plain Error is the specific case that used to be
      // indistinguishable: it is what the constructor threw before
      // EnrollmentConfigError existed.
      //
      // It propagates all the way out of withIdempotency, which does not catch
      // callback throws, so the framework renders a 500 — and nothing is
      // persisted against an idempotency key (this request sets no
      // Idempotency-Key header at all, and neither 500 nor 503 is cacheable).
      getServiceImpl = () => {
        throw new Error('native binding failed to load');
      };
      await expect(
        POST(
          makeReq('/api/registry/agents', {
            method: 'POST',
            headers: { authorization: 'Bearer ok-token' },
            body: envelope(3600),
          }),
        ),
      ).rejects.toThrow('native binding failed to load');
      expect(validateTokenMock).not.toHaveBeenCalled();
      expect(upsertAgentMock).not.toHaveBeenCalled();
    });
  });

  it('returns 401 TOKEN_REPLAYED when the jti was already consumed (P0-3)', async () => {
    validateTokenMock.mockImplementation(() => okPayload());
    consumeEnrollmentJtiMock.mockResolvedValue(false); // already used
    const res = await POST(
      makeReq('/api/registry/agents', {
        method: 'POST',
        headers: { authorization: 'Bearer replayed-token' },
        body: envelope(3600),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('TOKEN_REPLAYED');
    expect(upsertAgentMock).not.toHaveBeenCalled();
  });

  it('rejects manifest.extensions.namespace when it is not a string (Plan 2.2)', async () => {
    validateTokenMock.mockImplementation(() => okPayload());
    const body = JSON.stringify({
      manifest: {
        aid: 'aid:pubkey:fake',
        display_name: 'fake',
        handshake_endpoint: 'https://fake.example.com/handshake',
        offered_capabilities: ['demo.echo'],
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        extensions: { namespace: { tenant: 'x' } },
      },
    });
    const res = await POST(
      makeReq('/api/registry/agents', {
        method: 'POST',
        headers: { authorization: 'Bearer ok' },
        body,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BODY_INVALID');
  });
});

// ── GET — 2.4 include_manifest, 2.3 agentManifestHint, 2.2 namespace ──
describe('GET /api/registry/agents (Plan 2.2 / 2.3 / 2.4)', () => {
  it('inlines manifestJson when ?include_manifest=true (Plan 2.4)', async () => {
    listAgentsMock.mockResolvedValue([fakeAgent()]);
    const res = await GET(makeReq('/api/registry/agents?include_manifest=true'));
    const body = (await res.json()) as {
      agents: Array<{ manifestJson?: string }>;
    };
    expect(body.agents[0].manifestJson).toBeDefined();
    expect(body.agents[0].manifestJson).toContain('aid:pubkey:fake');
  });

  it('omits manifestJson when ?include_manifest is absent', async () => {
    listAgentsMock.mockResolvedValue([fakeAgent()]);
    const res = await GET(makeReq('/api/registry/agents'));
    const body = (await res.json()) as {
      agents: Array<{ manifestJson?: string }>;
    };
    expect(body.agents[0].manifestJson).toBeUndefined();
  });

  it('always returns agentManifestHint derived from handshakeEndpoint (Plan 2.3)', async () => {
    listAgentsMock.mockResolvedValue([
      fakeAgent({ handshakeEndpoint: 'https://r.example.com/aitp/handshake' }),
    ]);
    const res = await GET(makeReq('/api/registry/agents'));
    const body = (await res.json()) as {
      agents: Array<{ agentManifestHint: string | null }>;
    };
    expect(body.agents[0].agentManifestHint).toBe(
      'https://r.example.com/.well-known/aitp-manifest',
    );
  });

  it('passes ?namespace=<X> through to listAgents (Plan 2.2)', async () => {
    listAgentsMock.mockResolvedValue([]);
    await GET(makeReq('/api/registry/agents?namespace=production'));
    expect(listAgentsMock).toHaveBeenCalledTimes(1);
    const passedFilters = listAgentsMock.mock.calls[0][0] as { namespace: string };
    expect(passedFilters.namespace).toBe('production');
  });
});
