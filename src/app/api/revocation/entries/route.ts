import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { revocationEntries } from '@/lib/db/schema';
import { revocationProducer } from '@/lib/revocation/producer';
import { writeAdminAudit } from '@/lib/audit-log/service';
import { eventBus, type AuditEventRecord } from '@/lib/audit/stream';
import { ingestOneEvent } from '@/lib/audit/event-store';
import { dispatchWebhooks } from '@/lib/webhooks/service';
import { logger } from '@/lib/logger';
import { withIdempotency } from '@/lib/idempotency';
import { tctMonitor } from '@/lib/tcts/monitor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The instants `revoked_at` can actually hold, as millisecond bounds.
 *
 * `revoked_at` is `timestamp with time zone` (drizzle/0000_init.sql:57) and what
 * this route sends it is `Date.prototype.toISOString()` output. Those two facts
 * together set the bound — NOT Postgres's own 4713 BC – 294276 AD span, which is
 * far wider. Outside years 0001-9999 `toISOString()` switches to the expanded-year
 * form (`+010000-01-01T00:00:00.000Z`, `-271821-04-20T00:00:00.000Z`) and Postgres
 * cannot parse that at all. Measured against a live server: years 0001 and 9999
 * are accepted at both extremes, one millisecond past either end is rejected —
 * `22009` for an expanded year, `22008` for year 0000 (Postgres has no year zero),
 * `22007` for a negative one.
 *
 * `new Date(...)` accepts every one of those happily — its own range runs to
 * ±275760 — so the `Number.isNaN` check below does NOT subsume this one. Without
 * this bound a caller can make Postgres do the rejecting, and a Postgres parse
 * error names the column's type.
 *
 * The bound is checked against the UTC instant rather than the written year, which
 * is what we want: `0001-01-01T00:00:00+01:00` is UTC year 0000 and is correctly
 * rejected even though its text reads 0001.
 *
 * This also covers the copy of this value that `ingestOneEvent` writes to
 * `audit_events.ts` further down — also a `timestamptz`, and with no guard of its
 * own.
 *
 * Computed from the boundary literals rather than written as numbers so constant
 * and comment cannot drift; entries.test.ts pins the numbers themselves.
 */
const MIN_REVOKED_AT_MS = Date.parse('0001-01-01T00:00:00.000Z'); // -62135596800000
const MAX_REVOKED_AT_MS = Date.parse('9999-12-31T23:59:59.999Z'); //  253402300799999

