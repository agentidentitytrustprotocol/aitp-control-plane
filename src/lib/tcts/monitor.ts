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
 *
 * v0.2 (JWS TCT migration): TCTs and delegations are now compact-JWS
 * tokens. The telemetry contract carries the *decoded claims* alongside
 * the opaque token — `payload.tct = { token, claims }` — so the CP keeps
 * ingesting decomposed fields without ever JOSE-parsing a token it does
 * not verify. Claims use JWT names (`iss/sub/aud/iat/exp`, `cnf.jkt`);
 * the parsers below accept those alongside the v0.1 names so a staged
 * rollout (mixed SDK versions reporting) projects cleanly. The opaque
 * `token` is intentionally discarded — `jti` is all revocation needs.
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

function readStringArray(o: Record<string, unknown>, ...keys: string[]): string[] {
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v) && v.every((s) => typeof s === 'string')) return v as string[];
  }
  return [];
}

function readNumber(o: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function epochToIso(secs: number | undefined): string | undefined {
  if (secs === undefined) return undefined;
  return new Date(secs * 1000).toISOString();
}

/**
 * The key-binding confirmation, as stored in `issued_tcts.binding_cnf`.
 *
 * - v0.2: `cnf` is an object `{ jkt }` (RFC 7638 JWK thumbprint of the
 *   subject's key). We store the thumbprint scalar.
 * - v0.1: the binding lived under `binding.cnf` as a raw pubkey string.
 *
 * Both reduce to an opaque scalar in the same column — no migration is
 * needed, the *content* just changes from a pubkey to a thumbprint.
 */
function readCnf(claims: Record<string, unknown>): string | undefined {
  const cnf = claims.cnf;
  if (typeof cnf === 'object' && cnf !== null) {
    const jkt = (cnf as Record<string, unknown>).jkt;
    if (typeof jkt === 'string' && jkt.length > 0) return jkt;
  }
  // A flattened or legacy top-level scalar `cnf`.
  if (typeof cnf === 'string' && cnf.length > 0) return cnf;
  // v0.1: `binding.cnf`.
  const binding = claims.binding;
  if (typeof binding === 'object' && binding !== null) {
    const bc = (binding as Record<string, unknown>).cnf;
    if (typeof bc === 'string' && bc.length > 0) return bc;
  }
  return undefined;
}

/**
 * Unwrap a telemetry artifact to its claims bag. v0.2 wraps the token as
 * `{ token, claims }`; v0.1 emitted a flat object. The opaque compact
 * token (if present) is dropped — the CP records claims, never the JWS.
 */
function claimsOf(raw: Record<string, unknown>): Record<string, unknown> {
  const claims = raw.claims;
  if (typeof claims === 'object' && claims !== null) {
    return claims as Record<string, unknown>;
  }
  return raw;
}

/** Field projection of one TCT, ready for `issued_tcts`. */
export interface ParsedTct {
  jti: string;
  issuerAid: string;
  subjectAid: string;
  audienceAid: string;
  grants: string[];
  bindingCnf: string | null;
  issuedAt: string;
  expiresAt: string | null;
}

/**
 * Project a single reported TCT (v0.1 flat object or v0.2
 * `{ token, claims }`) into column values, or `null` if it lacks the
 * minimum identifying fields (`jti`, `iss`, `sub`). Pure — no DB.
 */
export function parseTct(raw: unknown, fallbackTs: string): ParsedTct | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const claims = claimsOf(raw as Record<string, unknown>);

  const jti = readString(claims, 'jti');
  const issuer = readString(claims, 'iss', 'issuer', 'issuer_aid', 'issuerAid');
  const subject = readString(claims, 'sub', 'subject', 'subject_aid', 'subjectAid');
  const audience = readString(claims, 'aud', 'audience', 'audience_aid', 'audienceAid');
  if (!jti || !UUID_RE.test(jti) || !issuer || !subject) return null;

  return {
    jti,
    issuerAid: issuer,
    subjectAid: subject,
    audienceAid: audience ?? subject,
    grants: readStringArray(claims, 'grants'),
    bindingCnf: readCnf(claims) ?? null,
    issuedAt: epochToIso(readNumber(claims, 'iat', 'issued_at')) ?? fallbackTs,
    expiresAt: epochToIso(readNumber(claims, 'exp', 'expires_at')) ?? null,
  };
}

