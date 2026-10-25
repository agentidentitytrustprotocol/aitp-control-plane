/**
 * Integration: the per-issuer revocation relay (CP1.1) end to end, against a
 * real Postgres and the real AITP Rust binding.
 *
 * The CP never signs a revocation list (RFC-AITP-0008 §1.5: a list is valid
 * only from the issuer of the tokens it names; spec fixture rev-011). It
 * stores entries and relays each issuer's own set at
 * `GET /api/revocations?iss=<aid>`; the issuer signs and serves them.
 *
 * Verifies:
 *   - the headline flow: agent B issues a TCT to A in a real handshake, the
 *     TCT is reported to the CP, and a fail_closed verifier accepts it; an
 *     operator revokes it at the CP (iss resolved from the TCT projection);
 *     B pulls its entries, signs them with its own key, and the same
 *     verifier now rejects the TCT
 *   - the spec rule the relay exists for: a list for B's tokens signed by
 *     anyone but B (here: a stand-in for the CP) fails verification, and a
 *     fail_closed verifier then refuses the TCT rather than trusting it
 *   - the aitp 0.20 SDK default: with no verified list, verifyTct refuses
 *     every TCT with TCT_REVOKED
 *   - authorisation: B's issuer key reads only `iss=B` (another iss is 403),
 *     a malformed iss is 400, and only an issuer-key pull moves the
 *     last-pull gauge
 *   - the relay answers one issuer's entries only, re-posting is idempotent,
 *     and an explicit iss that contradicts the TCT projection is 409
 *   - revoked_at: both ends of the accepted range, and low-year rows written
 *     straight to the table, relay as the correct epoch seconds
 *   - the tct.revoked event still cascades through the delegation projection
 *
 * Route handlers are driven directly, so the request gate does not run; the
 * headers it would set for an issuer key (KEY_ISSUER_HEADER, KEY_LABEL_HEADER)
 * are set by hand. The gate's own behaviour is covered by src/proxy.test.ts.
 *
 * Cleanup is targeted by the run-unique JTIs/run id so the suite is
 * order-independent and re-runnable.
 */

import { AitpAgent, verifyRevocationList } from 'aitp';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { POST as revocationPost } from '@/app/api/revocation/entries/route';
import { GET as revocationsGet } from '@/app/api/revocations/route';
import { GET as revocationIssuersGet } from '@/app/api/revocation/issuers/route';
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
import { KEY_ISSUER_HEADER, KEY_LABEL_HEADER } from '@/lib/audit-log/actor';
import { getIssuerLastPulls, resetIssuerPulls } from '@/lib/revocation/relay-metrics';
import { expectVerifyCode } from '@/test/expect-verify-code';

type Agent = InstanceType<typeof AitpAgent>;

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

interface RelayedEntry {
  jti: string;
  revoked_at: number;
  reason?: string;
}

/** GET /api/revocations as the gate would forward it for an issuer key bound
 * to `boundAid` (or, with `boundAid` null, for an admin key). */
function pull(iss: string, boundAid: string | null, label = 'rev-flow-issuer'): Promise<Response> {
  const headers: Record<string, string> = { [KEY_LABEL_HEADER]: label };
  if (boundAid !== null) headers[KEY_ISSUER_HEADER] = boundAid;
  return revocationsGet(
    mkReq(`http://localhost/api/revocations?iss=${encodeURIComponent(iss)}`, { headers }),
  );
}

async function pullEntries(issuer: Agent): Promise<RelayedEntry[]> {
  const res = await pull(issuer.aid, issuer.aid);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = (await res.json()) as { iss: string; entries: RelayedEntry[] };
  expect(body.iss).toBe(issuer.aid);
  return body.entries;
}

/** What the issuing agent does with a pull: sign the entries itself. */
function signAs(signer: Agent, entries: RelayedEntry[]): string {
  return signer.signRevocationList(
    entries.map((e) => ({ jti: e.jti, revokedAt: e.revoked_at, reason: e.reason })),
  );
}

