/**
 * Pure half of `scripts/audit-review.ts`: the SQL it may run, the read-only
 * guard, and the aggregation/report logic. No I/O here, so it is unit-testable
 * without a database. See the script header for usage.
 *
 * READ-ONLY CONTRACT. Every statement the script sends is either one of the
 * SELECTs in `SQL` below, checked by `assertSelectOnly` at run time, or one of
 * the transaction-control statements in `TXN` (a READ ONLY transaction that is
 * always rolled back). `src/lib/audit-review.test.ts` greps this file and the
 * script for data-modifying keywords and fails the build if one appears.
 */

/** Keywords that can change data, schema or privileges. Matched whole-word, any case. */
const FORBIDDEN_SQL =
  /\b(insert|update|delete|merge|upsert|drop|alter|truncate|create|grant|revoke|copy|vacuum|reindex|cluster|comment|lock|call|do|execute|prepare|refresh|import|security|nextval|setval|pg_terminate_backend|pg_cancel_backend|set_config|lo_import|lo_export|dblink)\b/i;

export class NotReadOnlyError extends Error {}

/** Throws unless `sql` is a single plain SELECT (or WITH ... SELECT) statement. */
export function assertSelectOnly(sql: string): void {
  const s = sql.trim();
  if (!/^(select|with)\b/i.test(s)) {
    throw new NotReadOnlyError('audit-review only runs SELECT statements');
  }
  if (FORBIDDEN_SQL.test(s)) {
    throw new NotReadOnlyError('audit-review SQL contains a non-read-only keyword');
  }
  // One statement only: a `;` anywhere but the very end could chain another.
  if (s.replace(/;\s*$/, '').includes(';')) {
    throw new NotReadOnlyError('audit-review runs one statement at a time');
  }
}

/**
 * Transaction control. The session is also opened with
 * `default_transaction_read_only=on`, so Postgres itself refuses a write even
 * if one slipped past the guard above.
 */
export const TXN = {
  begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  end: 'ROLLBACK',
} as const;

