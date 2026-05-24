# Migrations

Drizzle-managed migrations live in this directory. Each numbered SQL
file corresponds to one entry in `meta/_journal.json` and one snapshot
in `meta/NNNN_snapshot.json`.

## Files

- `0000_init.sql` — initial six-table schema.
- `0001_plan_v0_2.sql` — v0.2 schema upgrade: status normalize,
  `namespace`, `last_enrolled_at`, namespace btree index.
- `0002_offered_caps_gin.sql` — GIN index on `agents.offered_caps`
  for capability discovery. Uses plain `CREATE INDEX` (in-transaction).
- `0003_webhook_delivery_body.sql` — adds `body` + `signature` columns
  to `webhook_deliveries` so retries POST byte-identical bytes with
  a stable HMAC signature.

## Applying migrations

```bash
npm run db:migrate
```

Drizzle-kit wraps each migration in `BEGIN / COMMIT`. That keeps
schema upgrades atomic, but it does NOT allow `CREATE INDEX
CONCURRENTLY` (which Postgres forbids inside a transaction).

## Production-friendly variants — `manual/`

For deployments against a large live table where a brief `ACCESS
EXCLUSIVE` lock would be visible to clients, the `manual/`
subdirectory carries lock-free SQL that operators apply OUTSIDE the
drizzle migrator.

- `manual/0002_offered_caps_gin.concurrent.sql` — same GIN index but
  built with `CREATE INDEX CONCURRENTLY`. Procedure for applying it
  while still marking 0002 as "applied" in drizzle's tracking table
  is documented at the top of that file.

The header of each manual file explains its deploy procedure. The
files are NOT executed by `npm run db:migrate`; they're a parallel
track for operators.

## Adding new migrations

```bash
npx drizzle-kit generate --name=<short_name>
```

Drizzle-kit diffs your `src/lib/db/schema.ts` against the latest
snapshot in `meta/` and emits a new numbered SQL file + snapshot.
Always commit BOTH the SQL file and the snapshot.
