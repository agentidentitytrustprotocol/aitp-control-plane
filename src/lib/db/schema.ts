import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// ── Agent Registry ─────────────────────────────────────────────────────────

export const agents = pgTable(
  'agents',
  {
    aid: varchar('aid', { length: 512 }).primaryKey(),
    displayName: varchar('display_name', { length: 256 }).notNull(),
    handshakeEndpoint: text('handshake_endpoint').notNull(),
    offeredCaps: jsonb('offered_caps').$type<string[]>().notNull().default([]),
    manifestJson: text('manifest_json').notNull(),
    manifestExpiresAt: timestamp('manifest_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    // Allowed status values: 'active' | 'expired' | 'deregistered'.
    // 'inactive' is a legacy synonym for 'deregistered' — migration 0001
    // backfills any pre-v0.2.0 rows.
    status: varchar('status', { length: 32 }).notNull().default('active'),
    registeredAt: timestamp('registered_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
    // Updated by `upsertAgent` on every register/re-register. Distinct
    // from `registeredAt` (set once at first enrollment).
    lastEnrolledAt: timestamp('last_enrolled_at', {
      withTimezone: true,
      mode: 'string',
    }),
    lastSeenAt: timestamp('last_seen_at', {
      withTimezone: true,
      mode: 'string',
    }),
    org: varchar('org', { length: 128 }),
    cloud: varchar('cloud', { length: 128 }),
    // Tenant / environment scope — 'production' | 'staging' | 'default' | etc.
    // Discovery queries without `?namespace=` return rows across all scopes
    // (backward compatible). Scoped queries pass `?namespace=production`.
    namespace: varchar('namespace', { length: 128 })
      .notNull()
      .default('default'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (t) => ({
    statusIdx: index('agents_status_idx').on(t.status),
    registeredIdx: index('agents_registered_at_idx').on(t.registeredAt),
    namespaceIdx: index('agents_namespace_idx').on(t.namespace),
    // GIN over jsonb so capability discovery (offered_caps @> '["x"]')
    // doesn't scan the whole table once the registry has 1k+ agents.
    offeredCapsGin: index('agents_offered_caps_gin')
      .using('gin', t.offeredCaps),
  }),
);

// ── Handshake Sessions ─────────────────────────────────────────────────────

export const handshakeSessions = pgTable(
  'handshake_sessions',
  {
    sessionId: varchar('session_id', { length: 255 }).primaryKey(),
    aidA: varchar('aid_a', { length: 512 }),
    aidB: varchar('aid_b', { length: 512 }),
    status: varchar('status', { length: 32 }).notNull().default('started'),
    grants: jsonb('grants').$type<string[]>().notNull().default([]),
    runId: varchar('run_id', { length: 255 }),
    boundary: varchar('boundary', { length: 32 }),
    error: text('error'),
    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'string',
    }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index('sessions_status_idx').on(t.status),
    aidAIdx: index('sessions_aid_a_idx').on(t.aidA),
    aidBIdx: index('sessions_aid_b_idx').on(t.aidB),
    runIdx: index('sessions_run_id_idx').on(t.runId),
  }),
);

// ── Audit Events ───────────────────────────────────────────────────────────

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    type: varchar('type', { length: 128 }).notNull(),
    ts: timestamp('ts', { withTimezone: true, mode: 'string' }).notNull(),
    aidA: varchar('aid_a', { length: 512 }),
    aidB: varchar('aid_b', { length: 512 }),
    sessionId: varchar('session_id', { length: 255 }),
    runId: varchar('run_id', { length: 255 }),
    grants: jsonb('grants').$type<string[]>(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    source: varchar('source', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    typeIdx: index('audit_events_type_idx').on(t.type),
    tsIdx: index('audit_events_ts_idx').on(t.ts),
    sessionIdx: index('audit_events_session_idx').on(t.sessionId),
    runIdx: index('audit_events_run_id_idx').on(t.runId),
    aidAIdx: index('audit_events_aid_a_idx').on(t.aidA),
  }),
);

// ── Revocation (CP's own issued TCTs) ──────────────────────────────────────

export const revocationEntries = pgTable('revocation_entries', {
  jti: uuid('jti').primaryKey(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

// ── Webhooks (HMAC-SHA256, outbox pattern) ─────────────────────────────────

export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey(),
    url: text('url').notNull(),
    events: jsonb('events').$type<string[]>().notNull().default([]),
    secret: varchar('secret', { length: 255 }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ activeIdx: index('webhooks_active_idx').on(t.active) }),
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 128 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    // Canonical body bytes signed and POSTed to the receiver. Populated
    // ONCE at enqueue time so a retry sends byte-identical bytes — and
    // therefore the same HMAC signature — as the first attempt. Nullable
    // for backward-compat with rows enqueued before this column existed.
    body: text('body'),
    // HMAC-SHA256 hex digest (64 chars) of `body` under the webhook's
    // secret at enqueue time. If the secret is later rotated, in-flight
    // deliveries keep using their original signature.
    signature: varchar('signature', { length: 64 }),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    statusCode: integer('status_code'),
    error: text('error'),
    deliveredAt: timestamp('delivered_at', {
      withTimezone: true,
      mode: 'string',
    }),
    nextRetryAt: timestamp('next_retry_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    webhookIdx: index('webhook_deliveries_webhook_idx').on(t.webhookId),
    statusIdx: index('webhook_deliveries_status_idx').on(t.status),
  }),
);

// ── Admin Audit Log ────────────────────────────────────────────────────────

export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').primaryKey(),
    action: varchar('action', { length: 128 }).notNull(),
    actorId: varchar('actor_id', { length: 255 }),
    targetId: varchar('target_id', { length: 512 }),
    details: jsonb('details').$type<Record<string, unknown>>().default({}),
    requestId: varchar('request_id', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    createdIdx: index('admin_audit_created_idx').on(t.createdAt),
    actorIdx: index('admin_audit_actor_idx').on(t.actorId),
  }),
);

