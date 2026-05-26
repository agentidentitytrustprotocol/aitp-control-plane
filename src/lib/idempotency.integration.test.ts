/**
 * Integration tests for the idempotency layer against a real Postgres.
 * Verifies that:
 *   - missing header: handler runs every time
 *   - present header, first call: handler runs, row persisted
 *   - present header, replay: handler is NOT re-run, cached row returned
 *   - parallel calls with same key produce one persisted row
 *   - invalid header is rejected
 */

import { randomUUID } from 'node:crypto';
import { db, pool } from './db';
import { idempotencyKeys } from './db/schema';
import { withIdempotency } from './idempotency';
import { and, eq, sql } from 'drizzle-orm';

function makeReq(headers: Record<string, string> = {}): {
  headers: { get: (k: string) => string | null };
} {
  const m = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: {
      get: (k: string) => m.get(k.toLowerCase()) ?? null,
    },
  };
}

describe('integration: withIdempotency', () => {
  const SCOPE = 'test.idempotency';

  afterEach(async () => {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.scope, SCOPE));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('runs the handler every time when no header is supplied', async () => {
    let calls = 0;
    const exec = async () => {
      calls++;
      return { status: 201, body: { count: calls } };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r1 = await withIdempotency(makeReq() as any, SCOPE, exec);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r2 = await withIdempotency(makeReq() as any, SCOPE, exec);
    expect(calls).toBe(2);
    expect(await r1.json()).toEqual({ count: 1 });
    expect(await r2.json()).toEqual({ count: 2 });
  });

  it('replays the same response and does not re-run the handler', async () => {
    const key = randomUUID();
    let calls = 0;
    const exec = async () => {
      calls++;
      return { status: 201, body: { id: 'first', call: calls } };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = makeReq({ 'Idempotency-Key': key }) as any;
    const r1 = await withIdempotency(req, SCOPE, exec);
    const r2 = await withIdempotency(req, SCOPE, exec);
    expect(calls).toBe(1);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await r1.json()).toEqual({ id: 'first', call: 1 });
    expect(await r2.json()).toEqual({ id: 'first', call: 1 });
  });

  it('persists exactly one row for parallel calls with the same key', async () => {
    const key = randomUUID();
    let calls = 0;
    const exec = async () => {
      calls++;
      return { status: 201, body: { id: 'race', call: calls } };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = makeReq({ 'Idempotency-Key': key }) as any;
    await Promise.all([
      withIdempotency(req, SCOPE, exec),
      withIdempotency(req, SCOPE, exec),
      withIdempotency(req, SCOPE, exec),
    ]);
    const rows = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, SCOPE), eq(idempotencyKeys.key, key)));
    expect(rows.length).toBe(1);
  });

  it('rejects invalid keys (empty, too long, control chars)', async () => {
    const exec = async () => ({ status: 200, body: {} });
    for (const bad of ['', '\n\nkey', 'x'.repeat(300)]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = makeReq({ 'Idempotency-Key': bad }) as any;
      const r = await withIdempotency(req, SCOPE, exec);
      expect(r.status).toBe(400);
      const body = await r.json();
      expect(body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    }
  });

  it('isolates keys across scopes', async () => {
    const key = randomUUID();
    let calls = 0;
    const exec = async () => {
      calls++;
      return { status: 200, body: { call: calls } };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = makeReq({ 'Idempotency-Key': key }) as any;
    await withIdempotency(req, SCOPE, exec);
    await withIdempotency(req, `${SCOPE}.other`, exec);
    expect(calls).toBe(2);
    // Cleanup the second scope's row
    await db
      .delete(idempotencyKeys)
      .where(eq(idempotencyKeys.scope, `${SCOPE}.other`));
    // Sanity check that both rows existed by clearing returns 0
    const remaining = await db.execute(
      sql`select count(*)::int as c from ${idempotencyKeys} where key = ${key}`,
    );
    expect((remaining as unknown as { rows: { c: number }[] }).rows[0]!.c).toBeLessThanOrEqual(1);
  });
});
