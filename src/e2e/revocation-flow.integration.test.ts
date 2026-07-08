/**
 * Integration: revocation end-to-end flow against a real Postgres and
 * the real AITP Rust binding.
 *
 * Verifies:
 *   - POST /api/revocation/entries persists an entry and the signed
 *     list served by /.well-known/aitp-revocation-list reflects it
 *     (structure: version, issuer, published_at/expires_at, entries)
 *   - the envelope's Ed25519 signature verifies over
 *     sha256(JCS({"revocation_list": ...})) under the public key
 *     embedded in the issuer AID (and the issuer matches the AID
 *     derived from CP_AID_SEED_HEX when that env var is set)
 *   - posting a second entry invalidates the producer's 60s cache so
 *     the next GET re-signs and includes it
 *   - re-posting the same JTI is idempotent (single entry in the list)
 *   - invalid bodies are rejected (non-UUID jti, oversize reason)
 *   - the tct.revoked event emitted by the route cascades through the
 *     delegation projection: a chain seeded via POST /api/events
 *     (tct.issued + delegation.issued) is marked revoked and
 *     GET /api/delegations reflects it (tree query + active filter)
 *
 * Cleanup is targeted by the run-unique JTIs/run id so the suite is
 * order-independent and re-runnable.
 */

import { AitpAgent } from 'aitp';
import { NextRequest } from 'next/server';
import { createHash, createPublicKey, randomUUID, verify as edVerify } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { POST as revocationPost } from '@/app/api/revocation/entries/route';
import { GET as revocationListGet } from '@/app/api/well-known/aitp-revocation-list/route';
import { POST as eventsPost } from '@/app/api/events/route';
import { GET as delegationsGet } from '@/app/api/delegations/route';

import { db, pool } from '@/lib/db';
import {
  adminAuditLog,
  auditEvents,
  delegations,
  issuedTcts,
  revocationEntries,
} from '@/lib/db/schema';

function mkReq(
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(url, {
    method: init.method,
    body: init.body,
    headers: init.headers,
  });
}

