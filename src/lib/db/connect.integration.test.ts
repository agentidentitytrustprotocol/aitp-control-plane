/**
 * Smoke test: verify the integration suite can reach Postgres and that
 * the schema was migrated before it ran. Failures here mean the CI
 * harness (Postgres service container + db:migrate step) is broken.
 */

import { db, pool } from './index';
import { sql } from 'drizzle-orm';
import pg from 'pg';

describe('integration: database connectivity', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('responds to a trivial query', async () => {
    const result = await db.execute(sql`select 1 as ok`);
    const row = (result as unknown as { rows: { ok: number }[] }).rows[0];
    expect(row.ok).toBe(1);
  });

  it('has the agents table migrated', async () => {
    const result = await db.execute(sql`
      select 1
      from information_schema.tables
      where table_name = 'agents'
    `);
    const rows = (result as unknown as { rows: unknown[] }).rows;
    expect(rows.length).toBe(1);
  });

  // #144: a backend killed under an idle pooled client (Postgres restart,
  // failover) surfaces as a pool 'error' event; unhandled, it is an uncaught
  // exception. The pool must absorb it and serve the next query.
  it('survives an idle client whose backend is terminated', async () => {
    // The module's own listener; the once() below only observes the event.
    expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);
    const pid = (await pool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
    const errored = new Promise<Error>((resolve) => pool.once('error', resolve));
    const killer = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await killer.connect();
    try {
      await killer.query('select pg_terminate_backend($1)', [pid]);
    } finally {
      await killer.end();
    }
    expect(String(await errored)).toMatch(/terminat/i);
    const result = await db.execute(sql`select 1 as ok`);
    expect((result as unknown as { rows: { ok: number }[] }).rows[0].ok).toBe(1);
  });
});