/** Every query the script runs. `$1`/`$2` are always since/until (ISO strings). */
export const SQL = {
  readOnlyCheck: `SELECT current_setting('transaction_read_only') AS ro`,
  columns: `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
  // Keyset pagination over (created_at, id); $3/$4 are the last row seen.
  // cursor_ts is the full-precision (microsecond) text form: a JS Date keeps
  // only milliseconds, and a truncated cursor would re-read rows.
  adminAuditPage: `SELECT id, action, actor_id, target_id, details, request_id, created_at,
                          created_at::text AS cursor_ts
                   FROM admin_audit_log
                   WHERE created_at >= $1 AND created_at < $2
                     AND (created_at, id) > ($3::timestamptz, $4::uuid)
                   ORDER BY created_at, id
                   LIMIT $5`,
  adminAuditBounds: `SELECT min(created_at) AS first, max(created_at) AS last, count(*)::int AS n
                     FROM admin_audit_log`,
  eventsByType: `SELECT type, coalesce(source, '') AS source, count(*)::int AS n,
                        min(created_at) AS first, max(created_at) AS last
                 FROM audit_events
                 WHERE created_at >= $1 AND created_at < $2
                 GROUP BY type, coalesce(source, '')
                 ORDER BY n DESC`,
  eventsBounds: `SELECT min(created_at) AS first, max(created_at) AS last, count(*)::int AS n
                 FROM audit_events`,
  agentsPage: `SELECT aid, display_name, namespace, status, org, handshake_endpoint,
                      registered_at, last_enrolled_at
               FROM agents
               WHERE (registered_at >= $1 AND registered_at < $2)
                  OR (last_enrolled_at >= $1 AND last_enrolled_at < $2)
               ORDER BY aid
               LIMIT $4 OFFSET $3`,
  webhooksInRange: `SELECT id, url, events, active, created_at FROM webhooks
                    WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at LIMIT 1000`,
  webhooksAll: `SELECT count(*)::int AS n, count(*) FILTER (WHERE active)::int AS active FROM webhooks`,
  revocationsInRange: `SELECT jti, reason, revoked_at, created_at FROM revocation_entries
                       WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at LIMIT 5000`,
  enrollmentsByDay: `SELECT date_trunc('day', created_at) AS day, count(*)::int AS n
                     FROM enrollment_jtis
                     WHERE created_at >= $1 AND created_at < $2
                     GROUP BY 1 ORDER BY 1`,
  trustAnchorsInRange: `SELECT id, namespace, issuer_url, added_by, created_at FROM trust_anchors
                        WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at LIMIT 1000`,
  pinnedKeysInRange: `SELECT namespace, aid, label, added_by, created_at FROM pinned_keys
                      WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at LIMIT 1000`,
} as const;

/** Tables the review reads. Missing ones are reported, not fatal. */
export const REVIEW_TABLES = [
  'admin_audit_log',
  'audit_events',
  'agents',
  'webhooks',
  'revocation_entries',
  'enrollment_jtis',
  'trust_anchors',
  'pinned_keys',
] as const;

/** admin_audit_log.action -> the route that writes it. Every action is a mutation. */
export const ACTION_ROUTES: Record<string, string> = {
  'agent.register': 'POST /api/registry/agents',
  'agent.deregister': 'DELETE /api/registry/agents/:aid',
  'revocation.add': 'POST /api/revocation/entries',
  'webhook.create': 'POST /api/webhooks',
  'webhook.update': 'PATCH /api/webhooks/:id',
  'webhook.delete': 'DELETE /api/webhooks/:id',
  'webhook.circuit-breaker.reset': 'POST /api/webhooks/:id/circuit-breaker/reset',
  'trust-anchor.create': 'POST /api/trust-anchors',
  'trust-anchor.update': 'PATCH /api/trust-anchors/:id',
  'trust-anchor.delete': 'DELETE /api/trust-anchors/:id',
  'pinned-key.upsert': 'POST /api/pinned-keys',
  'pinned-key.delete': 'DELETE /api/pinned-keys',
};

export function routeForAction(action: string): string {
  return ACTION_ROUTES[action] ?? `(unmapped action ${action})`;
}

export interface AdminAuditRow {
  id: string;
  action: string;
  actor_id: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  request_id: string | null;
  created_at: string | Date;
}

export interface Group {
  keyLabel: string;
  route: string;
  sourceIp: string;
  outcome: string;
  count: number;
}

/** The key label from an actor id, or a placeholder saying why there is none. */
export function keyLabelOf(actorId: string | null): string {
  if (!actorId) return '(none recorded)';
  if (actorId.startsWith('key:')) return actorId.slice(4);
  return actorId; // e.g. enrollment-token, or a legacy apikey:<hash>
}

export function sourceIpOf(row: AdminAuditRow): string {
  const ip = row.details?.['client_ip'];
  return typeof ip === 'string' && ip ? ip : '(not recorded)';
}

/**
 * A mutation is attributable when it carries an actor that is on the known
 * list (exact match, or a prefix ending in `*`). Everything else is flagged.
 */
export function isKnownActor(actorId: string | null, known: readonly string[]): boolean {
  if (!actorId) return false;
  return known.some((k) =>
    k.endsWith('*') ? actorId.startsWith(k.slice(0, -1)) : actorId === k,
  );
}

export class AdminAuditAggregator {
  private groups = new Map<string, Group>();
  private actions = new Map<string, number>();
  readonly flagged: AdminAuditRow[] = [];
  total = 0;
  withActor = 0;
  withIp = 0;
  withRequestId = 0;

  constructor(private readonly knownActors: readonly string[]) {}

  add(row: AdminAuditRow): void {
    this.total += 1;
    if (row.actor_id) this.withActor += 1;
    if (sourceIpOf(row) !== '(not recorded)') this.withIp += 1;
    if (row.request_id) this.withRequestId += 1;
    this.actions.set(row.action, (this.actions.get(row.action) ?? 0) + 1);

    // admin_audit_log is written only after a mutation succeeded, so every
    // row's outcome is "success"; refused requests (401/4xx) are not in the DB.
    const g: Omit<Group, 'count'> = {
      keyLabel: keyLabelOf(row.actor_id),
      route: routeForAction(row.action),
      sourceIp: sourceIpOf(row),
      outcome: 'success',
    };
    const k = JSON.stringify(g);
    const cur = this.groups.get(k);
    if (cur) cur.count += 1;
    else this.groups.set(k, { ...g, count: 1 });

    if (!isKnownActor(row.actor_id, this.knownActors)) this.flagged.push(row);
  }

  byAction(): Array<{ action: string; route: string; count: number }> {
    return [...this.actions.entries()]
      .map(([action, count]) => ({ action, route: routeForAction(action), count }))
      .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));
  }

  grouped(): Group[] {
    return [...this.groups.values()].sort(
      (a, b) => b.count - a.count || a.route.localeCompare(b.route),
    );
  }
}

/**
 * Only the fields of `details` that are safe to print. A webhook URL is cut
 * to scheme://host/path (a query string can carry a token); secrets are never
 * in details (migration 0008 scrubbed the last place they were).
 */
export function safeDetails(row: AdminAuditRow): string {
  const d = row.details ?? {};
  const parts: string[] = [];
  if (typeof d['url'] === 'string') parts.push(`url=${redactUrl(d['url'])}`);
  if (Array.isArray(d['events'])) parts.push(`events=${(d['events'] as unknown[]).join('|')}`);
  if (typeof d['reason'] === 'string') parts.push(`reason=${truncate(d['reason'], 80)}`);
  for (const k of ['namespace', 'aid', 'issuerUrl', 'issuer_url', 'label']) {
    if (typeof d[k] === 'string') parts.push(`${k}=${truncate(d[k] as string, 120)}`);
  }
  return parts.join(' ');
}

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?<redacted>' : ''}`;
  } catch {
    return '(unparseable url)';
  }
}

export function truncate(s: string, n: number): string {
  const flat = s.replace(/[\r\n\t]+/g, ' ');
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

export interface CliArgs {
  since: string;
  until: string;
  pageSize: number;
  knownActors: string[];
  maxRows: number;
  json: boolean;
}

/** Parse argv. Dates are validated and normalised to ISO; `--dry-run` is accepted (always read-only). */
export function parseArgs(argv: readonly string[], now = new Date()): CliArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    return eq ? eq.slice(name.length + 1) : undefined;
  };
  const since = get('--since');
  if (!since) throw new Error('--since <date> is required (e.g. --since 2026-05-23)');
  const toIso = (v: string, flag: string): string => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`${flag}: not a date: ${v}`);
    return d.toISOString();
  };
  const pageSize = Number(get('--page-size') ?? 500);
  const maxRows = Number(get('--max-rows') ?? 200);
  return {
    since: toIso(since, '--since'),
    until: toIso(get('--until') ?? now.toISOString(), '--until'),
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 5000) : 500,
    knownActors: (get('--known-actors') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxRows: Number.isFinite(maxRows) && maxRows >= 0 ? maxRows : 200,
    json: argv.includes('--json'),
  };
}
