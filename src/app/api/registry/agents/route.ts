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

    // Hoisted deliberately OUT of the try below, exactly as
    // src/app/api/registry/enroll/route.ts does for the same reason.
    // `getEnrollmentService()` constructs `EnrollmentService`, whose
    // constructor throws when ENROLLMENT_SECRET is unset or shorter than 32
    // chars — a server fault, not a problem with the caller's token. Fused
    // into the try below it was caught by the same catch-all and answered
    // `401 TOKEN_INVALID` **with the raw error message in the body**, which
    // told every agent in the fleet "your token is bad" about a token that was
    // fine, and published the name of the missing environment variable to an
    // unauthenticated caller (this route is in src/proxy.ts's PUBLIC_PATHS).
    // Hoisting also states the precedence in the control flow: a server that
    // cannot verify any token has no business judging this one.
    //
    // This catch is safe to keep this narrow ONLY because that constructor has
    // exactly two throw sites and no other statement in it can fail. The same
    // caveat now extends one frame further: `validateToken`/`verify` throw
    // deliberate caller-facing messages that the 401 below echoes on purpose,
    // so a NON-caller throw added to either re-opens this exact defect on the
    // 401 path, one frame down. (`createHmac` in `verify` is already such a
    // site in principle — accepted, because it leaks no configuration and has
    // no realistic trigger. See issue #91.) If either changes, this guard must
    // be re-thought, not merely re-pointed.
    let service;
    try {
      service = getEnrollmentService();
    } catch {
      // 503 + SERVER_MISCONFIGURED matches src/proxy.ts's existing precedent
      // for a missing required secret, and docs/api.md already lists 503 as
      // "misconfigured / draining". Two deliberate divergences from that
      // precedent, both inherited from the enroll route: the message is fixed
      // rather than naming the env var (the caller cannot act on it either
      // way, and the catch binds no error variable, so leaking it is
      // impossible by construction rather than by remembering to redact), and
      // the guard is UNCONDITIONAL rather than production-only — nothing
      // validates this secret at startup and a server without it cannot
      // register anyone in any environment.
      //
      // Deliberately INSIDE the withIdempotency callback, which is where this
      // differs from enroll. Placing it here keeps both `400 BODY_INVALID`
      // pre-validations above (the JSON parse and the manifest.aid check)
      // ahead of it, so a misconfigured server never masks a genuinely
      // malformed request — the precedence enroll pins in its own tests. The
      // route's later 400s (MANIFEST_EXPIRED, the namespace check) sit behind
      // this guard, as they sat behind the throw before it existed. Hoisting
      // out of the callback would invert that ordering, and moving the
      // pre-validation out with it would stop persisting `400 BODY_INVALID`
      // against an idempotency key, since 400 *is* cacheable. A 503 is not
      // (see CACHEABLE_STATUSES in src/lib/idempotency.ts), so a transient
      // misconfiguration cannot be pinned to a key for its TTL.
      return {
        status: 503,
        body: {
          error: 'agent registration is temporarily unavailable on this server',
          code: 'SERVER_MISCONFIGURED',
        },
      };
    }

    let tokenPayload;
    try {
      tokenPayload = service.validateToken(token, manifest.aid);
    } catch (err) {
      // `err.message` is echoed on purpose: every message reachable here is
      // deliberate caller-facing text about a credential the caller supplied
      // and can fix (wrong scope, expired, sub/aid mismatch, missing jti,
      // malformed, bad signature, unparseable payload). Redacting them would
      // remove the caller's only signal about why their token failed, to solve
      // a leak that — since the hoist above — no longer reaches this path.
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
