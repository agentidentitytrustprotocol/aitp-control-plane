/**
 * End-to-end flow exercise. Drives the route handlers directly (no
 * HTTP listener, no middleware) but uses a real Postgres and real
 * AITP cryptography via the Rust binding.
 *
 * Flow:
 *   1. Generate two AITP agents (researcher, writer)
 *   2. Each builds a signed manifest
 *   3. POST /api/registry/enroll for each → enrollment token
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
  agents as agentsTable,
  auditEvents,
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
    // Targeted cleanup so this test doesn't pollute the test DB across runs.
    await db
      .delete(agentsTable)
      .where(sql`${agentsTable.aid} in (${researcher.aid}, ${writer.aid})`);
    await db.delete(auditEvents).where(sql`${auditEvents.runId} = ${RUN_ID}`);
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
    const jti = randomUUID();
    const res = await revocationPost(
      mkReq('http://localhost/api/revocation/entries', {
        method: 'POST',
        body: JSON.stringify({ jti, reason: 'e2e-test' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);

    const listRes = await revocationListGet();
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).toContain(jti);

    // Cleanup
    await db
      .delete(revocationEntries)
      .where(sql`${revocationEntries.jti} = ${jti}`);
  });
});
