/**
 * Integration test for drizzle/0008_scrub_webhook_secret_audit.sql against a real
 * Postgres: a `webhook.update` audit row whose details carry a leaked `secret` is
 * scrubbed to `secretRotated: true`; every other row is untouched; a re-run is a
 * no-op. Also checks the migrator recorded the file (it ran during db:migrate).
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inArray, sql } from 'drizzle-orm';
import { db, pool } from './index';
import { adminAuditLog } from './schema';

const MIGRATION_FILE = join(
  __dirname,
  '../../../drizzle/0008_scrub_webhook_secret_audit.sql',
);
const migrationSql = readFileSync(MIGRATION_FILE, 'utf8');

async function runMigration(): Promise<void> {
  // Same statement splitting as drizzle's migrator.
  for (const stmt of migrationSql.split('--> statement-breakpoint')) {
    if (stmt.trim()) await db.execute(sql.raw(stmt));
  }
}

describe('integration: 0008 scrub webhook secrets from admin_audit_log', () => {
  const ids = {
    leaked: randomUUID(),
    leakedOnlySecret: randomUUID(),
    cleanUpdate: randomUUID(),
    otherAction: randomUUID(),
  };

  beforeAll(async () => {
    await db.insert(adminAuditLog).values([
      {
        id: ids.leaked,
        action: 'webhook.update',
        targetId: randomUUID(),
        details: { url: 'https://hook.example.com', secret: 'whsec_LEAKED_1', active: true },
      },
      {
        id: ids.leakedOnlySecret,
        action: 'webhook.update',
        targetId: randomUUID(),
        details: { secret: 'whsec_LEAKED_2' },
      },
      {
        id: ids.cleanUpdate,
        action: 'webhook.update',
        targetId: randomUUID(),
        details: { active: false },
      },
      {
        // A different action is out of scope even if it has a `secret` key.
        id: ids.otherAction,
        action: 'trust-anchor.update',
        targetId: randomUUID(),
        details: { label: 'x', secret: 'not-a-webhook-secret' },
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(adminAuditLog).where(inArray(adminAuditLog.id, Object.values(ids)));
    await pool.end();
  });

  async function detailsById(): Promise<Record<string, unknown>> {
    const rows = await db
      .select({ id: adminAuditLog.id, details: adminAuditLog.details })
      .from(adminAuditLog)
      .where(inArray(adminAuditLog.id, Object.values(ids)));
    return Object.fromEntries(rows.map((r) => [r.id, r.details]));
  }

  it('was applied by the drizzle migrator', async () => {
    const hash = createHash('sha256').update(migrationSql).digest('hex');
    const result = await db.execute(
      sql`select 1 from drizzle.__drizzle_migrations where hash = ${hash}`,
    );
    expect((result as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('scrubs leaked secrets, leaves other rows untouched, and is idempotent', async () => {
    await runMigration();
    const after = await detailsById();
    expect(after[ids.leaked]).toEqual({
      url: 'https://hook.example.com',
      active: true,
      secretRotated: true,
    });
    expect(after[ids.leakedOnlySecret]).toEqual({ secretRotated: true });
    expect(after[ids.cleanUpdate]).toEqual({ active: false });
    expect(after[ids.otherAction]).toEqual({ label: 'x', secret: 'not-a-webhook-secret' });
    expect(JSON.stringify(after)).not.toContain('whsec_LEAKED');

    await runMigration();
    expect(await detailsById()).toEqual(after);
  });
});
