/**
 * Observes audit events and projects them onto the issued_tcts and
 * delegations tables. The CP never participates in issuance — these
 * are the *records of* TCTs and delegations that agents issued to
 * each other, derived from `tct.issued`, `tct.revoked`, and
 * `delegation.issued` events they reported.
 *
 * Tolerant of partial payloads: any required field missing is silently
 * skipped, since events come from heterogeneous agents on different
 * SDK versions. The CP's job is to record what's reported, not to
 * police it.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { delegations, issuedTcts } from '../db/schema';
import type { AuditEventRecord } from '../audit/stream';
import { logger } from '../logger';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readString(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function readStringArray(o: Record<string, unknown>, key: string): string[] {
  const v = o[key];
  if (Array.isArray(v) && v.every((s) => typeof s === 'string')) return v as string[];
  return [];
}

function readNumber(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

function epochToIso(secs: number | undefined): string | undefined {
  if (secs === undefined) return undefined;
  return new Date(secs * 1000).toISOString();
}

class TctMonitorService {
  async onEvent(event: AuditEventRecord): Promise<void> {
    try {
      switch (event.type) {
        case 'tct.issued':
        case 'handshake.complete':
          await this.recordIssuedTcts(event);
          break;
        case 'tct.revoked':
          await this.recordRevocation(event);
          break;
        case 'delegation.issued':
          await this.recordDelegation(event);
          break;
        case 'delegation.revoked':
          await this.recordDelegationRevocation(event);
          break;
      }
    } catch (err) {
      logger.warn(
        { err, type: event.type },
        'tct-monitor failed to project event',
      );
    }
  }

  /** Both `tct.issued` (singular) and `handshake.complete` (array of
   * two TCTs, one per direction) are accepted. The payload may carry
   * either a single TCT under `tct` or an array under `tcts`. */
  private async recordIssuedTcts(event: AuditEventRecord): Promise<void> {
    const payload = event.payload;
    const tctList: unknown[] = Array.isArray(payload.tcts)
      ? payload.tcts
      : payload.tct
        ? [payload.tct]
        : [];
    if (tctList.length === 0) return;

    for (const raw of tctList) {
      if (typeof raw !== 'object' || raw === null) continue;
      const t = raw as Record<string, unknown>;
      const jti = readString(t, 'jti');
      const issuer = readString(t, 'issuer', 'issuer_aid', 'issuerAid');
      const subject = readString(t, 'subject', 'subject_aid', 'subjectAid');
      const audience = readString(t, 'audience', 'audience_aid', 'audienceAid');
      if (!jti || !UUID_RE.test(jti) || !issuer || !subject) continue;

      const grants = readStringArray(t, 'grants');
      const issuedAt = epochToIso(readNumber(t, 'issued_at')) ?? event.ts;
      const expiresAt = epochToIso(readNumber(t, 'expires_at'));
      const cnf =
        typeof (t.binding as { cnf?: unknown })?.cnf === 'string'
          ? ((t.binding as { cnf: string }).cnf)
          : readString(t, 'cnf');

      await db
        .insert(issuedTcts)
        .values({
          jti,
          issuerAid: issuer,
          subjectAid: subject,
          audienceAid: audience ?? subject,
          grants,
          bindingCnf: cnf ?? null,
          issuedAt,
          expiresAt: expiresAt ?? null,
          sessionId: event.sessionId ?? null,
        })
        .onConflictDoNothing();
    }
  }

  private async recordRevocation(event: AuditEventRecord): Promise<void> {
    const jti = readString(event.payload, 'jti');
    if (!jti || !UUID_RE.test(jti)) return;
    const revokedAt = event.ts;
    // Mark the issued TCT itself revoked (if present)
    await db
      .update(issuedTcts)
      .set({ revoked: true, revokedAt })
      .where(and(eq(issuedTcts.jti, jti), eq(issuedTcts.revoked, false)));

    // Cascade to any child delegations whose chain anchors on this JTI.
    await db.execute(sql`
      update ${delegations}
      set revoked = true,
          revoked_at = ${revokedAt},
          revoked_reason = 'parent_revoked'
      where revoked = false
        and jti in (
          with recursive descendants(jti) as (
            select jti from ${delegations} where parent_jti = ${jti}
            union
            select d.jti from ${delegations} d
            join descendants on d.parent_jti = descendants.jti
          )
          select jti from descendants
        )
    `);
  }

  private async recordDelegation(event: AuditEventRecord): Promise<void> {
    const p = event.payload;
    const jti = readString(p, 'jti', 'child_jti');
    const parentJti = readString(p, 'parent_jti', 'parentJti');
    const delegator = readString(p, 'delegator', 'delegator_aid');
    const delegatee = readString(p, 'delegatee', 'delegatee_aid');
    if (!jti || !UUID_RE.test(jti) || !parentJti || !UUID_RE.test(parentJti)) return;
    if (!delegator || !delegatee) return;
    const scope = readStringArray(p, 'scope');
    const issuedAt = epochToIso(readNumber(p, 'issued_at')) ?? event.ts;
    const expiresAt = epochToIso(readNumber(p, 'expires_at'));

    await db
      .insert(delegations)
      .values({
        jti,
        parentJti,
        delegatorAid: delegator,
        delegateeAid: delegatee,
        scope,
        issuedAt,
        expiresAt: expiresAt ?? null,
      })
      .onConflictDoNothing();
  }

  private async recordDelegationRevocation(event: AuditEventRecord): Promise<void> {
    const jti = readString(event.payload, 'jti');
    if (!jti || !UUID_RE.test(jti)) return;
    const revokedAt = event.ts;

    // Mark the named delegation revoked.
    await db
      .update(delegations)
      .set({ revoked: true, revokedAt, revokedReason: 'explicit' })
      .where(and(eq(delegations.jti, jti), eq(delegations.revoked, false)));

    // Cascade to any descendants in the delegation tree. Same recursive
    // CTE as `recordRevocation` — revoking an intermediate delegation
    // must propagate downward, otherwise active-chain queries lie.
    await db.execute(sql`
      update ${delegations}
      set revoked = true,
          revoked_at = ${revokedAt},
          revoked_reason = 'parent_revoked'
      where revoked = false
        and jti in (
          with recursive descendants(jti) as (
            select jti from ${delegations} where parent_jti = ${jti}
            union
            select d.jti from ${delegations} d
            join descendants on d.parent_jti = descendants.jti
          )
          select jti from descendants
        )
    `);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __tctMonitor: TctMonitorService | undefined;
}

export const tctMonitor =
  globalThis.__tctMonitor ??
  (globalThis.__tctMonitor = new TctMonitorService());
