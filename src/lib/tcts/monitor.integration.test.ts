/**
 * Integration: TCT/delegation revocation cascade.
 *
 * The recursive-CTE cascade and the parent row update must commit
 * atomically — a half-applied state would make active-chain queries
 * lie (parent revoked but children still marked active, or vice
 * versa). This test seeds a 3-level chain, fires a revocation event,
 * and asserts the descendants are all marked revoked.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { db, pool } from '@/lib/db';
import { delegations, issuedTcts } from '@/lib/db/schema';
import { tctMonitor } from '@/lib/tcts/monitor';
import type { AuditEventRecord } from '@/lib/audit/stream';

interface ChainIds {
  root: string;
  child: string;
  grandchild: string;
}

async function seedChain(): Promise<ChainIds> {
  const root = randomUUID();
  const child = randomUUID();
  const grandchild = randomUUID();
  const now = new Date().toISOString();
  await db.insert(issuedTcts).values({
    jti: root,
    issuerAid: 'aid:test:issuer',
    subjectAid: 'aid:test:subject',
    audienceAid: 'aid:test:audience',
    grants: ['demo.echo'],
    issuedAt: now,
  });
  await db.insert(delegations).values([
    {
      jti: child,
      parentJti: root,
      delegatorAid: 'aid:test:subject',
      delegateeAid: 'aid:test:child',
      scope: ['demo.echo'],
      issuedAt: now,
    },
    {
      jti: grandchild,
      parentJti: child,
      delegatorAid: 'aid:test:child',
      delegateeAid: 'aid:test:grandchild',
      scope: ['demo.echo'],
      issuedAt: now,
    },
  ]);
  return { root, child, grandchild };
}

async function cleanup(ids: ChainIds): Promise<void> {
  await db.delete(delegations).where(
    sql`${delegations.jti} in (${ids.child}, ${ids.grandchild})`,
  );
  await db.delete(issuedTcts).where(sql`${issuedTcts.jti} = ${ids.root}`);
}

describe('integration: tctMonitor revocation cascade', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('tct.revoked: marks TCT and entire descendant tree as revoked', async () => {
    const ids = await seedChain();
    try {
      const event: AuditEventRecord = {
        id: randomUUID(),
        type: 'tct.revoked',
        ts: new Date().toISOString(),
        payload: { jti: ids.root },
      };
      await tctMonitor.onEvent(event);

      const tct = await db.execute(
        sql`select revoked, revoked_at from issued_tcts where jti = ${ids.root}`,
      );
      // drizzle's execute returns { rows: ... } for pg-node.
      const tctRows = (tct as unknown as { rows: { revoked: boolean }[] }).rows;
      expect(tctRows[0]?.revoked).toBe(true);

      const dl = await db.execute(
        sql`select jti, revoked, revoked_reason from delegations where jti in (${ids.child}, ${ids.grandchild})`,
      );
      const dlRows = (dl as unknown as {
        rows: { jti: string; revoked: boolean; revoked_reason: string | null }[];
      }).rows;
      expect(dlRows).toHaveLength(2);
      for (const r of dlRows) {
        expect(r.revoked).toBe(true);
        expect(r.revoked_reason).toBe('parent_revoked');
      }
    } finally {
      await cleanup(ids);
    }
  });

  it('delegation.revoked on the middle node cascades to grandchildren only', async () => {
    const ids = await seedChain();
    try {
      const event: AuditEventRecord = {
        id: randomUUID(),
        type: 'delegation.revoked',
        ts: new Date().toISOString(),
        payload: { jti: ids.child },
      };
      await tctMonitor.onEvent(event);

      const dl = await db.execute(
        sql`select jti, revoked, revoked_reason from delegations where jti in (${ids.child}, ${ids.grandchild})`,
      );
      const dlRows = (dl as unknown as {
        rows: { jti: string; revoked: boolean; revoked_reason: string | null }[];
      }).rows;
      const child = dlRows.find((r) => r.jti === ids.child);
      const grand = dlRows.find((r) => r.jti === ids.grandchild);
      expect(child?.revoked).toBe(true);
      expect(child?.revoked_reason).toBe('explicit');
      expect(grand?.revoked).toBe(true);
      expect(grand?.revoked_reason).toBe('parent_revoked');

      // The root TCT must NOT have been touched.
      const tct = await db.execute(
        sql`select revoked from issued_tcts where jti = ${ids.root}`,
      );
      const tctRows = (tct as unknown as { rows: { revoked: boolean }[] }).rows;
      expect(tctRows[0]?.revoked).toBe(false);
    } finally {
      await cleanup(ids);
    }
  });

  it('tct.issued (v0.2 { token, claims }): projects decoded claims into issued_tcts', async () => {
    const jti = randomUUID();
    try {
      await tctMonitor.onEvent({
        id: randomUUID(),
        type: 'tct.issued',
        ts: new Date().toISOString(),
        sessionId: 'sess-v2',
        payload: {
          tct: {
            token: 'eyJhbGciOiJFZERTQSIsInR5cCI6ImFpdHAtdGN0K2p3dCJ9.eyJ9.sig',
            claims: {
              ver: 'aitp/0.2',
              jti,
              iss: 'aid:test:issuer',
              sub: 'aid:test:subject',
              aud: 'aid:test:subject',
              grants: ['demo.echo'],
              iat: 1_750_000_000,
              exp: 1_750_003_600,
              cnf: { jkt: 'thumbprint-abc' },
            },
          },
        },
      });

      const res = await db.execute(
        sql`select issuer_aid, subject_aid, audience_aid, binding_cnf, session_id
            from issued_tcts where jti = ${jti}`,
      );
      const rows = (res as unknown as {
        rows: {
          issuer_aid: string;
          subject_aid: string;
          audience_aid: string;
          binding_cnf: string | null;
          session_id: string | null;
        }[];
      }).rows;
      expect(rows[0]).toMatchObject({
        issuer_aid: 'aid:test:issuer',
        subject_aid: 'aid:test:subject',
        audience_aid: 'aid:test:subject',
        binding_cnf: 'thumbprint-abc',
        session_id: 'sess-v2',
      });
    } finally {
      await db.delete(issuedTcts).where(sql`${issuedTcts.jti} = ${jti}`);
    }
  });

  it('delegation.issued (v0.2): parent_jti sourced from src_jti claim', async () => {
    const parent = randomUUID();
    const child = randomUUID();
    const now = new Date().toISOString();
    try {
      await db.insert(issuedTcts).values({
        jti: parent,
        issuerAid: 'aid:test:issuer',
        subjectAid: 'aid:test:delegator',
        audienceAid: 'aid:test:delegator',
        grants: ['demo.echo'],
        issuedAt: now,
      });
      await tctMonitor.onEvent({
        id: randomUUID(),
        type: 'delegation.issued',
        ts: now,
        payload: {
          tct: {
            token: 'eyJ...del',
            claims: {
              jti: child,
              src_jti: parent,
              iss: 'aid:test:delegator',
              sub: 'aid:test:delegatee',
              aud: 'aid:test:issuer',
              scope: ['demo.echo'],
              exp: 1_750_003_600,
            },
          },
        },
      });

      const res = await db.execute(
        sql`select parent_jti, delegator_aid, delegatee_aid from delegations where jti = ${child}`,
      );
      const rows = (res as unknown as {
        rows: { parent_jti: string; delegator_aid: string; delegatee_aid: string }[];
      }).rows;
      expect(rows[0]).toMatchObject({
        parent_jti: parent,
        delegator_aid: 'aid:test:delegator',
        delegatee_aid: 'aid:test:delegatee',
      });
    } finally {
      await db.delete(delegations).where(sql`${delegations.jti} = ${child}`);
      await db.delete(issuedTcts).where(sql`${issuedTcts.jti} = ${parent}`);
    }
  });

  it('rejects payloads with a malformed jti without touching the DB', async () => {
    const ids = await seedChain();
    try {
      await tctMonitor.onEvent({
        id: randomUUID(),
        type: 'tct.revoked',
        ts: new Date().toISOString(),
        payload: { jti: 'not-a-uuid' },
      });
      const tct = await db.execute(
        sql`select revoked from issued_tcts where jti = ${ids.root}`,
      );
      const tctRows = (tct as unknown as { rows: { revoked: boolean }[] }).rows;
      expect(tctRows[0]?.revoked).toBe(false);
    } finally {
      await cleanup(ids);
    }
  });
});
