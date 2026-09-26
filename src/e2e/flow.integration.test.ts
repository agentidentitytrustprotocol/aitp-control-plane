/**
 * End-to-end flow exercise. Drives the route handlers directly (no
 * HTTP listener, no proxy) but uses a real Postgres and real
 * AITP cryptography via the Rust binding.
 *
 * Flow:
 *   1. Generate two AITP agents (researcher, writer)
 *   2. Each builds a signed manifest
 *   3. POST /api/registry/enroll for each → enrollment token
 *   3a. Enroll failure paths, real SDK, no mocks: an already-expired
 *       manifest → 400 with a `verifyCode` string (the SDK rejected it);
 *       a 60-second-TTL manifest the SDK *accepts* → 400 with NO
 *       `verifyCode` (our own 5-minute registration guard rejected it).
 *       Together these prove the biconditional the error body promises —
 *       `verifyCode` present ⇔ the aitp SDK was the thing that rejected
 *       the manifest. Both carry `code: MANIFEST_EXPIRED`, which only a real
 *       SDK can demonstrate: the two paths are distinguished by which
 *       component rejects first, not by anything a mock can stand in for.
 *   3b. Cross-route: enroll and register return the SAME `code` for the same
 *       60-second manifest. That agreement is the invariant the shared guard's
 *       comment claims and nothing asserted until now.
 *   4. POST /api/registry/agents for each → registry rows
 *   5. GET /api/registry/agents?capability=demo.echo → both visible
 *   6. POST /api/events with a synthetic handshake.complete event
 *   7. GET /api/events/history → event visible
 *   8. POST /api/revocation/entries → entry persists
 *   9. GET /.well-known/aitp-revocation-list → signed list contains the JTI
 *
 * Failures here mean an integration-level regression that unit tests
 * cannot catch — typically a route signature change or a DB
 * constraint that the schema accidentally tightened.
 *
 * This test exercises the AITP Rust binding (Ed25519, JCS) so it
 * requires the platform-specific `.node` file to be present.
 */

import { AitpAgent } from 'aitp';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { POST as enrollPost } from '@/app/api/registry/enroll/route';
import {
  POST as registerPost,
  GET as listAgentsGet,
} from '@/app/api/registry/agents/route';
import { POST as eventsPost } from '@/app/api/events/route';
import { GET as eventsHistoryGet } from '@/app/api/events/history/route';
import { POST as revocationPost } from '@/app/api/revocation/entries/route';
import { GET as revocationListGet } from '@/app/api/well-known/aitp-revocation-list/route';

import { db, pool } from '@/lib/db';
import {
  adminAuditLog,
  agents as agentsTable,
  auditEvents,
  handshakeSessions,
  revocationEntries,
} from '@/lib/db/schema';

function mkReq(
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(url, {
    method: init.method,
    body: init.body,
    headers: init.headers,
  });
}

const RUN_ID = `e2e-${randomUUID()}`;
// Suite-level so afterAll can clean the tct.revoked audit event even if
// the revocation test fails midway.
const REVOKED_JTI = randomUUID();