// ── Issued TCTs (RFC-AITP-0005) ───────────────────────────────────────
//
// The CP observes; it does not issue TCTs. Rows here are derived from
// `tct.issued` events reported by agents at handshake completion, so
// operators can answer "who currently holds a valid grant to call
// <capability> on <aid>?" without spelunking event payloads.
//
// `revoked` is mirrored from `revocation_entries` whenever a JTI is
// added there; both tables stay queryable independently.

export const issuedTcts = pgTable(
  'issued_tcts',
  {
    jti: uuid('jti').primaryKey(),
    issuerAid: varchar('issuer_aid', { length: 512 }).notNull(),
    subjectAid: varchar('subject_aid', { length: 512 }).notNull(),
    audienceAid: varchar('audience_aid', { length: 512 }).notNull(),
    grants: jsonb('grants').$type<string[]>().notNull().default([]),
    bindingCnf: varchar('binding_cnf', { length: 128 }),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    sessionId: varchar('session_id', { length: 255 }),
    revoked: boolean('revoked').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    issuerIdx: index('issued_tcts_issuer_idx').on(t.issuerAid),
    subjectIdx: index('issued_tcts_subject_idx').on(t.subjectAid),
    audienceIdx: index('issued_tcts_audience_idx').on(t.audienceAid),
    sessionIdx: index('issued_tcts_session_idx').on(t.sessionId),
    grantsGin: index('issued_tcts_grants_gin').using('gin', t.grants),
  }),
);

// ── Delegation chains (RFC-AITP-0006 single-hop; 0011 multi-hop draft) ─
//
// A delegation is a parent → child TCT relationship. Walking the chain
// from a root parent_jti yields the descendant tree. Revoking a parent
// can therefore cascade-mark the children (`revoked` column) without
// touching `issued_tcts`.

export const delegations = pgTable(
  'delegations',
  {
    jti: uuid('jti').primaryKey(),
    parentJti: uuid('parent_jti').notNull(),
    delegatorAid: varchar('delegator_aid', { length: 512 }).notNull(),
    delegateeAid: varchar('delegatee_aid', { length: 512 }).notNull(),
    scope: jsonb('scope').$type<string[]>().notNull().default([]),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    revoked: boolean('revoked').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    revokedReason: varchar('revoked_reason', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    parentIdx: index('delegations_parent_idx').on(t.parentJti),
    delegatorIdx: index('delegations_delegator_idx').on(t.delegatorAid),
    delegateeIdx: index('delegations_delegatee_idx').on(t.delegateeAid),
  }),
);

