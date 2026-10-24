/**
 * Integration: per-consumer API keys (CP0.1) against a real Postgres.
 *
 *   - A gated mutation made with key B is written to admin_audit_log with
 *     actor `key:<label of B>`, and key A's with A's label: the request gate
 *     (src/proxy.ts) resolves the label and forwards it, the route records it.
 *   - The rotation shape (H0.1): with keys O and N configured both pass; once O
 *     is removed from API_KEYS, O answers 401 at the gate and N still passes.
 *
 * The gate's forwarded request headers are read from the `x-middleware-request-*`
 * response headers, which is what Next's router itself consumes, then handed to
 * the real route handler. No HTTP server, no echo route.
 */
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';

import { db, pool } from '@/lib/db';
import { adminAuditLog, auditEvents, revocationEntries } from '@/lib/db/schema';

type Proxy = (r: NextRequest) => Response;
type Handler = (r: NextRequest) => Promise<Response>;

const KEY_A = `key-a-${randomUUID()}`;
const KEY_B = `key-b-${randomUUID()}`;
const jtis: string[] = [];

/** Load the gate with API_KEYS set to `apiKeys` (config is read at module load). */
function loadProxy(apiKeys: string): Proxy {
  process.env.API_KEYS = apiKeys;
  let proxy!: Proxy;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    proxy = (require('@/proxy') as { proxy: Proxy }).proxy;
  });
  return proxy;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST: revocationPost } = require('@/app/api/revocation/entries/route') as {
  POST: Handler;
};

function gateRequest(token: string, requestId: string): NextRequest {
  return new NextRequest('http://localhost/api/revocation/entries', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-request-id': requestId,
      'content-type': 'application/json',
      // A caller cannot pick its own label: the gate drops this.
      'x-aitp-key-label': 'spoofed',
    },
  });
}

/** Run the gate; if it passes, run the route with the headers the gate forwarded. */
async function throughGate(proxy: Proxy, token: string): Promise<{ status: number; requestId: string }> {
  const requestId = `it-${randomUUID()}`;
  const gate = proxy(gateRequest(token, requestId));
  if (gate.status !== 200) return { status: gate.status, requestId };

  const names = (gate.headers.get('x-middleware-override-headers') ?? '').split(',');
  const headers: Record<string, string> = {};
  for (const n of names) {
    const v = gate.headers.get(`x-middleware-request-${n}`);
    if (n && v !== null) headers[n] = v;
  }
  const jti = randomUUID();
  jtis.push(jti);
  const res = await revocationPost(
    new NextRequest('http://localhost/api/revocation/entries', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jti, reason: 'cp0.1 integration' }),
    }),
  );
  return { status: res.status, requestId };
}

async function actorFor(requestId: string): Promise<string | null | undefined> {
  const rows = await db.select().from(adminAuditLog);
  return rows.find((r) => r.requestId === requestId)?.actorId;
}

afterAll(async () => {
  if (jtis.length) {
    await db.delete(revocationEntries).where(inArray(revocationEntries.jti, jtis));
    await db.delete(adminAuditLog).where(inArray(adminAuditLog.targetId, jtis));
    // The route also emits a tct.revoked telemetry event per entry.
    await db
      .delete(auditEvents)
      .where(
        sql`${auditEvents.type} = 'tct.revoked' and ${auditEvents.payload}->>'jti' in (${sql.join(
          jtis.map((j) => sql`${j}`),
          sql`, `,
        )})`,
      );
  }
  delete process.env.API_KEYS;
  await pool.end();
});

describe('per-consumer API keys', () => {
  it('a request with key B is logged with label B (and A with A)', async () => {
    const proxy = loadProxy(`console-a:${KEY_A},ops-b:${KEY_B}`);
    const b = await throughGate(proxy, KEY_B);
    const a = await throughGate(proxy, KEY_A);
    expect(b.status).toBe(201);
    expect(a.status).toBe(201);
    expect(await actorFor(b.requestId)).toBe('key:ops-b');
    expect(await actorFor(a.requestId)).toBe('key:console-a');
  });

  it('a bare key is logged as unlabelled-<n>', async () => {
    const proxy = loadProxy(`console-a:${KEY_A},${KEY_B}`);
    const b = await throughGate(proxy, KEY_B);
    expect(b.status).toBe(201);
    expect(await actorFor(b.requestId)).toBe('key:unlabelled-2');
  });

  it('two keys, one removed: the removed key answers 401, the other still works', async () => {
    const both = loadProxy(`console-old:${KEY_A},console-new:${KEY_B}`);
    expect((await throughGate(both, KEY_A)).status).toBe(201);
    expect((await throughGate(both, KEY_B)).status).toBe(201);

    const after = loadProxy(`console-new:${KEY_B}`);
    expect((await throughGate(after, KEY_A)).status).toBe(401);
    const kept = await throughGate(after, KEY_B);
    expect(kept.status).toBe(201);
    expect(await actorFor(kept.requestId)).toBe('key:console-new');
  });
});
