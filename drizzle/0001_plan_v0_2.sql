-- PLAN.md v0.1 → v0.2 schema upgrade.
-- Bug 2 (status normalization), 2.2 (namespace), 2.6 (last_enrolled_at).
-- The 2.1 GIN-on-offered_caps index was originally in this migration
-- too; it moved to 0002_offered_caps_gin.sql so production deploys
-- have a one-statement migration that can be applied CONCURRENTLY
-- on a large `agents` table (see drizzle/manual/ for that variant).

-- Bug 2 — normalize legacy 'inactive' status to 'deregistered' so the
-- rest of the codebase can rely on the documented status vocabulary.
UPDATE "agents" SET "status" = 'deregistered' WHERE "status" = 'inactive';--> statement-breakpoint

-- 2.6 — track each (re-)enrollment timestamp distinct from registered_at.
ALTER TABLE "agents" ADD COLUMN "last_enrolled_at" timestamp with time zone;--> statement-breakpoint

-- 2.2 — multi-tenant / multi-env scoping for the registry.
ALTER TABLE "agents" ADD COLUMN "namespace" varchar(128) DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX "agents_namespace_idx" ON "agents" USING btree ("namespace");