describe('integration: enroll → register → discover → event → revoke flow', () => {
  const researcher = AitpAgent.generate();
  const writer = AitpAgent.generate();

  let researcherManifest = '';
  let writerManifest = '';
  let researcherToken = '';
  let writerToken = '';

  beforeAll(() => {
    // 5-minute guard requires ttlSecs > 300 + a small buffer.
    researcherManifest = researcher.buildManifest({
      displayName: 'e2e-researcher',
      handshakeEndpoint: 'http://e2e-researcher.local/aitp',
      offeredCaps: ['demo.echo'],
      ttlSecs: 3600,
    });
    writerManifest = writer.buildManifest({
      displayName: 'e2e-writer',
      handshakeEndpoint: 'http://e2e-writer.local/aitp',
      offeredCaps: ['demo.write'],
      ttlSecs: 3600,
    });
  });

  afterAll(async () => {
    // Targeted cleanup so this test doesn't pollute the test DB across
    // runs. Beyond the run-tagged rows, the flow also emits CP-sourced
    // audit events with NO run_id (agent.registered on register,
    // tct.revoked on revocation), a projected handshake_sessions row,
    // and admin_audit_log rows keyed by target — sweep those by the
    // run-unique AIDs/JTI.
    await db
      .delete(agentsTable)
      .where(sql`${agentsTable.aid} in (${researcher.aid}, ${writer.aid})`);
    await db
      .delete(auditEvents)
      .where(
        sql`${auditEvents.runId} = ${RUN_ID}
          or ${auditEvents.aidA} in (${researcher.aid}, ${writer.aid})
          or ${auditEvents.aidB} in (${researcher.aid}, ${writer.aid})
          or ${auditEvents.payload}->>'jti' = ${REVOKED_JTI}`,
      );
    await db
      .delete(handshakeSessions)
      .where(
        sql`${handshakeSessions.aidA} in (${researcher.aid}, ${writer.aid})
          or ${handshakeSessions.aidB} in (${researcher.aid}, ${writer.aid})`,
      );
    await db
      .delete(revocationEntries)
      .where(sql`${revocationEntries.jti} = ${REVOKED_JTI}`);
    await db
      .delete(adminAuditLog)
      .where(
        sql`${adminAuditLog.targetId} in (${researcher.aid}, ${writer.aid}, ${REVOKED_JTI})`,
      );
    await pool.end();
  });

  it('issues enrollment tokens for both manifests', async () => {
    const res1 = await enrollPost(
      mkReq('http://localhost/api/registry/enroll', {
        method: 'POST',
        body: researcherManifest,
      }),
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { token: string; aid: string };
    expect(body1.aid).toBe(researcher.aid);
    researcherToken = body1.token;

    const res2 = await enrollPost(
      mkReq('http://localhost/api/registry/enroll', {
        method: 'POST',
        body: writerManifest,
      }),
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { token: string };
    writerToken = body2.token;
  });

  it('returns a real SDK verifyCode when enroll rejects an expired manifest', async () => {
    // The only test in the suite that proves an actual aitp code reaches an
    // actual HTTP body — every other enroll failure test mocks the service,
    // so without this the whole `verifyCode` contract rests on hand-built
    // errors that merely look like the SDK's.
    const stale = AitpAgent.generate();
    const expiredManifest = stale.buildManifest({
      displayName: 'e2e-expired',
      handshakeEndpoint: 'http://e2e-expired.local/aitp',
      offeredCaps: ['demo.echo'],
      ttlSecs: -3600, // already past expires_at, so the SDK itself rejects it
    });

    const res = await enrollPost(
      mkReq('http://localhost/api/registry/enroll', {
        method: 'POST',
        body: expiredManifest,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      code: string;
      verifyCode?: string;
    };
    expect(body.code).toBe('MANIFEST_EXPIRED');
    // Asserts the TYPE, not the literal 'expired'. The SDK owns this
    // vocabulary and has already grown it 5 -> 8 codes; pinning today's
    // value would manufacture a failure out of a future reclassification.
    //
    // Note what that forward-compat stance costs here, recorded so it is not
    // mistaken for an oversight: `code: MANIFEST_EXPIRED` above depends on the
    // SDK still spelling this `expired`. If the SDK renamed it, this test would
    // still pass on the `verifyCode` assertions but the `code` assertion would
    // fail — which is the right failure, and the reason the `code` half is
    // pinned exactly while the `verifyCode` half is not.
    expect(typeof body.verifyCode).toBe('string');
    expect(body.verifyCode).not.toBe('');
    // Deliberately NOT asserted: body.error's wording. Two reasons — the SDK
    // says the message is not a contract, and under Jest's vm realm
    // route.ts's `err instanceof Error` is false for a native SDK error, so
    // the message arrives here via String(err) with an "Error: " prefix that
    // production never emits. Asserting the prose would bake in a
    // Jest-only artifact. Non-empty is the strongest assertion left.
    expect(typeof body.error).toBe('string');
    expect(body.error).not.toBe('');
  });

  it('omits verifyCode when the in-repo guard, not the SDK, rejects the manifest', async () => {
    // The other half of the biconditional the response shape promises:
    // `verifyCode` present ⇔ the aitp SDK rejected the manifest. A 60-second
    // TTL is validly signed and the SDK ACCEPTS it — only enrollment.ts's own
    // 5-minute registration guard rejects it, throwing a
    // `ManifestRejectedError` whose `cpCode` is MANIFEST_EXPIRED and which
    // carries no SDK `.code`. Note that "no `.code`" is not by itself what the
    // route keys on: a plain `.code`-less Error is exactly what it rethrows as a
    // 500. The positive `ManifestRejectedError` marker is what makes this a 400.
    // Without this test, absence is proven only against a mocked service, i.e.
    // against our own assumption about what the SDK does.
    const shortLived = AitpAgent.generate();
    const shortManifest = shortLived.buildManifest({
      displayName: 'e2e-short-ttl',
      handshakeEndpoint: 'http://e2e-short.local/aitp',
      offeredCaps: ['demo.echo'],
      ttlSecs: 60, // inside the 5-minute guard, but NOT expired
    });

    const res = await enrollPost(
      mkReq('http://localhost/api/registry/enroll', {
        method: 'POST',
        body: shortManifest,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('MANIFEST_EXPIRED');
    expect('verifyCode' in body).toBe(false);
    // The prose IS ours on this path (enrollment.ts, not the SDK), so it is
    // safe to pin — and pinning it proves the SDK really did accept the
    // manifest and our guard really is what rejected it.
    expect(body.error).toContain('longer TTL');
  });

  it('agrees with the register route on the code for the same 60s manifest', async () => {
    // The agreement enrollment.ts's own header claims and which nothing
    // asserted until now. The two routes applied the same condition with the
    // same byte-identical message under two DIFFERENT codes, so the same
    // rejection was machine-detectable on register and prose-only on enroll.
    //
    // What this does NOT assert, deliberately: that the two guards are the same
    // guard. They are not — each declares its own constant and they disagree on
    // `expires_at: 0` (see enrollment.ts's header). This pins the wire contract
    // the two routes present to a client, which is the part a client depends on.
    //
    // Driven end to end rather than by comparing constants: the codes are
    // emitted from two different files by two different mechanisms
    // (`ManifestRejectedError.cpCode` here, an inline literal there), so only
    // reading them off two real responses proves they agree.
    const shortLived = AitpAgent.generate();
    const longManifest = shortLived.buildManifest({
      displayName: 'e2e-cross-route',
      handshakeEndpoint: 'http://e2e-cross.local/aitp',
      offeredCaps: ['demo.echo'],
      ttlSecs: 3600, // long enough to earn a token
    });
    const shortManifest = shortLived.buildManifest({
      displayName: 'e2e-cross-route',
      handshakeEndpoint: 'http://e2e-cross.local/aitp',
      offeredCaps: ['demo.echo'],
      ttlSecs: 60, // same aid, TTL inside the guard
    });

    // Enroll side: rejected outright.
    const enrollRes = await enrollPost(
      mkReq('http://localhost/api/registry/enroll', {
        method: 'POST',
        body: shortManifest,
      }),
    );
    expect(enrollRes.status).toBe(400);
    const enrollBody = (await enrollRes.json()) as { code: string; error: string };

    // Register side: needs a valid token, which only the long manifest can
    // earn — the same agent, so the token's `sub` still matches the short
    // manifest's aid. That is what lets the register-time guard be reached at
    // all, and it is exactly the round-trip the enroll-time guard exists to
    // save a caller from.
    const tokenRes = await enrollPost(
      mkReq('http://localhost/api/registry/enroll', {
        method: 'POST',
        body: longManifest,
      }),
    );
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };

    const registerRes = await registerPost(
      mkReq('http://localhost/api/registry/agents', {
        method: 'POST',
        body: shortManifest,
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(registerRes.status).toBe(400);
    const registerBody = (await registerRes.json()) as {
      code: string;
      error: string;
    };

    expect(enrollBody.code).toBe(registerBody.code);
    expect(enrollBody.code).toBe('MANIFEST_EXPIRED');
    // The messages were already byte-identical; asserting it keeps the pair
    // honest if either side is reworded without the other.
    expect(enrollBody.error).toBe(registerBody.error);
  });

  it('registers both agents with their tokens', async () => {
    const r1 = await registerPost(
      mkReq('http://localhost/api/registry/agents', {
        method: 'POST',
        body: researcherManifest,
        headers: { authorization: `Bearer ${researcherToken}` },
      }),
    );
    expect(r1.status).toBe(201);

    const r2 = await registerPost(
      mkReq('http://localhost/api/registry/agents', {
        method: 'POST',
        body: writerManifest,
        headers: { authorization: `Bearer ${writerToken}` },
      }),
    );
    expect(r2.status).toBe(201);
  });

  it('discovers both agents by capability', async () => {
    const echoRes = await listAgentsGet(
      mkReq(
        'http://localhost/api/registry/agents?capability=demo.echo',
      ),
    );
    const writeRes = await listAgentsGet(
      mkReq(
        'http://localhost/api/registry/agents?capability=demo.write',
      ),
    );
    const echoBody = (await echoRes.json()) as {
      agents: { aid: string; handshakeEndpoint: string }[];
    };
    const writeBody = (await writeRes.json()) as {
      agents: { aid: string }[];
    };
    expect(echoBody.agents.some((a) => a.aid === researcher.aid)).toBe(true);
    expect(echoBody.agents.find((a) => a.aid === researcher.aid)?.handshakeEndpoint).toBe(
      'http://e2e-researcher.local/aitp',
    );
    expect(writeBody.agents.some((a) => a.aid === writer.aid)).toBe(true);
  });

  it('accepts a synthetic handshake.complete event and serves it from history', async () => {
    const sessionId = randomUUID();
    const event = {
      type: 'handshake.complete',
      ts: new Date().toISOString(),
      aid_a: researcher.aid,
      aid_b: writer.aid,
      session_id: sessionId,
      run_id: RUN_ID,
      grants: ['demo.echo'],
      payload: { boundary: 'intra-org' },
    };
    const ingest = await eventsPost(
      mkReq('http://localhost/api/events', {
        method: 'POST',
        body: JSON.stringify({ events: [event] }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(ingest.status).toBe(200);
    expect(await ingest.json()).toMatchObject({ ingested: 1 });

    // Allow the async event publishing to settle. The handler awaits
    // ingest + last_seen but fires webhooks asynchronously; history is
    // already durable by the time POST resolves.
    const history = await eventsHistoryGet(
      mkReq(
        `http://localhost/api/events/history?runId=${encodeURIComponent(RUN_ID)}`,
      ),
    );
    expect(history.status).toBe(200);
    const body = (await history.json()) as {
      events: { type: string; sessionId: string }[];
    };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.find((e) => e.sessionId === sessionId)?.type).toBe(
      'handshake.complete',
    );
  });

  it('records a revocation and serves a signed list containing the JTI', async () => {
    const res = await revocationPost(
      mkReq('http://localhost/api/revocation/entries', {
        method: 'POST',
        body: JSON.stringify({ jti: REVOKED_JTI, reason: 'e2e-test' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);

    const listRes = await revocationListGet();
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).toContain(REVOKED_JTI);
    // Cleanup happens in afterAll (keyed by REVOKED_JTI) so a failure
    // above still leaves nothing behind.
  });
});
