import { checkColumnString } from '@/lib/http/validate';

/** `webhooks.secret` is varchar(255) (src/lib/db/schema.ts). */
export const WEBHOOK_SECRET_MAX = 255;

/**
 * Storability checks shared by POST /api/webhooks and PATCH /api/webhooks/:id.
 * Returns a human error message (answer `400 BODY_INVALID`), or `null`.
 *
 * Only fields of the type the routes actually use are checked — a non-string
 * `url`/`secret` or a non-array `events` keeps each route's existing handling.
 *   - `url` (text): no U+0000.
 *   - `events` (jsonb array of strings): no U+0000 in any string entry
 *     (Postgres jsonb cannot hold `\u0000`: 22P05).
 *   - `secret` (varchar(255)): <= 255 code points, no U+0000.
 */
export function checkWebhookFields(body: Record<string, unknown>): string | null {
  if (typeof body.url === 'string' && body.url.includes('\u0000')) {
    return 'url must not contain a NUL character';
  }
  if (Array.isArray(body.events)) {
    for (const e of body.events) {
      if (typeof e === 'string' && e.includes('\u0000')) {
        return 'events must not contain a NUL character';
      }
    }
  }
  if (typeof body.secret === 'string') {
    const problem = checkColumnString(body.secret, {
      field: 'secret',
      max: WEBHOOK_SECRET_MAX,
    });
    if (problem) return problem;
  }
  return null;
}
