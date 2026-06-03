import { NextRequest } from 'next/server';
import { getEnrollmentService } from '@/lib/registry/enrollment';
import { consumeEnrollmentJti } from '@/lib/registry/jti-store';
import { listAgents, upsertAgent } from '@/lib/registry/store';
import { ingestOneEvent } from '@/lib/audit/event-store';
import { eventBus, type AuditEventRecord } from '@/lib/audit/stream';
import { writeAdminAudit } from '@/lib/audit-log/service';
import { dispatchWebhooks } from '@/lib/webhooks/service';
import { logger } from '@/lib/logger';
import { withIdempotency } from '@/lib/idempotency';
import { parsePagination } from '@/lib/pagination';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ManifestEnvelope {
  manifest: {
    aid: string;
    display_name?: string;
    handshake_endpoint: string;
    offered_capabilities: string[];
    expires_at?: number;
    extensions?: Record<string, unknown>;
  };
}

const REGISTRATION_EXPIRY_GUARD_MS = 5 * 60 * 1000;

/** Best-effort derivation of the agent's own `.well-known` manifest URL.
 *
 * This is a HINT — the field name conveys that — assuming the agent
 * hosts `.well-known` at the host root, which is the RFC-AITP convention
 * for an agent that owns its own host. Operators running multiple agents
 * behind a single gateway will get a 404 from the hint; callers should
 * fall back to the CP's own cached copy at `manifestUrl`. Returns null
 * only when the handshake URL can't be parsed at all. */
function deriveAgentManifestHint(handshakeEndpoint: string): string | null {
  try {
    const url = new URL(handshakeEndpoint);
    if (!url.host) return null;
    return `${url.protocol}//${url.host}/.well-known/aitp-manifest`;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const capability = searchParams.get('capability') ?? undefined;
  const aid = searchParams.get('aid') ?? undefined;
  const displayName =
    searchParams.get('display_name') ?? searchParams.get('displayName') ?? undefined;
  const namespace = searchParams.get('namespace') ?? undefined;
  const includeManifest = searchParams.get('include_manifest') === 'true';
  const { limit, offset } = parsePagination(searchParams, {
    defaultLimit: 200,
    maxLimit: 1000,
  });

  const results = await listAgents({
    capability,
    aid,
    displayName,
    namespace,
    limit,
    offset,
  });
  return Response.json({
    agents: results.map((a) => ({
      aid: a.aid,
      displayName: a.displayName,
      handshakeEndpoint: a.handshakeEndpoint,
      offeredCaps: a.offeredCaps,
      status: a.status,
      namespace: a.namespace,
      registeredAt: a.registeredAt,
      lastEnrolledAt: a.lastEnrolledAt,
      lastSeenAt: a.lastSeenAt,
      // CP's stored copy — always available, may be up to manifest TTL stale.
      manifestUrl: `/api/registry/agents/${encodeURIComponent(a.aid)}/manifest`,
      // Agent's own endpoint — always fresh if the agent is reachable.
      agentManifestHint: deriveAgentManifestHint(a.handshakeEndpoint),
      // Inline ManifestEnvelope so a discovering peer can verify locally
      // without a second HTTP round-trip per result.
      manifestJson: includeManifest ? a.manifestJson : undefined,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  const body = await req.text();

  return withIdempotency(req, 'agents.register', async () => {
    let envelope: ManifestEnvelope;
    try {
      envelope = JSON.parse(body) as ManifestEnvelope;
    } catch {
      return {
        status: 400,
        body: { error: 'request body must be JSON ManifestEnvelope', code: 'BODY_INVALID' },
      };
    }
    const manifest = envelope.manifest;
    if (!manifest?.aid) {
      return {
        status: 400,
        body: { error: 'missing manifest.aid', code: 'BODY_INVALID' },
      };
    }

    let tokenPayload;
    try {
      tokenPayload = getEnrollmentService().validateToken(token, manifest.aid);
    } catch (err) {
      return {
        status: 401,
        body: {
          error: err instanceof Error ? err.message : String(err),
          code: 'TOKEN_INVALID',
        },
      };
    }

    // One-time-token enforcement: atomically consume the jti. A second
    // presentation of the same (still-valid) token is a replay — reject
    // it so a captured token can't resurrect a deregistered agent or
    // overwrite a registration after the operator changed it.
    const firstUse = await consumeEnrollmentJti(tokenPayload.jti, tokenPayload.exp);
    if (!firstUse) {
      return {
        status: 401,
        body: {
          error: 'enrollment token already used',
          code: 'TOKEN_REPLAYED',
        },
      };
    }

    if (manifest.expires_at) {
      const expiresMs = manifest.expires_at * 1000;
      if (expiresMs < Date.now() + REGISTRATION_EXPIRY_GUARD_MS) {
        return {
          status: 400,
          body: {
            error:
              'manifest expires_at is in the past or within 5 minutes — re-issue with a longer TTL',
            code: 'MANIFEST_EXPIRED',
          },
        };
      }
    }

    const headerNamespace = req.headers.get('x-aitp-namespace');
    const extNamespace = manifest.extensions?.namespace;
    if (extNamespace !== undefined && typeof extNamespace !== 'string') {
      return {
        status: 400,
        body: {
          error: 'manifest.extensions.namespace must be a string when present',
          code: 'BODY_INVALID',
        },
      };
    }
    const namespace =
      headerNamespace ?? (typeof extNamespace === 'string' ? extNamespace : undefined);

    await upsertAgent({
      aid: manifest.aid,
      displayName: manifest.display_name ?? manifest.aid,
      handshakeEndpoint: manifest.handshake_endpoint,
      offeredCaps: manifest.offered_capabilities ?? [],
      manifestJson: body,
      manifestExpiresAt: manifest.expires_at
        ? new Date(manifest.expires_at * 1000).toISOString()
        : null,
      namespace,
    });

    const event: AuditEventRecord = {
      id: randomUUID(),
      type: 'agent.registered',
      ts: new Date().toISOString(),
      aidA: manifest.aid,
      payload: {
        displayName: manifest.display_name ?? manifest.aid,
        namespace: namespace ?? 'default',
      },
      source: 'cp',
    };
    await ingestOneEvent(event);
    eventBus.publish(event);
    void dispatchWebhooks(event).catch((err) =>
      logger.warn({ err, aid: manifest.aid }, 'agent.registered webhook dispatch failed'),
    );
    await writeAdminAudit({
      action: 'agent.register',
      targetId: manifest.aid,
      requestId: req.headers.get('x-request-id') ?? undefined,
    });

    return {
      status: 201,
      body: {
        aid: manifest.aid,
        displayName: manifest.display_name ?? manifest.aid,
        registeredAt: new Date().toISOString(),
      },
    };
  });
}
