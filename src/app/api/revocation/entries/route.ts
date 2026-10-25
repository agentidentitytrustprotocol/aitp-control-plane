import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { eq, isNull } from 'drizzle-orm';
import { issuedTcts, revocationEntries } from '@/lib/db/schema';
import { AID_RE } from '@/lib/api-keys';
import { writeAdminAudit } from '@/lib/audit-log/service';
import { auditContext } from '@/lib/audit-log/actor';
import { eventBus, type AuditEventRecord } from '@/lib/audit/stream';
import { ingestOneEvent } from '@/lib/audit/event-store';
import { dispatchWebhooks } from '@/lib/webhooks/service';
import { logger } from '@/lib/logger';
import { withIdempotency } from '@/lib/idempotency';
import { tctMonitor } from '@/lib/tcts/monitor';
import { JTI_V4_RE, readJsonObject } from '@/lib/http/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The instants a revocation may be dated, as millisecond bounds.
 *
 * The UPPER bound is what the database can hold. `revoked_at` is
 * `timestamp with time zone` (drizzle/0000_init.sql:57) and what this route sends
 * it is `Date.prototype.toISOString()` output; past year 9999 that switches to the
 * expanded-year form (`+010000-01-01T00:00:00.000Z`) which Postgres cannot parse
 * at all. Measured against a live server: `9999-12-31T23:59:59.999Z` is accepted
 * and one millisecond later is `22009`. Note this is far NARROWER than Postgres's
 * own 294276 AD ceiling — the constraint is our serialization, not the column.
 *
 * The LOWER bound is what the PUBLISHED LIST can carry, which binds tighter than
 * the column does. Postgres stores year 0001 happily, but the relay
 * (`GET /api/revocations`) hands each entry to its issuer with `revoked_at` as
 * seconds since the Unix epoch, which is what the issuer then signs
 * (RFC-AITP-0008). The epoch floor is the domain rule: a revocation cannot
 * predate the epoch its own published representation counts from.
 *
 * `new Date(...)` accepts everything outside both bounds happily — its own range
 * runs to ±275760 — so the `Number.isNaN` check below does NOT subsume this one.
 *
 * Checked against the UTC instant rather than the written year, which is what we
 * want: `9999-12-31T23:59:59.999-01:00` is UTC year 10000 and is correctly
 * rejected even though its text reads 9999.
 *
 * The upper bound also covers the copy of this value that `ingestOneEvent` writes
 * to `audit_events.ts` further down — also a `timestamptz`, with no guard of its
 * own.
 *
 * Computed from the boundary literals rather than written as numbers so constant
 * and comment cannot drift; entries.test.ts pins both bounds behaviourally, by
 * asserting the millisecond either side of each.
 */
const MIN_REVOKED_AT_MS = Date.parse('1970-01-01T00:00:00.000Z'); //               0
const MAX_REVOKED_AT_MS = Date.parse('9999-12-31T23:59:59.999Z'); // 253402300799999

interface RequestBody {
  jti?: unknown;
  reason?: unknown;
  revokedAt?: unknown;
  iss?: unknown;
}

export async function POST(req: NextRequest) {
  // Non-JSON and non-object bodies (incl. `null`, which used to throw on
  // `body.jti` and answer 500) are rejected before the idempotency layer.
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as RequestBody;

  return withIdempotency(req, 'revocation.entries', async () => {
    if (typeof body.jti !== 'string' || !JTI_V4_RE.test(body.jti)) {
      return { status: 400, body: { error: 'jti must be a lowercase UUID v4', code: 'JTI_INVALID' } };
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
    if (body.iss !== undefined && body.iss !== null) {
      if (typeof body.iss !== 'string' || !AID_RE.test(body.iss)) {
        return {
          status: 400,
          body: { error: 'iss must be an issuer AID (aid:...)', code: 'ISS_INVALID' },
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
            error:
              'revokedAt must be between 1970-01-01T00:00:00.000Z and 9999-12-31T23:59:59.999Z',
            code: 'BODY_INVALID',
          },
        };
      }
      revokedAt = parsed.toISOString();
    } else {
      revokedAt = new Date().toISOString();
    }

    // Who the entry is relayed to (RFC-AITP-0008 §1.5: only the TCT's issuer
    // can publish its revocation). Already known, in order: the CP's TCT
    // projection, then an existing entry for this jti. An explicit `iss` is
    // needed only when neither knows, and must agree when one does. An entry
    // with no issuer would be stored and enforced nowhere, so it is refused.
    // Re-posting with `iss` is also how an operator attributes a row that
    // migration 0009 could not (the upsert below fills a NULL `iss` only).
    const [tct] = await db
      .select({ iss: issuedTcts.issuerAid })
      .from(issuedTcts)
      .where(eq(issuedTcts.jti, body.jti));
    const [existing] = await db
      .select({ iss: revocationEntries.iss })
      .from(revocationEntries)
      .where(eq(revocationEntries.jti, body.jti));
    // A projected issuer that is not an AID (an unverified `tct.issued` report)
    // could never be pulled, so it counts as unknown.
    const projectedIss = tct?.iss && AID_RE.test(tct.iss) ? tct.iss : null;
    const storedIss = existing?.iss ?? null;
    // The stored entry is what the relay serves, and the upsert never changes
    // it, so a projection that disagrees must surface rather than be echoed.
    if (projectedIss !== null && storedIss !== null && projectedIss !== storedIss) {
      return {
        status: 409,
        body: {
          error: 'the stored entry names a different issuer than the TCT recorded for this jti',
          code: 'ISS_MISMATCH',
        },
      };
    }
    const knownIss = projectedIss ?? storedIss;
    const givenIss = typeof body.iss === 'string' ? body.iss : null;
    if (knownIss !== null && givenIss !== null && knownIss !== givenIss) {
      return {
        status: 409,
        body: {
          error: 'iss does not match the issuer recorded for this jti',
          code: 'ISS_MISMATCH',
        },
      };
    }
    const iss = knownIss ?? givenIss;
    if (iss === null) {
      return {
        status: 400,
        body: {
          error: 'iss is required: the CP has no TCT recorded for this jti',
          code: 'ISS_REQUIRED',
        },
      };
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
    // This line is kept even though src/instrumentation.ts now exports
    // `onRequestError`: the hook logs the fault with the request id, but only
    // this call knows the `jti`, which is what an operator needs to find the
    // row. The fault is therefore logged twice, deliberately. Binding `err`
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
          iss,
        })
        .onConflictDoUpdate({
          target: revocationEntries.jti,
          set: { iss },
          where: isNull(revocationEntries.iss),
        });
    } catch (err) {
      logger.error({ err, jti: body.jti }, 'revocation entry insert failed');
      throw err;
    }

    const event: AuditEventRecord = {
      id: randomUUID(),
      type: 'tct.revoked',
      ts: revokedAt,
      payload: { jti: body.jti, reason, iss },
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
      details: { reason, iss },
      ...auditContext(req),
    });

    return {
      status: 201,
      body: { jti: body.jti, revokedAt, reason, iss },
    };
  });
}
