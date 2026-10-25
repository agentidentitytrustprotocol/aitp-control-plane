/**
 * Integration test for drizzle/0009_revocation_iss.sql against a real
 * Postgres: the migrator recorded it, the column and index exist, and the
 * backfill attributes a revocation entry from the TCT projection while leaving
 * an unmatched entry (and an already-attributed one) alone, idempotently. The
 * manual rollback is executed inside a transaction that is rolled back, so it
 * is proven to run without changing the schema the other suites use.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inArray, sql } from 'drizzle-orm';
import { db, pool } from './index';
import { issuedTcts, revocationEntries } from './schema';

const DRIZZLE = join(__dirname, '../../../drizzle');
const migrationSql = readFileSync(join(DRIZZLE, '0009_revocation_iss.sql'), 'utf8');
const downSql = readFileSync(join(DRIZZLE, 'manual/0009_revocation_iss.down.sql'), 'utf8');
const statements = migrationSql.split('--> statement-breakpoint').map((s) => s.trim());
const BACKFILL = statements.find((s) => /^UPDATE /m.test(s))!;

const ISSUER = 'aid:pubkey:backfill-issuer';
const PRESET = 'aid:pubkey:already-attributed';
const jtis = { matched: randomUUID(), unmatched: randomUUID(), preset: randomUUID() };

describe('integration: 0009 revocation_entries.iss', () => {
  beforeAll(async () => {
    await db.insert(issuedTcts).values(
      [jtis.matched, jtis.preset].map((jti) => ({
        jti,
        issuerAid: ISSUER,
        subjectAid: 'aid:pubkey:sub',
        audienceAid: 'aid:pubkey:sub',
        issuedAt: new Date().toISOString(),
      })),
    );
    // As they stood before 0009 ran: no issuer recorded.
    await db.insert(revocationEntries).values([
      { jti: jtis.matched, revokedAt: new Date().toISOString(), iss: null },
      { jti: jtis.unmatched, revokedAt: new Date().toISOString(), iss: null },
      { jti: jtis.preset, revokedAt: new Date().toISOString(), iss: PRESET },
    ]);
  });

  afterAll(async () => {
    await db.delete(revocationEntries).where(inArray(revocationEntries.jti, Object.values(jtis)));
    await db.delete(issuedTcts).where(inArray(issuedTcts.jti, Object.values(jtis)));
    await pool.end();
  });

  it('was applied by the drizzle migrator', async () => {
    const hash = createHash('sha256').update(migrationSql).digest('hex');
    const result = await db.execute(
      sql`select 1 from drizzle.__drizzle_migrations where hash = ${hash}`,
    );
    expect((result as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('created the column and its index', async () => {
    const col = await db.execute(sql`
      select data_type, character_maximum_length, is_nullable
      from information_schema.columns
      where table_name = 'revocation_entries' and column_name = 'iss'`);
    expect((col as unknown as { rows: unknown[] }).rows).toEqual([
      { data_type: 'character varying', character_maximum_length: 512, is_nullable: 'YES' },
    ]);
    const idx = await db.execute(
      sql`select 1 from pg_indexes where indexname = 'revocation_entries_iss_idx'`,
    );
    expect((idx as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('backfills from issued_tcts, leaves unmatched and preset rows alone, and is idempotent', async () => {
    expect(BACKFILL).toMatch(/^UPDATE "revocation_entries"/m);
    const issById = async () =>
      Object.fromEntries(
        (
          await db
            .select({ jti: revocationEntries.jti, iss: revocationEntries.iss })
            .from(revocationEntries)
            .where(inArray(revocationEntries.jti, Object.values(jtis)))
        ).map((r) => [r.jti, r.iss]),
      );

    await db.execute(sql.raw(BACKFILL));
    const after = await issById();
    expect(after).toEqual({
      [jtis.matched]: ISSUER,
      [jtis.unmatched]: null,
      [jtis.preset]: PRESET,
    });

    await db.execute(sql.raw(BACKFILL));
    expect(await issById()).toEqual(after);
  });

  it('the manual rollback runs cleanly (inside a rolled-back transaction)', async () => {
    const body = downSql
      .split('\n')
      .filter((l) => !/^(BEGIN|COMMIT);$/.test(l.trim()))
      .join('\n');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(body);
      const col = await client.query(
        "select 1 from information_schema.columns where table_name = 'revocation_entries' and column_name = 'iss'",
      );
      expect(col.rows).toHaveLength(0);
      const tracked = await client.query(
        'select 1 from drizzle.__drizzle_migrations where created_at = 1792889029260',
      );
      expect(tracked.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
