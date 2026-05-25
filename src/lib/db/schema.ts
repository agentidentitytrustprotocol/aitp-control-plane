import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type HandshakeSession = typeof handshakeSessions.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type RevocationEntry = typeof revocationEntries.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type AdminAuditRow = typeof adminAuditLog.$inferSelect;
