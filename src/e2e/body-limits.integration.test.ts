/**
 * Integration: request-body ceilings, one test group per route class (#150).
 *
 *   - public manifest route  POST /api/registry/enroll    MANIFEST_BODY_MAX_BYTES
 *   - token manifest route   POST /api/registry/agents    MANIFEST_BODY_MAX_BYTES
 *   - admin JSON route       POST /api/revocation/entries ADMIN_JSON_MAX_BYTES
 *
 * Each: a body one byte over is `413 PAYLOAD_TOO_LARGE`, and a body exactly at
 * the ceiling is read and judged on its content. Handlers are called directly
 * against a real Postgres, as the other integration tests do.
 */
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { POST as enrollPost } from '@/app/api/registry/enroll/route';
import { POST as agentsPost } from '@/app/api/registry/agents/route';
import { POST as revocationPost } from '@/app/api/revocation/entries/route';
import { ADMIN_JSON_MAX_BYTES, MANIFEST_BODY_MAX_BYTES } from '@/lib/http/read-body';
import { db, pool } from '@/lib/db';
import { idempotencyKeys, revocationEntries } from '@/lib/db/schema';

/** `json` padded with trailing spaces (still valid JSON) to exactly `bytes`. */
function padTo(json: string, bytes: number): string {
  const n = bytes - Buffer.byteLength(json);
  if (n < 0) throw new Error('json is already over the target size');
  return json + ' '.repeat(n);
}

function post(url: string, body: BodyInit, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
    duplex: 'half',
  });
}

async function expect413(res: Response, maxBytes: number): Promise<void> {
  expect(res.status).toBe(413);
  await expect(res.json()).resolves.toEqual({
    error: `request body exceeds ${maxBytes} bytes`,
    code: 'PAYLOAD_TOO_LARGE',
  });
}

const ENROLL = 'http://localhost/api/registry/enroll';
const AGENTS = 'http://localhost/api/registry/agents';
const ENTRIES = 'http://localhost/api/revocation/entries';

const createdJtis: string[] = [];

afterAll(async () => {
  for (const jti of createdJtis) {
    await db.delete(revocationEntries).where(eq(revocationEntries.jti, jti));
  }
  await pool.end();
});

describe('POST /api/registry/enroll (public; manifest ceiling)', () => {
  const at = padTo('{"manifest":{}}', MANIFEST_BODY_MAX_BYTES);

  it('one byte over is 413', async () => {
    await expect413(await enrollPost(post(ENROLL, at + ' ')), MANIFEST_BODY_MAX_BYTES);
  });

  it('at the ceiling is read and judged on content (not 413)', async () => {
    const res = await enrollPost(post(ENROLL, at));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('MANIFEST_INVALID');
  });

  it('an endless chunked body with no Content-Length is cut off, not buffered', async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect413(await enrollPost(post(ENROLL, stream)), MANIFEST_BODY_MAX_BYTES);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(MANIFEST_BODY_MAX_BYTES * 2);
  });
});

describe('POST /api/registry/agents (token; manifest ceiling)', () => {
  it('one byte over is 413, before the token and with no database write', async () => {
    const key = `body-limits-${randomUUID()}`;
    const body = padTo('{"manifest":{"aid":"aid:test:x"}}', MANIFEST_BODY_MAX_BYTES + 1);
    const res = await agentsPost(
      post(AGENTS, body, { authorization: 'Bearer not-a-token', 'idempotency-key': key }),
    );
    await expect413(res, MANIFEST_BODY_MAX_BYTES);
    const stored = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(idempotencyKeys)
      .where(sql`${idempotencyKeys.key} = ${key}`);
    expect(stored[0].n).toBe(0);
  });

  it('at the ceiling is read and judged on content (not 413)', async () => {
    const body = padTo('{"manifest":{"aid":"aid:test:x"}}', MANIFEST_BODY_MAX_BYTES);
    const res = await agentsPost(post(AGENTS, body, { authorization: 'Bearer not-a-token' }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('TOKEN_INVALID');
  });
});

describe('POST /api/revocation/entries (admin JSON ceiling)', () => {
  it('one byte over is 413', async () => {
    const jti = randomUUID();
    const body = padTo(JSON.stringify({ jti, iss: 'aid:test:body-limits' }), ADMIN_JSON_MAX_BYTES + 1);
    await expect413(await revocationPost(post(ENTRIES, body)), ADMIN_JSON_MAX_BYTES);
    const rows = await db.select().from(revocationEntries).where(eq(revocationEntries.jti, jti));
    expect(rows).toHaveLength(0);
  });

  it('at the ceiling is accepted', async () => {
    const jti = randomUUID();
    createdJtis.push(jti);
    const body = padTo(JSON.stringify({ jti, iss: 'aid:test:body-limits' }), ADMIN_JSON_MAX_BYTES);
    const res = await revocationPost(post(ENTRIES, body));
    expect(res.status).toBe(201);
  });
});