/**
 * A fail_closed verifier (RFC-AITP-0008), as aitp 0.20 makes the default: it
 * hands `verifyTct` the deny list only when the list verifies under the TCT's
 * own issuer. An unverifiable list is treated as no list at all, and the SDK
 * then refuses every TCT with `TCT_REVOKED` ("revocation source
 * unavailable") -- never "nothing revoked". Throws on refusal.
 */
function failClosedVerify(
  verifier: Agent,
  tct: { token: string; claims: { iss: string; aud: string } },
  listEnvelope: string,
): void {
  let revoked: string[] | null = null;
  try {
    verifyRevocationList(listEnvelope, tct.claims.iss);
    revoked = (
      JSON.parse(listEnvelope) as { revocation_list: { entries: { jti: string }[] } }
    ).revocation_list.entries.map((e) => e.jti);
  } catch {
    // Unverifiable: fall through with no list and let the SDK fail closed.
  }
  verifier.verifyTct(tct.token, 'demo.echo', tct.claims.aud, revoked);
}

/** A real handshake: `holder` initiates, `issuer` responds and issues the TCT. */
function handshake(holder: Agent, issuer: Agent) {
  const opts = (n: string) => ({
    displayName: n,
    handshakeEndpoint: `https://${n}.example/h`,
    offeredCaps: ['demo.echo'],
    ttlSecs: 3600,
  });
  holder.buildManifest(opts('holder'));
  const issuerManifest = issuer.buildManifest(opts('issuer'));
  const i = holder.newSession(null, { pinnedKeys: [issuer.aid] });
  const r = issuer.newResponder(null, { pinnedKeys: [holder.aid] });
  const hello = r.processHello(i.buildHello(issuerManifest, ['demo.echo']));
  const done = i.complete(
    r.processCommit(i.processHelloAck(hello.ackJson, hello.sessionId), []).ackJson,
    [],
  );
  const claims = done.claims as unknown as {
    iss: string;
    sub: string;
    aud: string;
    jti: string;
    iat: number;
    exp: number;
    grants: string[];
  };
  return { token: done.tct, claims };
}

const RUN_ID = `rev-flow-${randomUUID()}`;

// The headline flow's three parties, plus a second issuer and a stand-in for
// the CP's own identity (any key that is not the issuer's).
const holderA = AitpAgent.generate();
const issuerB = AitpAgent.generate();
const otherIssuer = AitpAgent.generate();
const notTheIssuer = AitpAgent.generate();
const verifier = AitpAgent.generate();
const tct = handshake(holderA, issuerB);

const otherJti = randomUUID();
const conflictJti = randomUUID();
const boundaryMinJti = randomUUID();
const boundaryMaxJti = randomUUID();
// Rows written DIRECTLY to the table, bypassing the route's epoch floor (#113).
const legacyLowYearJtis = [randomUUID(), randomUUID(), randomUUID()];
const parentTctJti = randomUUID();
const childDelegationJti = randomUUID();
const grandchildDelegationJti = randomUUID();

// Synthetic AIDs for the delegation cascade, which never verifies a token.
const cascadeIssuerAid = `aid:test:rev-issuer-${RUN_ID}`;
const delegatorAid = `aid:test:rev-delegator-${RUN_ID}`;
const delegateeAid = `aid:test:rev-delegatee-${RUN_ID}`;
const grandDelegateeAid = `aid:test:rev-grand-${RUN_ID}`;

const ALL_JTIS = [
  tct.claims.jti,
  otherJti,
  conflictJti,
  boundaryMinJti,
  boundaryMaxJti,
  ...legacyLowYearJtis,
  parentTctJti,
];

function inJtis(col: unknown) {
  return sql`${col} in (${sql.join(
    ALL_JTIS.map((j) => sql`${j}`),
    sql`, `,
  )})`;
}

