/**
 * Smoke test: verify the integration suite can reach Postgres and that
 * the schema was migrated before it ran. Failures here mean the CI
 * harness (Postgres service container + db:migrate step) is broken.
 */

import { db, pool } from './index';
import { sql } from 'drizzle-orm';

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
});
