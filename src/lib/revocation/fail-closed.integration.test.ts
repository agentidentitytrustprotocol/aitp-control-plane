/**
 * Integration: the revocation list FAILS CLOSED against a real Postgres.
 *
 * The scenario is the one scripts/verify-image.mjs documents: a database that
 * answers but whose migrations never ran, so `revocation_entries` does not
 * exist and the producer's SELECT fails with `relation ... does not exist`.
 * Before this change that produced a 200 carrying an EMPTY, VALIDLY SIGNED list
 * ("nothing is revoked"). Now it must be a coded 503 that signs nothing and
 * leaks no Postgres vocabulary — and the producer must recover once the table
 * appears.
 *
 * The failure is made on a throwaway DATABASE (not by renaming the shared
 * table), so the other integration suites, which run in parallel workers
 * against the real one, are never disturbed.
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';

const ADMIN_URL = process.env.DATABASE_URL as string;
const dbName = `aitp_revfail_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const tempUrl = (() => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

type G = {
  __db?: unknown;
  __dbPool?: pg.Pool;
  __revocationProducer?: unknown;
};
const g = globalThis as unknown as G;

/** Wait until no backend is connected to `db`; fail loudly, naming them, if one lingers. */
async function waitForNoBackends(admin: pg.Pool, db: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await admin.query<{ pid: number; state: string | null; query: string }>(
      'SELECT pid, state, query FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [db],
    );
    if (rows.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`connections to ${db} still open after ${timeoutMs}ms: ${JSON.stringify(rows)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('integration: revocation list fails closed on a failing database', () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  let routeGet: () => Promise<Response>;
  let producerPool: pg.Pool;
  let saved: G;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${dbName}`);
    // Rebind the module-level singletons to the throwaway database.
    saved = { __db: g.__db, __dbPool: g.__dbPool, __revocationProducer: g.__revocationProducer };
    delete g.__db;
    delete g.__dbPool;
    delete g.__revocationProducer;
    process.env.DATABASE_URL = tempUrl;
    delete process.env.REVOCATION_FAIL_MODE;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    routeGet = require('@/app/api/well-known/aitp-revocation-list/route').GET;
    producerPool = g.__dbPool as unknown as pg.Pool;
  });

  afterAll(async () => {
    await producerPool.end();
    Object.assign(g, saved);
    process.env.DATABASE_URL = ADMIN_URL;
    // pool.end() resolves once pg-pool has dropped its clients from its list,
    // while each client's own end() is still closing its socket. A FORCE drop
    // in that window terminates the backend (57P01) and the half-closed client,
    // no longer in any pool, emits an unhandled 'error' (#144). Wait for the
    // backends to go; FORCE stays only as a backstop.
    await waitForNoBackends(admin, dbName);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('answers 503 REVOCATION_UNAVAILABLE (not a signed empty list) when revocation_entries is missing', async () => {
    const res = await routeGet();
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Retry-After')).toBe('30');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'revocation list temporarily unavailable',
      code: 'REVOCATION_UNAVAILABLE',
    });
    // No Postgres vocabulary and no signed artifact in the body.
    expect(text).not.toMatch(/relation|revocation_entries|does not exist|signature|revocation_list/);
  });

  it('keeps failing closed on repeat requests, then recovers once the table exists', async () => {
    expect((await routeGet()).status).toBe(503);

    const c = new pg.Client({ connectionString: tempUrl });
    await c.connect();
    try {
      await c.query(`CREATE TABLE revocation_entries (
        jti uuid PRIMARY KEY NOT NULL,
        revoked_at timestamptz DEFAULT now() NOT NULL,
        reason text,
        created_at timestamptz DEFAULT now() NOT NULL)`);
    } finally {
      await c.end();
    }

    const res = await routeGet();
    expect(res.status).toBe(200);
    const env = JSON.parse(await res.text());
    expect(typeof env.signature).toBe('string');
    expect(env.revocation_list.entries).toEqual([]);
  });
});