interface RequestBody {
  jti?: unknown;
  reason?: unknown;
  revokedAt?: unknown;
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return Response.json(
      { error: 'body must be JSON', code: 'BODY_INVALID' },
      { status: 400 },
    );
  }

  return withIdempotency(req, 'revocation.entries', async () => {
    if (typeof body.jti !== 'string' || !UUID_RE.test(body.jti)) {
      return { status: 400, body: { error: 'jti must be a UUID', code: 'JTI_INVALID' } };
    }

    if (body.reason !== undefined && body.reason !== null) {
      if (typeof body.reason !== 'string') {
        return {
          status: 400,
          body: { error: 'reason must be a string', code: 'BODY_INVALID' },
        };
      }
      if (body.reason.length > 500) {
        return {
          status: 400,
          body: {
            error: 'reason exceeds 500 character limit',
            code: 'BODY_INVALID',
          },
        };
      }
      // Postgres `text` cannot hold U+0000 — it rejects the byte outright with
      // `22021 invalid byte sequence for encoding "UTF8": 0x00` — and `jsonb`
      // rejects it too (`22P05`), which matters because `reason` is copied into
      // the event payload below and written to a jsonb column by
      // `ingestOneEvent`. Both of those would otherwise be a Postgres error
      // message on a path with no guard of its own.
      //
      // A caller really can get one this far: `JSON.parse` preserves the
      // `\u0000` ESCAPE. (A raw NUL byte is invalid JSON per RFC 8259 and is
      // already rejected by the parse at the top of this handler, so the escape
      // is the only reachable form.)
      //
      // Deliberately narrower than the `[\x00-\x1f]` check src/lib/idempotency.ts
      // applies to keys: `reason` is operator prose, where a newline or tab is
      // legitimate and stores fine. U+0000 is the only code point `text` cannot
      // store. A lone surrogate is also fine — Node's UTF-8 encoder substitutes
      // U+FFFD before Postgres ever sees it.
      if (body.reason.includes('\u0000')) {
        return {
          status: 400,
          body: {
            error: 'reason must not contain a NUL character',
            code: 'BODY_INVALID',
          },
        };
      }
    }
    const reason = typeof body.reason === 'string' ? body.reason : null;
    let revokedAt: string;
    if (typeof body.revokedAt === 'string') {
      const parsed = new Date(body.revokedAt);
      if (Number.isNaN(parsed.getTime())) {
        return {
          status: 400,
          body: {
            error: 'revokedAt must be a parseable date string (ISO-8601 recommended)',
            code: 'BODY_INVALID',
          },
        };
      }
      // Written as a negated conjunction, NOT as `ms < MIN || ms > MAX`. Both
      // bounds come from `Date.parse`, and if either were ever NaN then every
      // comparison against it is false — the disjunctive form would accept
      // *everything*, failing silently and completely open. This form rejects
      // everything instead, which is the safe direction for a guard whose whole
      // job is to keep a value away from the database.
      const ms = parsed.getTime();
      if (!(ms >= MIN_REVOKED_AT_MS && ms <= MAX_REVOKED_AT_MS)) {
        return {
          status: 400,
          body: {
            error: 'revokedAt must fall within years 0001-9999',
            code: 'BODY_INVALID',
          },
        };
      }
      revokedAt = parsed.toISOString();
    } else {
      revokedAt = new Date().toISOString();
    }

    // This catch OBSERVES and re-throws; it does not answer. It used to map any
    // throw to `500 INSERT_FAILED` with `err.message` in the body, which for a
    // `pg` DatabaseError is whatever Postgres said — and Postgres names tables,
    // columns, constraints and types. That was issue #98, and it was the last of
    // the three undiscriminated catch-alls tracked in
    // src/app/api/registry/enroll/route.ts.
    //
    // Three things could reach here, and only one of them still can:
    //
    //   1. `revokedAt` outside what `timestamptz` can parse from an ISO string.
    //   2. `reason` containing U+0000, which neither `text` nor `jsonb` accepts.
    //   3. A genuine server fault — connection refused, pool timeout, migrations
    //      not applied (42P01, whose message names the table), permissions, disk.
    //
    // (1) and (2) are the CALLER's fault, and both are properties of the request
    // body, so they are now decided before any SQL runs, by MIN/MAX_REVOKED_AT_MS
    // and the NUL check above. That is the whole reason this catch can be this
    // blunt: it is not that a database error is safe to expose, it is that no
    // database error reachable here is the caller's to see. If a future unique
    // constraint, CHECK, or trigger makes a caller-caused SQLSTATE reachable
    // again, it gets a guard above or an explicitly discriminated branch (as
    // trust-anchors/route.ts does for 23505, the one case that genuinely cannot
    // be hoisted without a race) — never a resurrected catch-all.
    //
    // So (3) is all that is left, and re-throwing is the repo's idiom for it
    // (enroll/route.ts, webhooks/route.ts, events/route.ts,
    // events/history/route.ts all do this). The re-throw is what keeps internal
    // detail out of the body BY CONSTRUCTION rather than by remembering to
    // redact: a function that throws has no response body to leak into.
    //
    // The log is the one thing that must not be dropped along with the old body.
    // Nothing else records this failure — src/instrumentation.ts registers no
    // `onRequestError`, so without this line a database outage on the revocation
    // path reaches operators only as Next's default `console.error`, outside pino
    // and without the request-id correlation docs/api.md promises. Binding `err`
    // here is safe in a way it was not before, because the next statement throws
    // instead of returning. Field set matches the `logger.warn` twenty lines
    // below. Not try-guarded, unlike enroll's `recordFailure`: that guards
    // instrumentation because a fault there would turn a clean 400 into a 500,
    // whereas this path is already a 500 and a logger fault cannot change that.
    try {
      await db
        .insert(revocationEntries)
        .values({
          jti: body.jti,
          revokedAt,
          reason,
        })
        .onConflictDoNothing();
    } catch (err) {
      logger.error({ err, jti: body.jti }, 'revocation entry insert failed');
      throw err;
    }

    revocationProducer.invalidate();

    const event: AuditEventRecord = {
      id: randomUUID(),
      type: 'tct.revoked',
      ts: revokedAt,
      payload: { jti: body.jti, reason },
      source: 'cp',
    };
    await ingestOneEvent(event);
    eventBus.publish(event);
    await tctMonitor.onEvent(event);
    void dispatchWebhooks(event).catch((err) =>
      logger.warn({ err, jti: body.jti }, 'tct.revoked webhook dispatch failed'),
    );
    await writeAdminAudit({
      action: 'revocation.add',
      targetId: body.jti as string,
      details: { reason },
      requestId: req.headers.get('x-request-id') ?? undefined,
    });

    return {
      status: 201,
      body: { jti: body.jti, revokedAt, reason },
    };
  });
}
