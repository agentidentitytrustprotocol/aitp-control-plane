import { NextRequest } from 'next/server';
import { getEnrollmentService } from '@/lib/registry/enrollment';
import { listAgents, upsertAgent } from '@/lib/registry/store';
import { ingestOneEvent } from '@/lib/audit/event-store';
import { eventBus, type AuditEventRecord } from '@/lib/audit/stream';
import { writeAdminAudit } from '@/lib/audit-log/service';
import { dispatchWebhooks } from '@/lib/webhooks/service';
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

function deriveAgentManifestHint(handshakeEndpoint: string): string | null {
  try {
    const url = new URL(handshakeEndpoint);
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

  const results = await listAgents({
    capability,
    aid,
    displayName,
    namespace,
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
  let envelope: ManifestEnvelope;
  try {
    envelope = JSON.parse(body) as ManifestEnvelope;
  } catch {
    return Response.json(
      { error: 'request body must be JSON ManifestEnvelope', code: 'BODY_INVALID' },
      { status: 400 },
    );
  }
  const manifest = envelope.manifest;
  if (!manifest?.aid) {
    return Response.json(
      { error: 'missing manifest.aid', code: 'BODY_INVALID' },
      { status: 400 },
    );
  }

  try {
    getEnrollmentService().validateToken(token, manifest.aid);
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err),
        code: 'TOKEN_INVALID',
      },
      { status: 401 },
    );
  }

  // Reject any manifest that has already expired or expires within
  // 5 minutes. Without this, a borderline manifest enters the registry
  // and is then silently hidden from discovery (manifest-expired filter
  // in listAgents) — frustrating to debug.
  if (manifest.expires_at) {
    const expiresMs = manifest.expires_at * 1000;
    if (expiresMs < Date.now() + REGISTRATION_EXPIRY_GUARD_MS) {
      return Response.json(
        {
          error:
            'manifest expires_at is in the past or within 5 minutes — re-issue with a longer TTL',
          code: 'MANIFEST_EXPIRED',
        },
        { status: 400 },
      );
    }
  }

  const headerNamespace = req.headers.get('x-aitp-namespace');
  const extNamespace = manifest.extensions?.namespace;
  if (extNamespace !== undefined && typeof extNamespace !== 'string') {
    return Response.json(
      {
        error:
          'manifest.extensions.namespace must be a string when present',
        code: 'BODY_INVALID',
      },
      { status: 400 },
    );
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
    console.warn('[webhooks] agent.registered dispatch failed:', err),
  );
  await writeAdminAudit({
    action: 'agent.register',
    targetId: manifest.aid,
    requestId: req.headers.get('x-request-id') ?? undefined,
  });

  return Response.json(
    {
      aid: manifest.aid,
      displayName: manifest.display_name ?? manifest.aid,
      registeredAt: new Date().toISOString(),
    },
    { status: 201 },
  );
}
