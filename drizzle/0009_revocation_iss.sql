-- CP1.1: per-issuer revocation relay (RFC-AITP-0008 §1.5).
--
-- Records which issuer each revocation entry is relayed to. Additive and
-- nullable, so it is safe on a live table. The backfill attributes existing
-- rows from the CP's TCT projection; a row with no matching `issued_tcts`
-- row stays NULL ("unattributed") and is never relayed: an operator
-- re-posts it with an explicit `iss` (docs/operations.md).
--
-- Rollback: drizzle/manual/0009_revocation_iss.down.sql.
ALTER TABLE "revocation_entries" ADD COLUMN "iss" varchar(512);--> statement-breakpoint
UPDATE "revocation_entries" AS r
SET "iss" = t."issuer_aid"
FROM "issued_tcts" AS t
WHERE t."jti" = r."jti" AND r."iss" IS NULL;--> statement-breakpoint
CREATE INDEX "revocation_entries_iss_idx" ON "revocation_entries" USING btree ("iss");