async function reportIssued(claims: Record<string, unknown>): Promise<void> {
  const res = await eventsPost(
    mkReq('http://localhost/api/events', {
      method: 'POST',
      body: JSON.stringify({
        events: [
          {
            type: 'tct.issued',
            ts: new Date().toISOString(),
            run_id: RUN_ID,
            payload: { tct: { claims: { ver: 'aitp/0.3', ...claims } } },
          },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    }),
  );
  expect(res.status).toBe(200);
}

describe('integration: revocation relay → issuer-signed list → fail_closed verifier', () => {
  beforeAll(() => resetIssuerPulls());

  afterAll(async () => {
    await db.delete(revocationEntries).where(inJtis(revocationEntries.jti));
    await db
      .delete(delegations)
      .where(
        sql`${delegations.jti} in (${childDelegationJti}, ${grandchildDelegationJti})`,
      );
    await db.delete(issuedTcts).where(inJtis(issuedTcts.jti));
    await db.delete(auditEvents).where(sql`${auditEvents.runId} = ${RUN_ID}`);
    // tct.revoked events written by the revocation route carry no run id.
    await db
      .delete(auditEvents)
      .where(
        sql`${auditEvents.type} = 'tct.revoked' and ${inJtis(sql`${auditEvents.payload}->>'jti'`)}`,
      );
    await db
      .delete(adminAuditLog)
      .where(
        sql`${adminAuditLog.action} = 'revocation.add' and ${inJtis(adminAuditLog.targetId)}`,
      );
    await pool.end();
  });

  it('accepts the TCT before revocation, and rejects it once B relays and signs its list', async () => {
    // The agents report the issuance, as they do in production; that is what
    // tells the CP who issued this jti.
    await reportIssued(tct.claims);

    // Before: B's list (pulled from the relay) does not name the TCT.
    const before = await pullEntries(issuerB);
    expect(before.some((e) => e.jti === tct.claims.jti)).toBe(false);
    expect(() => failClosedVerify(verifier, tct, signAs(issuerB, before))).not.toThrow();

    // An operator revokes it at the CP, without naming the issuer.
    const revokedAtIso = '2026-07-01T12:00:00.000Z';
    const res = await postRevocation({
      jti: tct.claims.jti,
      reason: 'rev-flow-test',
      revokedAt: revokedAtIso,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ jti: tct.claims.jti, iss: issuerB.aid });

    // B pulls, signs with its own key and serves the list.
    const after = await pullEntries(issuerB);
    const entry = after.find((e) => e.jti === tct.claims.jti);
    expect(entry).toEqual({
      jti: tct.claims.jti,
      revoked_at: Math.floor(Date.parse(revokedAtIso) / 1000),
      reason: 'rev-flow-test',
    });
    const signed = signAs(issuerB, after);
    expect(() => verifyRevocationList(signed, issuerB.aid)).not.toThrow();

    // The same verifier now refuses the TCT.
    expectVerifyCode(() => failClosedVerify(verifier, tct, signed), 'TCT_REVOKED');
  });

  it('a list for B tokens signed by anyone but B is refused (rev-011), and so is the TCT', async () => {
    const entries = await pullEntries(issuerB);
    const thirdParty = signAs(notTheIssuer, entries);
    expectVerifyCode(() => verifyRevocationList(thirdParty, issuerB.aid), 'issuer_mismatch');
    // fail_closed: an unverifiable list is not "nothing revoked". The SDK
    // refuses the TCT even though this list does not name it.
    const unrevoked = signAs(
      notTheIssuer,
      entries.filter((e) => e.jti !== tct.claims.jti),
    );
    expectVerifyCode(() => failClosedVerify(verifier, tct, unrevoked), 'TCT_REVOKED');
  });

  it('with no revocation list at all, the aitp 0.20 verifier refuses the TCT', () => {
    expectVerifyCode(
      () => verifier.verifyTct(tct.token, 'demo.echo', tct.claims.aud),
      'TCT_REVOKED',
    );
  });

  it("an issuer key reads only its own issuer's entries", async () => {
    const res = await pull(otherIssuer.aid, issuerB.aid);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('ISSUER_MISMATCH');

    for (const bad of ['', 'not-an-aid', 'aid:has space']) {
      const r = await pull(bad, null);
      expect(r.status).toBe(400);
      expect((await r.json()).code).toBe('ISS_INVALID');
    }
  });

  it('records the last pull per issuer key, and not for admin pulls', async () => {
    resetIssuerPulls();
    expect((await pull(issuerB.aid, null, 'admin')).status).toBe(200);
    expect(getIssuerLastPulls().has('admin')).toBe(false);

    const before = Math.floor(Date.now() / 1000);
    expect((await pull(issuerB.aid, issuerB.aid, 'issuer-b')).status).toBe(200);
    expect(getIssuerLastPulls().get('issuer-b')?.secs).toBeGreaterThanOrEqual(before);
    expect(getIssuerLastPulls().get('issuer-b')?.aid).toBe(issuerB.aid);

    // A refused pull is not a pull.
    expect((await pull(otherIssuer.aid, issuerB.aid, 'issuer-b-refused')).status).toBe(403);
    expect(getIssuerLastPulls().has('issuer-b-refused')).toBe(false);
  });

  it("relays one issuer's entries only", async () => {
    const res = await postRevocation({ jti: otherJti, iss: otherIssuer.aid });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ iss: otherIssuer.aid });

    const ofB = await pullEntries(issuerB);
    expect(ofB.some((e) => e.jti === otherJti)).toBe(false);
    const ofOther = await pullEntries(otherIssuer);
    expect(ofOther.map((e) => e.jti)).toEqual([otherJti]);
    // reason omitted → no reason key on the relayed entry.
    expect(ofOther[0].reason).toBeUndefined();
  });

  it('lists issuers with entry counts, in stable pages', async () => {
    // Page through everything (the database may hold other suites' rows).
    const seen: { iss: string; entries: number }[] = [];
    for (let offset = 0; ; offset += 2) {
      const res = await revocationIssuersGet(
        mkReq(`http://localhost/api/revocation/issuers?limit=2&offset=${offset}`),
      );
      expect(res.status).toBe(200);
      const page = (await res.json()) as { issuers: { iss: string; entries: number }[] };
      seen.push(...page.issuers);
      if (page.issuers.length < 2) break;
    }
    const isses = seen.map((i) => i.iss);
    expect(isses).toEqual([...isses].sort());
    expect(new Set(isses).size).toBe(isses.length);
    expect(seen.find((i) => i.iss === otherIssuer.aid)).toEqual({ iss: otherIssuer.aid, entries: 1 });
    const ofB = await pullEntries(issuerB);
    expect(seen.find((i) => i.iss === issuerB.aid)?.entries).toBe(ofB.length);
  });

  it('re-posting is idempotent, and a contradicting iss is 409', async () => {
    const again = await postRevocation({ jti: tct.claims.jti, reason: 'second attempt' });
    expect(again.status).toBe(201);
    const entries = await pullEntries(issuerB);
    expect(entries.filter((e) => e.jti === tct.claims.jti)).toHaveLength(1);

    // The TCT projection says B issued it; the body says otherwise.
    await reportIssued({ ...tct.claims, jti: conflictJti });
    const conflict = await postRevocation({ jti: conflictJti, iss: otherIssuer.aid });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('ISS_MISMATCH');
    const stored = await db
      .select({ jti: revocationEntries.jti })
      .from(revocationEntries)
      .where(sql`${revocationEntries.jti} = ${conflictJti}`);
    expect(stored).toHaveLength(0);

    // An unknown jti with no iss has nowhere to be relayed to.
    const orphan = await postRevocation({ jti: randomUUID() });
    expect(orphan.status).toBe(400);
    expect((await orphan.json()).code).toBe('ISS_REQUIRED');
  });

  it('rejects a non-UUID jti and an oversize reason', async () => {
    const bad = await postRevocation({ jti: 'not-a-uuid' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('JTI_INVALID');

    const longReason = await postRevocation({
      jti: randomUUID(),
      iss: issuerB.aid,
      reason: 'x'.repeat(501),
    });
    expect(longReason.status).toBe(400);
    expect((await longReason.json()).code).toBe('BODY_INVALID');
  });

  // The route bounds `revokedAt` to [1970-01-01Z, 9999-12-31T23:59:59.999Z].
  // The unit tests mock the database, so they cannot see that Postgres stores
  // the extremes, nor that the relay hands them back as the right epoch
  // seconds, which is what the issuer then signs.
  it('stores both ends of the accepted range and relays them with the correct instant', async () => {
    const cases = [
      [boundaryMinJti, '1970-01-01T00:00:00.000Z'],
      [boundaryMaxJti, '9999-12-31T23:59:59.999Z'],
    ] as const;
    for (const [jti, revokedAt] of cases) {
      const res = await postRevocation({ jti, revokedAt, reason: 'boundary', iss: otherIssuer.aid });
      expect(res.status).toBe(201);
      expect((await res.json()).revokedAt).toBe(revokedAt);
    }
    const entries = await pullEntries(otherIssuer);
    for (const [jti, revokedAt] of cases) {
      const entry = entries.find((e) => e.jti === jti);
      expect(entry?.revoked_at).toBe(Math.floor(Date.parse(revokedAt) / 1000));
    }
    expect(() => verifyRevocationList(signAs(otherIssuer, entries), otherIssuer.aid)).not.toThrow();
  });

  // #113: the route's floor only stops NEW rows. Rows already stored must
  // still relay correctly. Years 0001/0002/0099 are the ones a
  // `new Date(driverText)` re-parse mis-reads, which is why the relay has
  // Postgres compute the epoch.
  it('relays low-year rows inserted directly into the table with the correct epoch', async () => {
    const cases = [
      [legacyLowYearJtis[0], '0001-01-01T00:00:00Z', -62135596800],
      [legacyLowYearJtis[1], '0002-01-01T00:00:00Z', -62104060800],
      [legacyLowYearJtis[2], '0099-01-01T00:00:00Z', -59042995200],
    ] as const;
    for (const [jti, ts] of cases) {
      await db.execute(
        sql`insert into revocation_entries (jti, revoked_at, reason, iss) values (${jti}, ${ts}::timestamptz, 'legacy low year', ${otherIssuer.aid})`,
      );
    }
    const entries = await pullEntries(otherIssuer);
    for (const [jti, , epoch] of cases) {
      expect(entries.find((e) => e.jti === jti)?.revoked_at).toBe(epoch);
    }
  });

  it('rejects an out-of-range revokedAt without letting Postgres answer', async () => {
    for (const revokedAt of [
      '+010000-01-01T00:00:00Z',
      '0001-01-01T00:00:00.000Z',
      '1969-12-31T23:59:59.999Z',
    ]) {
      const res = await postRevocation({ jti: randomUUID(), revokedAt, iss: issuerB.aid });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('BODY_INVALID');
      expect(body.error).toMatch(/1970-01-01.*9999-12-31/);
      expect(body.error).not.toContain('timestamp with time zone');
    }
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
                    ver: 'aitp/0.3',
                    jti: parentTctJti,
                    iss: cascadeIssuerAid,
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
                    aud: cascadeIssuerAid,
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
                    aud: cascadeIssuerAid,
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

    // Revoke the parent TCT through the route; iss comes from the projection.
    const revoke = await postRevocation({ jti: parentTctJti, reason: 'cascade-test' });
    expect(revoke.status).toBe(201);
    expect((await revoke.json()).iss).toBe(cascadeIssuerAid);

    // The relay serves the new JTI to its issuer …
    const relayed = await pull(cascadeIssuerAid, null);
    expect(
      ((await relayed.json()) as { entries: RelayedEntry[] }).entries.some(
        (e) => e.jti === parentTctJti,
      ),
    ).toBe(true);

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