// ── OIDC trust anchors (RFC-AITP-0002 OIDC identity mode) ─────────────
//
// Org-scoped allowlist of trusted OIDC issuers. Agents in a namespace
// can fetch this list at boot to bootstrap their JwksResolver config
// instead of each one shipping its own static config.

export const trustAnchors = pgTable(
  'trust_anchors',
  {
    id: uuid('id').primaryKey(),
    namespace: varchar('namespace', { length: 128 }).notNull().default('default'),
    issuerUrl: text('issuer_url').notNull(),
    // Optional override of the issuer's own jwks_uri (well-known
    // OIDC discovery normally resolves this).
    jwksUrl: text('jwks_url'),
    // Most-recently cached JWKS keyset (helpful for clients that can't
    // reach the issuer themselves). Refreshed by the CP periodically.
    jwksCache: jsonb('jwks_cache').$type<Record<string, unknown> | null>(),
    jwksCachedAt: timestamp('jwks_cached_at', {
      withTimezone: true,
      mode: 'string',
    }),
    label: varchar('label', { length: 128 }),
    addedBy: varchar('added_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    namespaceIdx: index('trust_anchors_namespace_idx').on(t.namespace),
    // (namespace, issuer_url) must be unique. The POST handler does a
    // check-then-insert that is racy under concurrent admins; the DB
    // is the only place that can enforce this without a write lock.
    namespaceIssuerUnique: uniqueIndex(
      'trust_anchors_namespace_issuer_uniq',
    ).on(t.namespace, t.issuerUrl),
  }),
);

// ── Pinned-key allowlist (RFC-AITP-0002 pinned-key identity mode) ──────
//
// Org-managed set of (namespace, aid → public-key) pairs. Agents in
// pinned-key mode fetch this list at boot rather than maintaining
// per-agent trust stores.

export const pinnedKeys = pgTable(
  'pinned_keys',
  {
    namespace: varchar('namespace', { length: 128 }).notNull().default('default'),
    aid: varchar('aid', { length: 512 }).notNull(),
    pubkey: varchar('pubkey', { length: 128 }).notNull(),
    label: varchar('label', { length: 128 }),
    addedBy: varchar('added_by', { length: 255 }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.namespace, t.aid] }),
    aidIdx: index('pinned_keys_aid_idx').on(t.aid),
  }),
);

// ── Idempotency keys (Idempotency-Key header support) ─────────────────
//
// Stores the response of a mutating request keyed by (scope, key) so a
// client that retries the same request receives the same response
// instead of producing duplicate side effects. Rows are aged out by the
// retention sweep.

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: varchar('scope', { length: 64 }).notNull(),
    key: varchar('key', { length: 255 }).notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scope, t.key] }),
    createdIdx: index('idempotency_keys_created_at_idx').on(t.createdAt),
  }),
);

// ── Consumed enrollment token JTIs (one-time-token enforcement) ───────
//
// Enrollment tokens are short-lived HMAC bearer credentials minted by
// POST /api/registry/enroll and spent by POST /api/registry/agents. To
// make them genuinely one-time, the register handler atomically inserts
// the token's `jti` here; a second insert of the same jti conflicts and
// the replay is rejected. Rows are aged out by the retention sweep once
// past `expires_at` (the token can't be replayed after it expires
// anyway, so the row is only needed for the token's lifetime).

export const enrollmentJtis = pgTable(
  'enrollment_jtis',
  {
    jti: varchar('jti', { length: 64 }).primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    expiresIdx: index('enrollment_jtis_expires_at_idx').on(t.expiresAt),
  }),
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type HandshakeSession = typeof handshakeSessions.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type RevocationEntry = typeof revocationEntries.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type AdminAuditRow = typeof adminAuditLog.$inferSelect;
export type IssuedTct = typeof issuedTcts.$inferSelect;
export type NewIssuedTct = typeof issuedTcts.$inferInsert;
export type Delegation = typeof delegations.$inferSelect;
export type NewDelegation = typeof delegations.$inferInsert;
export type TrustAnchor = typeof trustAnchors.$inferSelect;
export type NewTrustAnchor = typeof trustAnchors.$inferInsert;
export type PinnedKey = typeof pinnedKeys.$inferSelect;
export type NewPinnedKey = typeof pinnedKeys.$inferInsert;
