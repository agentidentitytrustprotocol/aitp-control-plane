/**
 * Integration: OBSERVED_ARTIFACT_VERIFICATION=strict through the real monitor.
 *
 * `config` is frozen at import, so the env is set before the modules are
 * loaded (dynamic import in beforeAll), not at the top of the file.
 */

import { AitpAgent } from 'aitp';
import { inArray } from 'drizzle-orm';
import type { AuditEventRecord } from '@/lib/audit/stream';

function handshakeTct(): { token: string; claims: Record<string, unknown> } {
  const opts = (n: string) => ({
    displayName: n,
    handshakeEndpoint: `https://${n}.example/h`,
    offeredCaps: ['demo.echo'],
    ttlSecs: 3600,
  });
  const a = AitpAgent.generate();
  const b = AitpAgent.generate();
  a.buildManifest(opts('a'));
  const manifestB = b.buildManifest(opts('b'));
  const i = a.newSession();
  const r = b.newResponder();
  const hello = r.processHello(i.buildHello(manifestB, ['demo.echo']));
  const done = i.complete(r.processCommit(i.processHelloAck(hello.ackJson, hello.sessionId)).ackJson);
  return { token: done.tct, claims: done.claims as unknown as Record<string, unknown> };
}

function event(tct: unknown): AuditEventRecord {
  return {
    id: crypto.randomUUID(),
    type: 'tct.issued',
    ts: new Date().toISOString(),
    payload: { tct },
  } as unknown as AuditEventRecord;
}

describe('integration: strict observed-artifact verification', () => {
  let dbMod: typeof import('@/lib/db');
  let schema: typeof import('@/lib/db/schema');
  let monitor: typeof import('@/lib/tcts/monitor');
  const jtis: string[] = [];

  beforeAll(async () => {
    process.env.OBSERVED_ARTIFACT_VERIFICATION = 'strict';
    dbMod = await import('@/lib/db');
    schema = await import('@/lib/db/schema');
    monitor = await import('@/lib/tcts/monitor');
  });

  afterAll(async () => {
    delete process.env.OBSERVED_ARTIFACT_VERIFICATION;
    if (jtis.length > 0) {
      await dbMod.db.delete(schema.issuedTcts).where(inArray(schema.issuedTcts.jti, jtis));
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
});
