-- Rollback for drizzle/0009_revocation_iss.sql. NOT run by `npm run db:migrate`.
--
-- Drops the `iss` column and its index, then removes 0009 from drizzle's
-- tracking table so a later `db:migrate` re-applies it. The attribution the
-- column held is lost; re-applying 0009 re-derives what `issued_tcts` can.
--
--   psql "$DATABASE_URL" -f drizzle/manual/0009_revocation_iss.down.sql
BEGIN;
DROP INDEX IF EXISTS "revocation_entries_iss_idx";
ALTER TABLE "revocation_entries" DROP COLUMN IF EXISTS "iss";
-- 1792889029260 is 0009's `when` in drizzle/meta/_journal.json.
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792889029260;
COMMIT;
