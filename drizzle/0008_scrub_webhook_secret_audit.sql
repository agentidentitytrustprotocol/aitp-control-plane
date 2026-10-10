-- Data-only migration: scrub webhook secrets leaked into the admin audit log.
--
-- Until this release, PATCH /api/webhooks/:id wrote its whole patch -- including
-- a new `secret` -- into admin_audit_log.details, which GET /api/audit returns to
-- any API-key holder. The route now records `secretRotated: true` instead; this
-- rewrites the rows already written the same way. Rows are kept (the audit trail
-- of the update stays), only the secret value is removed.
--
-- Idempotent: a scrubbed row no longer has a `secret` key, so a re-run matches
-- nothing. Irreversible by design. Operators should still ROTATE any webhook
-- secret that was ever set via PATCH: it may have been read before this ran.
UPDATE "admin_audit_log"
SET "details" = ("details" - 'secret') || '{"secretRotated": true}'::jsonb
WHERE "action" = 'webhook.update'
  AND jsonb_typeof("details") = 'object'
  AND "details" ? 'secret';
