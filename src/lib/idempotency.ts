/**
 * Idempotency-Key support for mutating endpoints.
 *
 * Wrap a route handler in `withIdempotency(req, scope, exec)`. If the
 * client supplied an `Idempotency-Key` header and the same (scope, key)
 * pair has been processed before, the cached response is returned and
 * the handler is not run. Otherwise the handler runs, and — if the
 * outcome was "stable" (a 2xx success or a 4xx validation rejection) —
 * the response is persisted.
 *
 * What we DO NOT persist:
 *   - 5xx: transient failures (DB blip, downstream timeout). Pinning
 *     them would force the caller to wait the TTL before retrying.
 *   - 401/403/429: auth/quota state can change between attempts.
 *
 * What we DO persist:
 *   - 2xx: the canonical success path.
 *   - 400/409/422: stable client-side rejections (bad body, conflict,
 *     unprocessable). Replaying the same key with the same body
 *     deserves the same answer.
 *
 * Concurrent requests with the same key both run exec(); whoever wins
 * the INSERT pins their response, the loser discards theirs and returns
 * the winner's row. This is acceptable for AITP CP semantics because
 * the keyed operations (agent register, revocation entry, webhook
 * create) are themselves idempotent on duplicate state.
 *
 * Rows are aged out by the retention sweep — there is no per-row TTL
 * here; staleness is bounded by `IDEMPOTENCY_KEY_TTL_DAYS`.
 */

import { and, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { db } from './db';
import { idempotencyKeys } from './db/schema';
import { logger } from './logger';

export interface IdempotentResult {
  status: number;
  body: unknown;
}

const HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 255;

// Stable-outcome status codes we persist.
const CACHEABLE_STATUSES = new Set<number>([
  200, 201, 202, 204,
  400, 409, 422,
]);

function isCacheable(status: number): boolean {
  return CACHEABLE_STATUSES.has(status);
}

/** JSONB round-trip normalization. Dates become ISO strings,
 * `undefined` keys disappear, `BigInt` throws — but if it throws we
 * skip caching this response rather than corrupting state. */
function normalizeBody(body: unknown): unknown | null {
  try {
    return JSON.parse(JSON.stringify(body));
  } catch {
    return null;
  }
}

function normalizeKey(raw: string): string | null {
  // Control chars check runs on the RAW input — `trim()` would strip
  // any leading/trailing control bytes and a key like '\n\nkey' would
  // sneak past the validator otherwise.
  if (/[\x00-\x1f]/.test(raw)) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_KEY_LENGTH) return null;
  return trimmed;
}

function makeResponse(
  status: number,
  body: unknown,
  replayed: boolean,
): Response {
  const r = Response.json(body, { status });
  if (replayed) r.headers.set('Idempotency-Replayed', 'true');
  return r;
}

export async function withIdempotency(
  req: NextRequest,
  scope: string,
  exec: () => Promise<IdempotentResult>,
): Promise<Response> {
  const raw = req.headers.get(HEADER);
  if (raw === null) {
    // Header absent — run the handler with no idempotency.
    const result = await exec();
    return makeResponse(result.status, result.body, false);
  }

  // Header present but possibly empty or malformed. We reject with 400
  // rather than silently ignoring — a client that sets the header
  // (even to ""), gets a clearer signal that the value is unusable.
  const key = normalizeKey(raw);
  if (!key) {
    return Response.json(
      {
        error:
          'invalid Idempotency-Key header (empty, too long, or contains control characters)',
        code: 'IDEMPOTENCY_KEY_INVALID',
      },
      { status: 400 },
    );
  }

  // Fast path: cache hit.
  const cached = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)),
    )
    .limit(1);
  if (cached[0]) {
    return makeResponse(
      cached[0].responseStatus,
      cached[0].responseBody,
      true,
    );
  }

  // Miss: run the handler.
  const result = await exec();

  // Only persist stable outcomes — transient 5xx / auth must be
  // retriable with a fresh attempt.
  if (!isCacheable(result.status)) {
    return makeResponse(result.status, result.body, false);
  }

  const normalizedBody = normalizeBody(result.body);
  if (normalizedBody === null) {
    // Body had something un-JSON-encodable (BigInt etc.). Don't cache,
    // but still return the original response — the caller already
    // observed exec()'s side effects.
    logger.warn(
      { scope, key },
      'idempotency response body is not JSON-encodable; skipping cache',
    );
    return makeResponse(result.status, result.body, false);
  }

  // Concurrent requests with the same key both run exec(); ON
  // CONFLICT DO NOTHING makes only one row win.
  try {
    await db
      .insert(idempotencyKeys)
      .values({
        scope,
        key,
        responseStatus: result.status,
        responseBody: normalizedBody as Record<string, unknown>,
      })
      .onConflictDoNothing();
  } catch (err) {
    logger.warn({ err, scope, key }, 'idempotency persist failed');
    return makeResponse(result.status, normalizedBody, false);
  }

  // Re-read to return the winning response (which may be ours, or a
  // racing peer's). Returning the JSONB-normalized form makes the first
  // attempt and the replay byte-identical.
  const winner = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)),
    )
    .limit(1);
  if (winner[0]) {
    const wonByUs =
      winner[0].responseStatus === result.status &&
      JSON.stringify(winner[0].responseBody) === JSON.stringify(normalizedBody);
    return makeResponse(
      winner[0].responseStatus,
      winner[0].responseBody,
      !wonByUs,
    );
  }
  return makeResponse(result.status, normalizedBody, false);
}