async function postRevocation(body: unknown): Promise<Response> {
  return revocationPost(
    mkReq('http://localhost/api/revocation/entries', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

interface RevocationEnvelope {
  revocation_list: {
    version: string;
    issuer: string;
    published_at: number;
    expires_at: number;
    entries: { jti: string; revoked_at: number; reason?: string }[];
  };
  signature: string;
}

async function fetchList(): Promise<RevocationEnvelope> {
  const res = await revocationListGet();
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json');
  return (await res.json()) as RevocationEnvelope;
}

/** RFC 8785 (JCS) canonicalization — sufficient for this envelope: all
 * values are ASCII strings, integers, arrays, and objects. */
function jcs(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Verify the envelope signature: Ed25519 over
 * sha256(JCS({"revocation_list": ...})), public key taken from the
 * base64url segment of the `aid:pubkey:<b64url>` issuer AID. */
function verifyEnvelopeSignature(env: RevocationEnvelope): boolean {
  const rawKey = Buffer.from(env.revocation_list.issuer.split(':').pop()!, 'base64url');
  // Ed25519 SubjectPublicKeyInfo DER prefix + 32 raw key bytes.
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    rawKey,
  ]);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const digest = createHash('sha256')
    .update(Buffer.from(jcs({ revocation_list: env.revocation_list })))
    .digest();
  return edVerify(null, digest, key, Buffer.from(env.signature, 'base64url'));
}

const RUN_ID = `rev-flow-${randomUUID()}`;

const jti1 = randomUUID();
const jti2 = randomUUID();
const parentTctJti = randomUUID();
const childDelegationJti = randomUUID();
const grandchildDelegationJti = randomUUID();

const issuerAid = `aid:test:rev-issuer-${RUN_ID}`;
const delegatorAid = `aid:test:rev-delegator-${RUN_ID}`;
const delegateeAid = `aid:test:rev-delegatee-${RUN_ID}`;
const grandDelegateeAid = `aid:test:rev-grand-${RUN_ID}`;

describe('integration: revocation entry → signed well-known list → delegation cascade', () => {
  afterAll(async () => {
    const allJtis = [jti1, jti2, parentTctJti];
    await db
      .delete(revocationEntries)
      .where(sql`${revocationEntries.jti} in (${jti1}, ${jti2}, ${parentTctJti})`);
    await db
      .delete(delegations)
      .where(
        sql`${delegations.jti} in (${childDelegationJti}, ${grandchildDelegationJti})`,
      );
    await db.delete(issuedTcts).where(sql`${issuedTcts.jti} = ${parentTctJti}`);
    await db.delete(auditEvents).where(sql`${auditEvents.runId} = ${RUN_ID}`);
    // tct.revoked events written by the revocation route carry no run id.
    await db
      .delete(auditEvents)
      .where(
        sql`${auditEvents.type} = 'tct.revoked' and ${auditEvents.payload}->>'jti' in (${jti1}, ${jti2}, ${parentTctJti})`,
      );
    await db
      .delete(adminAuditLog)
      .where(
        sql`${adminAuditLog.action} = 'revocation.add' and ${adminAuditLog.targetId} in (${sql.join(
          allJtis.map((j) => sql`${j}`),
          sql`, `,
        )})`,
      );
    await pool.end();
  });

  it('POST persists an entry and the signed list reflects jti, revoked_at and reason', async () => {
    const revokedAtIso = '2026-07-01T12:00:00.000Z';
    const res = await postRevocation({
      jti: jti1,
      reason: 'rev-flow-test',
      revokedAt: revokedAtIso,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      jti: jti1,
      revokedAt: revokedAtIso,
      reason: 'rev-flow-test',
    });

    const env = await fetchList();
    expect(env.revocation_list.version).toBe('aitp/0.2');
    expect(env.revocation_list.issuer).toMatch(/^aid:pubkey:/);
    const nowSecs = Math.floor(Date.now() / 1000);
    expect(env.revocation_list.published_at).toBeLessThanOrEqual(nowSecs + 5);
    expect(env.revocation_list.expires_at).toBeGreaterThan(nowSecs);

    const entry = env.revocation_list.entries.find((e) => e.jti === jti1);
    expect(entry).toBeDefined();
    expect(entry!.revoked_at).toBe(Math.floor(new Date(revokedAtIso).getTime() / 1000));
    expect(entry!.reason).toBe('rev-flow-test');
  });

  it('the envelope signature verifies under the issuer AID key (aitp signing scheme)', async () => {
    const env = await fetchList();
    expect(verifyEnvelopeSignature(env)).toBe(true);

    // Tampering must break the signature.
    const tampered: RevocationEnvelope = JSON.parse(JSON.stringify(env)) as RevocationEnvelope;
    tampered.revocation_list.entries.push({ jti: randomUUID(), revoked_at: 0 });
    expect(verifyEnvelopeSignature(tampered)).toBe(false);

    // When the CP runs from a fixed seed, the issuer is deterministic.
    const seedHex = process.env.CP_AID_SEED_HEX;
    if (seedHex) {
      const expected = AitpAgent.fromSeed(Buffer.from(seedHex, 'hex')).aid;
      expect(env.revocation_list.issuer).toBe(expected);
    }
  });

  it('a new entry invalidates the producer cache and appears on the next GET', async () => {
    // Prime the producer's 60s cache …
    const before = await fetchList();
    expect(before.revocation_list.entries.some((e) => e.jti === jti2)).toBe(false);

    // … then POST: the route must invalidate so the next GET re-signs.
    const res = await postRevocation({ jti: jti2 });
    expect(res.status).toBe(201);

    const after = await fetchList();
    expect(after.revocation_list.entries.some((e) => e.jti === jti2)).toBe(true);
    expect(after.revocation_list.entries.some((e) => e.jti === jti1)).toBe(true);
    // reason omitted → no reason key on the wire entry.
    const entry2 = after.revocation_list.entries.find((e) => e.jti === jti2)!;
    expect(entry2.reason).toBeUndefined();
    expect(verifyEnvelopeSignature(after)).toBe(true);
  });

  it('re-posting the same JTI is idempotent — the list carries it exactly once', async () => {
    const res = await postRevocation({ jti: jti2, reason: 'second attempt' });
    expect(res.status).toBe(201);
    const env = await fetchList();
    const matches = env.revocation_list.entries.filter((e) => e.jti === jti2);
    expect(matches).toHaveLength(1);
  });

  it('rejects a non-UUID jti and an oversize reason', async () => {
    const bad = await postRevocation({ jti: 'not-a-uuid' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('JTI_INVALID');

    const longReason = await postRevocation({ jti: randomUUID(), reason: 'x'.repeat(501) });
    expect(longReason.status).toBe(400);
    expect((await longReason.json()).code).toBe('BODY_INVALID');
  });

  it('revoking a TCT cascades to its delegation chain, visible via GET /api/delegations', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const exp = nowSecs + 3600;

    // Seed the chain the same way agents report it: through the events API.
    const ingest = await eventsPost(
      mkReq('http://localhost/api/events', {
        method: 'POST',
        body: JSON.stringify({
          events: [
            {
              type: 'tct.issued',
              ts: new Date().toISOString(),
              run_id: RUN_ID,
              payload: {
                tct: {
                  claims: {
                    ver: 'aitp/0.2',
                    jti: parentTctJti,
                    iss: issuerAid,
                    sub: delegatorAid,
                    aud: delegatorAid,
                    grants: ['demo.echo'],
                    iat: nowSecs,
                    exp,
                  },
                },
              },
            },
            {
              type: 'delegation.issued',
              ts: new Date().toISOString(),
              run_id: RUN_ID,
              payload: {
                tct: {
                  claims: {
                    jti: childDelegationJti,
                    src_jti: parentTctJti,
                    iss: delegatorAid,
                    sub: delegateeAid,
                    aud: issuerAid,
                    scope: ['demo.echo'],
                    iat: nowSecs,
                    exp,
                  },
                },
              },
            },
            {
              type: 'delegation.issued',
              ts: new Date().toISOString(),
              run_id: RUN_ID,
              payload: {
                tct: {
                  claims: {
                    jti: grandchildDelegationJti,
                    src_jti: childDelegationJti,
                    iss: delegateeAid,
                    sub: grandDelegateeAid,
                    aud: issuerAid,
                    scope: ['demo.echo'],
                    iat: nowSecs,
                    exp,
                  },
                },
              },
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(ingest.status).toBe(200);
    expect(await ingest.json()).toMatchObject({ ingested: 3 });

    // Pre-revocation: direct child visible and active.
    const beforeRes = await delegationsGet(
      mkReq(`http://localhost/api/delegations?parent_jti=${parentTctJti}`),
    );
    expect(beforeRes.status).toBe(200);
    const before = (await beforeRes.json()) as {
      delegations: { jti: string; revoked: boolean }[];
    };
    expect(before.delegations).toHaveLength(1);
    expect(before.delegations[0]).toMatchObject({
      jti: childDelegationJti,
      revoked: false,
    });

    const activeBeforeRes = await delegationsGet(
      mkReq(
        `http://localhost/api/delegations?delegatee=${encodeURIComponent(delegateeAid)}&active=true`,
      ),
    );
    const activeBefore = (await activeBeforeRes.json()) as {
      delegations: { jti: string }[];
    };
    expect(activeBefore.delegations.some((d) => d.jti === childDelegationJti)).toBe(true);

    // Revoke the parent TCT through the route.
    const revoke = await postRevocation({ jti: parentTctJti, reason: 'cascade-test' });
    expect(revoke.status).toBe(201);

    // The list serves the new JTI …
    const env = await fetchList();
    expect(env.revocation_list.entries.some((e) => e.jti === parentTctJti)).toBe(true);

    // … the TCT projection row flips to revoked …
    const tctRows = await db
      .select({ revoked: issuedTcts.revoked })
      .from(issuedTcts)
      .where(sql`${issuedTcts.jti} = ${parentTctJti}`);
    expect(tctRows[0]?.revoked).toBe(true);

    // … and the whole descendant tree is revoked with parent_revoked.
    const treeRes = await delegationsGet(
      mkReq(`http://localhost/api/delegations?root_jti=${childDelegationJti}`),
    );
    const tree = (await treeRes.json()) as {
      delegations: { jti: string; revoked: boolean; revokedReason: string | null }[];
    };
    expect(tree.delegations.map((d) => d.jti).sort()).toEqual(
      [childDelegationJti, grandchildDelegationJti].sort(),
    );
    for (const d of tree.delegations) {
      expect(d.revoked).toBe(true);
      expect(d.revokedReason).toBe('parent_revoked');
    }

    // active=true now excludes the revoked delegation.
    const activeAfterRes = await delegationsGet(
      mkReq(
        `http://localhost/api/delegations?delegatee=${encodeURIComponent(delegateeAid)}&active=true`,
      ),
    );
    const activeAfter = (await activeAfterRes.json()) as {
      delegations: { jti: string }[];
    };
    expect(activeAfter.delegations.some((d) => d.jti === childDelegationJti)).toBe(false);
  });
});
