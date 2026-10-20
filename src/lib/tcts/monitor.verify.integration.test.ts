/**
 * Integration: OBSERVED_ARTIFACT_VERIFICATION=strict through the real monitor.
 *
 * `config` is frozen at import, so the env is set before the modules are
 * loaded (dynamic import in beforeAll), not at the top of the file.
 */

import { AitpAgent } from 'aitp';
import { inArray } from 'drizzle-orm';
import type { AuditEventRecord } from '@/lib/audit/stream';

interface Handshake {
  a: InstanceType<typeof AitpAgent>;
  manifestA: string;
  tct: { token: string; claims: Record<string, unknown> };
  grantVoucher: string;
}

function handshake(): Handshake {
  const opts = (n: string) => ({
    displayName: n,
    handshakeEndpoint: `https://${n}.example/h`,
    offeredCaps: ['demo.echo'],
    ttlSecs: 3600,
  });
  const a = AitpAgent.generate();
  const b = AitpAgent.generate();
  const manifestA = a.buildManifest(opts('a'));
  const manifestB = b.buildManifest(opts('b'));
  // aitp >= 0.15: admission is pinned; jwks first, opts second.
  const i = a.newSession(null, { pinnedKeys: [b.aid] });
  const r = b.newResponder(null, { pinnedKeys: [a.aid] });
  const hello = r.processHello(i.buildHello(manifestB, ['demo.echo']));
  const done = i.complete(r.processCommit(i.processHelloAck(hello.ackJson, hello.sessionId)).ackJson);
  if (!done.grantVoucher) throw new Error('handshake returned no grant voucher');
  return {
    a,
    manifestA,
    tct: { token: done.tct, claims: done.claims as unknown as Record<string, unknown> },
    grantVoucher: done.grantVoucher,
  };
}

function handshakeTct(): { token: string; claims: Record<string, unknown> } {
  return handshake().tct;
}

function event(tct: unknown, type = 'tct.issued'): AuditEventRecord {
  return {
    id: crypto.randomUUID(),
    type,
    ts: new Date().toISOString(),
    payload: { tct },
  } as unknown as AuditEventRecord;
}

describe('integration: strict observed-artifact verification', () => {
  let dbMod: typeof import('@/lib/db');
  let schema: typeof import('@/lib/db/schema');
  let monitor: typeof import('@/lib/tcts/monitor');
  let store: typeof import('@/lib/registry/store');
  const jtis: string[] = [];
  const aids: string[] = [];

  beforeAll(async () => {
    process.env.OBSERVED_ARTIFACT_VERIFICATION = 'strict';
    dbMod = await import('@/lib/db');
    schema = await import('@/lib/db/schema');
    monitor = await import('@/lib/tcts/monitor');
    store = await import('@/lib/registry/store');
  });

  afterAll(async () => {
    delete process.env.OBSERVED_ARTIFACT_VERIFICATION;
    if (jtis.length > 0) {
      await dbMod.db.delete(schema.issuedTcts).where(inArray(schema.issuedTcts.jti, jtis));
    }
    if (aids.length > 0) {
      await dbMod.db
        .delete(schema.delegations)
        .where(inArray(schema.delegations.delegatorAid, aids));
      await dbMod.db.delete(schema.agents).where(inArray(schema.agents.aid, aids));
    }
    await dbMod.pool.end();
  });

  async function projected(jti: string): Promise<boolean> {
    const rows = await dbMod.db
      .select({ jti: schema.issuedTcts.jti })
      .from(schema.issuedTcts)
      .where(inArray(schema.issuedTcts.jti, [jti]));
    return rows.length === 1;
  }

  it('projects a genuine token, drops a tampered one and a claims-only one', async () => {
    const good = handshakeTct();
    const bad = handshakeTct();
    const flat = handshakeTct();
    jtis.push(good.claims.jti as string, bad.claims.jti as string, flat.claims.jti as string);

    const [h, p, s] = bad.token.split('.');
    const tampered = `${h}.${p}.${(s[0] === 'A' ? 'B' : 'A') + s.slice(1)}`;

    await monitor.tctMonitor.onEvent(event(good));
    await monitor.tctMonitor.onEvent(event({ token: tampered, claims: bad.claims }));
    await monitor.tctMonitor.onEvent(event(flat.claims));

    expect(await projected(good.claims.jti as string)).toBe(true);
    expect(await projected(bad.claims.jti as string)).toBe(false);
    expect(await projected(flat.claims.jti as string)).toBe(false);
  });

  async function delegationsFrom(aid: string): Promise<number> {
    const rows = await dbMod.db
      .select({ jti: schema.delegations.jti })
      .from(schema.delegations)
      .where(inArray(schema.delegations.delegatorAid, [aid]));
    return rows.length;
  }

  function delegate(h: Handshake): { token: string; claims: Record<string, unknown> } {
    const c = AitpAgent.generate();
    const token = h.a.buildDelegation(h.grantVoucher, c.aid, ['demo.echo'], 600);
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return { token, claims };
  }

  // aitp >= 0.16: a delegation verifies only under the delegator's Manifest,
  // which the monitor takes from the registry row.
  it('projects a delegation only when its delegator is enrolled', async () => {
    const enrolled = handshake();
    const unknown = handshake();
    aids.push(enrolled.a.aid, unknown.a.aid);
    const env = JSON.parse(enrolled.manifestA) as {
      manifest: { display_name: string; handshake_endpoint: string; expires_at?: number };
    };
    await store.upsertAgent({
      aid: enrolled.a.aid,
      displayName: env.manifest.display_name,
      handshakeEndpoint: env.manifest.handshake_endpoint,
      offeredCaps: ['demo.echo'],
      manifestJson: enrolled.manifestA,
      manifestExpiresAt: null,
    });

    await monitor.tctMonitor.onEvent(event(delegate(enrolled), 'delegation.issued'));
    await monitor.tctMonitor.onEvent(event(delegate(unknown), 'delegation.issued'));

    expect(await delegationsFrom(enrolled.a.aid)).toBe(1);
    expect(await delegationsFrom(unknown.a.aid)).toBe(0);
  });
});
