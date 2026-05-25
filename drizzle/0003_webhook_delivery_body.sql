-- Audit-fix #4 — webhook deliveries now persist their canonical body
-- bytes and HMAC signature at enqueue time. Retries re-POST the exact
-- same bytes so the signature stays stable, which makes idempotency-
-- by-signature work on the receiver side.
--
-- Nullable so rows enqueued before this column existed can still be
-- retried (the service falls back to per-attempt construction with
-- a logged warning).
ALTER TABLE "webhook_deliveries" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "signature" varchar(64);
