/**
 * Integration: the enrollment token is spent only by a registration that
 * commits (#151). Against a real Postgres:
 *
 *   - a 400 that depends only on the request (MANIFEST_EXPIRED, a non-string
 *     manifest.extensions.namespace) answers BEFORE the jti is consumed: the
 *     same token gets the same 400 again, not TOKEN_REPLAYED, and no
 *     enrollment_jtis row exists. (The token binds the exact body bytes, msh,
 *     so a corrected manifest needs a new token; what #151 guarantees is that
 *     the 400 itself spends nothing.)
 *   - a database fault in the upsert (injected with a trigger scoped to one
 *     AID) rolls the consume back: the same token and body then succeed, and a
 *     third presentation is TOKEN_REPLAYED.
 *   - two simultaneous registrations with one token: exactly one 201.
 */
import { AitpAgent } from 'aitp';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';

import { POST as enrollPost } from '@/app/api/registry/enroll/route';
import { POST as registerPost } from '@/app/api/registry/agents/route';
import { getEnrollmentService, manifestDigest } from '@/lib/registry/enrollment';
import { db, pool } from '@/lib/db';
import {
  adminAuditLog,
  agents as agentsTable,
  auditEvents,
  enrollmentJtis,
} from '@/lib/db/schema';

function mkReq(url: string, body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { method: 'POST', body, headers });
}

function register(body: string, token: string): Promise<Response> {
  return registerPost(
    mkReq('http://localhost/api/registry/agents', body, { authorization: `Bearer ${token}` }),
  );
}

/** A real token from POST /api/registry/enroll for `manifest`. */
async function enroll(manifest: string): Promise<string> {
  const res = await enrollPost(mkReq('http://localhost/api/registry/enroll', manifest));
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** A token minted the way /enroll would, for a body /enroll itself refuses. */
function mint(aid: string, body: string): { token: string; jti: string } {
  const now = Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  const token = (getEnrollmentService() as unknown as { sign(p: object): string }).sign({
    sub: aid,
    scope: 'register',
    iat: now,
    exp: now + 300,
    jti,
    msh: manifestDigest(body),
  });
  return { token, jti };
}

function jtiOf(token: string): string {
  const payload = token.split('.')[0];
  return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { jti: string }).jti;
}

async function jtiConsumed(jti: string): Promise<boolean> {
  const rows = await db.select().from(enrollmentJtis).where(eq(enrollmentJtis.jti, jti));
  return rows.length > 0;
}

const aids: string[] = [];
const jtis: string[] = [];

function agent(): AitpAgent {
  const a = AitpAgent.generate();
  aids.push(a.aid);
  return a;
}

function manifestOf(a: AitpAgent, ttlSecs = 3600): string {
  return a.buildManifest({
    displayName: 'e2e-token',
    handshakeEndpoint: 'https://e2e-token.local/aitp',
    offeredCaps: ['demo.echo'],
    ttlSecs,
  });
}

afterAll(async () => {
  if (aids.length) {
    await db.delete(agentsTable).where(inArray(agentsTable.aid, aids));
    await db.delete(auditEvents).where(inArray(auditEvents.aidA, aids));
    await db.delete(adminAuditLog).where(inArray(adminAuditLog.targetId, aids));
  }
  if (jtis.length) await db.delete(enrollmentJtis).where(inArray(enrollmentJtis.jti, jtis));
  await pool.end();
});

describe('a 400 before the consume does not spend the token', () => {
  it('MANIFEST_EXPIRED twice with one token, and the jti is never consumed', async () => {
    const a = agent();
    const body = manifestOf(a, 60); // inside the 5-minute guard
    const { token, jti } = mint(a.aid, body);
    jtis.push(jti);
    for (let i = 0; i < 2; i++) {
      const res = await register(body, token);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('MANIFEST_EXPIRED');
    }
    expect(await jtiConsumed(jti)).toBe(false);
  });

  it('a non-string manifest.extensions.namespace is BODY_INVALID twice, never consumed', async () => {
    const a = agent();
    const env = JSON.parse(manifestOf(a)) as { manifest: Record<string, unknown> };
    env.manifest.extensions = { namespace: { tenant: 'x' } };
    const body = JSON.stringify(env);
    const { token, jti } = mint(a.aid, body);
    jtis.push(jti);
    for (let i = 0; i < 2; i++) {
      const res = await register(body, token);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('BODY_INVALID');
    }
    expect(await jtiConsumed(jti)).toBe(false);
  });
});

describe('the consume commits with the upsert', () => {
  it('an upsert fault rolls the consume back; the same token then succeeds, then replays', async () => {
    const a = agent();
    const body = manifestOf(a);
    const token = await enroll(body);
    const jti = jtiOf(token);
    jtis.push(jti);

    // A real database fault on exactly this AID's upsert, so parallel suites
    // are unaffected. Names are run-unique; dropped in `finally`.
    const tag = `t151_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      sql.raw(`create function ${tag}() returns trigger language plpgsql as $$
        begin
          if new.aid = '${a.aid}' then raise exception 'injected upsert fault'; end if;
          return new;
        end $$`),
    );
    await db.execute(
      sql.raw(`create trigger ${tag} before insert or update on agents
        for each row execute function ${tag}()`),
    );
    try {
      await expect(register(body, token)).rejects.toThrow();
      expect(await jtiConsumed(jti)).toBe(false);
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${tag} on agents`));
      await db.execute(sql.raw(`drop function if exists ${tag}()`));
    }

    const retry = await register(body, token);
    expect(retry.status).toBe(201);
    expect(await jtiConsumed(jti)).toBe(true);
    const rows = await db.select().from(agentsTable).where(eq(agentsTable.aid, a.aid));
    expect(rows).toHaveLength(1);

    const again = await register(body, token);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { code: string }).code).toBe('TOKEN_REPLAYED');
  });

  it('two simultaneous registrations with one token: exactly one succeeds', async () => {
    const a = agent();
    const body = manifestOf(a);
    const token = await enroll(body);
    jtis.push(jtiOf(token));

    const results = await Promise.all([register(body, token), register(body, token)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 401]);
    const loser = results.find((r) => r.status === 401)!;
    expect(((await loser.json()) as { code: string }).code).toBe('TOKEN_REPLAYED');
  });
});
