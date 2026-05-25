import { and, asc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { agents, type Agent } from '../db/schema';

export interface RegistryFilters {
  capability?: string;
  aid?: string;
  displayName?: string;
  status?: string;
  namespace?: string;
}

export interface RegisterInput {
  aid: string;
  displayName: string;
  handshakeEndpoint: string;
  offeredCaps: string[];
  manifestJson: string;
  manifestExpiresAt: string | null;
  org?: string | null;
  cloud?: string | null;
  namespace?: string;
}

export async function listAgents(filters: RegistryFilters): Promise<Agent[]> {
  const now = new Date().toISOString();
  const where = [
    eq(agents.status, filters.status ?? 'active'),
    // Exclude manifests whose expires_at is in the past. Agents whose
    // manifest_expires_at is NULL keep showing up — they were enrolled
    // before that column existed, or the manifest didn't carry an expiry.
    or(
      isNull(agents.manifestExpiresAt),
      gte(agents.manifestExpiresAt, now),
    )!,
  ];
  if (filters.aid) where.push(eq(agents.aid, filters.aid));
  if (filters.displayName)
    where.push(eq(agents.displayName, filters.displayName));
  if (filters.namespace) where.push(eq(agents.namespace, filters.namespace));
  if (filters.capability) {
    // jsonb contains ['capability'] — picks up the GIN index from 0002.
    where.push(
      sql`${agents.offeredCaps} @> ${JSON.stringify([filters.capability])}::jsonb`,
    );
  }
  return db
    .select()
    .from(agents)
    .where(and(...where))
    .orderBy(asc(agents.registeredAt));
}

export async function getAgent(aid: string): Promise<Agent | undefined> {
  const rows = await db.select().from(agents).where(eq(agents.aid, aid));
  return rows[0];
}

export async function upsertAgent(input: RegisterInput): Promise<void> {
  const enrolledAt = new Date().toISOString();
  await db
    .insert(agents)
    .values({
      aid: input.aid,
      displayName: input.displayName,
      handshakeEndpoint: input.handshakeEndpoint,
      offeredCaps: input.offeredCaps,
      manifestJson: input.manifestJson,
      manifestExpiresAt: input.manifestExpiresAt,
      org: input.org ?? null,
      cloud: input.cloud ?? null,
      namespace: input.namespace ?? 'default',
      status: 'active',
      lastEnrolledAt: enrolledAt,
    })
    .onConflictDoUpdate({
      target: agents.aid,
      set: {
        displayName: input.displayName,
        handshakeEndpoint: input.handshakeEndpoint,
        offeredCaps: input.offeredCaps,
        manifestJson: input.manifestJson,
        manifestExpiresAt: input.manifestExpiresAt,
        namespace: input.namespace ?? 'default',
        // Re-activate even if the agent had expired or been deregistered —
        // a fresh enrollment IS the un-stale signal.
        status: 'active',
        lastEnrolledAt: enrolledAt,
      },
    });
}

export async function deactivateAgent(aid: string): Promise<boolean> {
  const updated = await db
    .update(agents)
    .set({ status: 'deregistered' })
    .where(eq(agents.aid, aid))
    .returning({ aid: agents.aid });
  return updated.length > 0;
}

export async function touchLastSeen(aid: string): Promise<void> {
  await db
    .update(agents)
    .set({ lastSeenAt: new Date().toISOString() })
    .where(eq(agents.aid, aid));
}

/** Batched variant — one UPDATE for the whole AID set, instead of N. */
export async function touchLastSeenBatch(aids: string[]): Promise<void> {
  if (aids.length === 0) return;
  await db
    .update(agents)
    .set({ lastSeenAt: new Date().toISOString() })
    .where(inArray(agents.aid, aids));
}