/** Field projection of one delegation, ready for `delegations`. */
export interface ParsedDelegation {
  jti: string;
  parentJti: string;
  delegatorAid: string;
  delegateeAid: string;
  scope: string[];
  issuedAt: string;
  expiresAt: string | null;
}

/**
 * Project a `delegation.issued` payload into column values, or `null`
 * if it lacks `jti`/`parent` identifiers. v0.2 may wrap the delegation
 * claims under `payload.tct`/`payload.delegation` (`{ token, claims }`)
 * or carry them flat. The parent reference is the grant voucher's
 * `src_jti` claim in v0.2 (replacing v0.1's `parent_jti`); delegator and
 * delegatee fall back to the `iss`/`sub` JWT claims. Pure — no DB.
 */
export function parseDelegation(
  payload: Record<string, unknown>,
  fallbackTs: string,
): ParsedDelegation | null {
  const wrapper = payload.tct ?? payload.delegation;
  const claims =
    wrapper && typeof wrapper === 'object'
      ? claimsOf(wrapper as Record<string, unknown>)
      : claimsOf(payload);

  const jti = readString(claims, 'jti', 'child_jti');
  const parentJti = readString(claims, 'src_jti', 'parent_jti', 'parentJti');
  const delegator = readString(claims, 'delegator', 'delegator_aid', 'iss');
  const delegatee = readString(claims, 'delegatee', 'delegatee_aid', 'sub');
  if (!jti || !UUID_RE.test(jti) || !parentJti || !UUID_RE.test(parentJti)) return null;
  if (!delegator || !delegatee) return null;

  return {
    jti,
    parentJti,
    delegatorAid: delegator,
    delegateeAid: delegatee,
    scope: readStringArray(claims, 'scope', 'grants'),
    issuedAt: epochToIso(readNumber(claims, 'iat', 'issued_at')) ?? fallbackTs,
    expiresAt: epochToIso(readNumber(claims, 'exp', 'expires_at')) ?? null,
  };
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
   * either a single TCT under `tct` or an array under `tcts`; each entry
   * is a v0.1 flat object or a v0.2 `{ token, claims }` envelope. */
  private async recordIssuedTcts(event: AuditEventRecord): Promise<void> {
    const payload = event.payload;
    const tctList: unknown[] = Array.isArray(payload.tcts)
      ? payload.tcts
      : payload.tct
        ? [payload.tct]
        : [];
    if (tctList.length === 0) return;

    for (const raw of tctList) {
      const tct = parseTct(raw, event.ts);
      if (!tct) continue;

      await db
        .insert(issuedTcts)
        .values({
          ...tct,
          sessionId: event.sessionId ?? null,
        })
        .onConflictDoNothing();
    }
  }

  private async recordRevocation(event: AuditEventRecord): Promise<void> {
    const jti = readString(event.payload, 'jti');
    if (!jti || !UUID_RE.test(jti)) return;
    const revokedAt = event.ts;
    // Atomic: TCT row update + descendant cascade must commit together so
    // active-chain queries never observe a half-applied revocation.
    await db.transaction(async (tx) => {
      await tx
        .update(issuedTcts)
        .set({ revoked: true, revokedAt })
        .where(and(eq(issuedTcts.jti, jti), eq(issuedTcts.revoked, false)));

      await tx.execute(sql`
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
    });
  }

  private async recordDelegation(event: AuditEventRecord): Promise<void> {
    const delegation = parseDelegation(event.payload, event.ts);
    if (!delegation) return;

    await db.insert(delegations).values(delegation).onConflictDoNothing();
  }

  private async recordDelegationRevocation(event: AuditEventRecord): Promise<void> {
    const jti = readString(event.payload, 'jti');
    if (!jti || !UUID_RE.test(jti)) return;
    const revokedAt = event.ts;

    // Atomic: explicit revocation + descendant cascade must commit
    // together so active-chain queries never observe a partial state.
    await db.transaction(async (tx) => {
      await tx
        .update(delegations)
        .set({ revoked: true, revokedAt, revokedReason: 'explicit' })
        .where(and(eq(delegations.jti, jti), eq(delegations.revoked, false)));

      await tx.execute(sql`
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
    });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __tctMonitor: TctMonitorService | undefined;
}

export const tctMonitor =
  globalThis.__tctMonitor ??
  (globalThis.__tctMonitor = new TctMonitorService());
