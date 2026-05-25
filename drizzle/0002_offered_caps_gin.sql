-- 2.1 — GIN over offered_caps so capability discovery skips full
-- table scans once the registry has ~1k+ agents.
--
-- IF NOT EXISTS keeps this idempotent for environments that already
-- applied this index inside the original combined 0001 migration
-- (pre-split). Fresh installs after the split create it here.
--
-- Production note: this statement runs INSIDE drizzle-kit's per-
-- migration transaction, so it takes an ACCESS EXCLUSIVE lock on
-- `agents` for the duration of the build. On large tables that lock
-- window blocks writes — use the lock-free `CREATE INDEX CONCURRENTLY`
-- variant in `drizzle/manual/0002_offered_caps_gin.concurrent.sql`
-- instead, then mark this migration as applied via:
--   INSERT INTO drizzle.__drizzle_migrations (hash, created_at) ...
CREATE INDEX IF NOT EXISTS "agents_offered_caps_gin"
  ON "agents" USING gin ("offered_caps");
