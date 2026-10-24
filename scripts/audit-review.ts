/**
 * audit-review: a read-only review of what changed on a control plane over a
 * date range, for attributing traffic and spotting abuse (H0.2).
 *
 *   DATABASE_URL=... npx tsx scripts/audit-review.ts --since 2026-05-23 \
 *     [--until 2026-10-24] [--known-actors 'key:console,key:ops-*'] \
 *     [--page-size 500] [--max-rows 200] [--json] [--dry-run]
 *
 * The connection string is read from AUDIT_REVIEW_DATABASE_URL, else
 * DATABASE_URL, never from argv (argv is visible in `ps`). It is never printed.
 *
 * READ-ONLY. The session opens with default_transaction_read_only=on, runs in
 * one REPEATABLE READ READ ONLY transaction that is always rolled back, and
 * every query passes `assertSelectOnly` (src/lib/audit-review.ts). `--dry-run`
 * is accepted for symmetry with other handoff scripts; the script never writes
 * either way. Point it at a read-only role when one exists.
 *
 * What it reports:
 *   - which attribution fields exist and how often they are populated (key
 *     label = admin_audit_log.actor_id, source IP = details.client_ip, request
 *     id), instead of failing when one is missing;
 *   - admin_audit_log rows grouped by key label, route, source IP and outcome
 *     (paginated by keyset), with every mutation whose actor is not on
 *     --known-actors listed as flagged;
 *   - telemetry ingested via POST /api/events, by type and source;
 *   - cross-checks from the state tables: agents registered or re-enrolled,
 *     webhooks created, revocations, enrollment tokens spent, trust anchors and
 *     pinned keys added in the range. These catch mutations made before the
 *     admin log recorded an actor, or whose log rows were swept by retention.
 */
import pg from 'pg';
import {
  AdminAuditAggregator,
  assertSelectOnly,
  parseArgs,
  REVIEW_TABLES,
  redactUrl,
  safeDetails,
  SQL,
  truncate,
  TXN,
  type AdminAuditRow,
  type CliArgs,
} from '../src/lib/audit-review';

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`audit-review: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const connectionString =
    process.env.AUDIT_REVIEW_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write('audit-review: set AUDIT_REVIEW_DATABASE_URL or DATABASE_URL\n');
    process.exit(2);
  }

  const client = new pg.Client({
    connectionString,
    options: '-c default_transaction_read_only=on -c statement_timeout=120000',
    application_name: 'aitp-audit-review',
  });

  // The only two paths to the database: q() for SELECTs, txn() for TXN.
  const q = async <T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> => {
    assertSelectOnly(sql);
    const res = await client.query(sql, params);
    return res.rows as T[];
  };
  const txn = async (stmt: (typeof TXN)[keyof typeof TXN]): Promise<void> => {
    if (stmt !== TXN.begin && stmt !== TXN.end) throw new Error('not a TXN statement');
    await client.query(stmt);
  };

  const out: string[] = [];
  const line = (s = '') => out.push(s);
  const json: Record<string, unknown> = { since: args.since, until: args.until };

  await client.connect();
  try {
    await txn(TXN.begin);
    const [ro] = await q<{ ro: string }>(SQL.readOnlyCheck);
    if (ro?.ro !== 'on') throw new Error('session is not read-only; refusing to continue');

    // ── Field availability ─────────────────────────────────────────────
    const cols = await q<{ table_name: string; column_name: string }>(SQL.columns, [
      [...REVIEW_TABLES],
    ]);
    const has = new Map<string, Set<string>>();
    for (const c of cols) {
      if (!has.has(c.table_name)) has.set(c.table_name, new Set());
      has.get(c.table_name)!.add(c.column_name);
    }
    const present = (t: string) => has.has(t);
    const missing = REVIEW_TABLES.filter((t) => !present(t));

    line(`# audit-review ${args.since} .. ${args.until}`);
    line();
    line('Read-only: session default_transaction_read_only=on, READ ONLY transaction, rolled back.');
    line();
    line('## Fields available');
    line();
    line(`- tables present: ${REVIEW_TABLES.filter(present).join(', ') || '(none)'}`);
    if (missing.length) line(`- tables MISSING (skipped): ${missing.join(', ')}`);
    const aal = has.get('admin_audit_log') ?? new Set<string>();
    line(`- key label: ${aal.has('actor_id') ? 'admin_audit_log.actor_id' : 'NOT AVAILABLE'}`);
    line(`- source IP: ${aal.has('details') ? "admin_audit_log.details->>'client_ip' (only rows written after per-consumer keys shipped)" : 'NOT AVAILABLE'}`);
    line(`- request id: ${aal.has('request_id') ? 'admin_audit_log.request_id' : 'NOT AVAILABLE'}`);
    line('- outcome: admin_audit_log holds successful mutations only; refused requests (401/4xx) are not stored, see platform request logs');
    line('- audit_events (agent telemetry): no key label or IP column; grouped by type and self-reported source');

    // ── admin_audit_log, paginated ─────────────────────────────────────
    const agg = new AdminAuditAggregator(args.knownActors);
    if (present('admin_audit_log')) {
      const [bounds] = await q(SQL.adminAuditBounds);
      let cursorTs = '-infinity';
      let cursorId = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const page = await q<AdminAuditRow & Row & { cursor_ts: string }>(SQL.adminAuditPage, [
          args.since,
          args.until,
          cursorTs,
          cursorId,
          args.pageSize,
        ]);
        for (const r of page) agg.add(r);
        if (page.length < args.pageSize) break;
        const last = page[page.length - 1]!;
        cursorTs = last.cursor_ts;
        cursorId = last.id;
      }

      line();
      line('## Admin audit log (mutations)');
      line();
      line(`- table holds ${bounds?.n ?? 0} rows overall, ${fmt(bounds?.first)} .. ${fmt(bounds?.last)} (retention: ADMIN_AUDIT_TTL_DAYS, default 365)`);
      line(`- in range: ${agg.total}; with actor ${agg.withActor}; with source IP ${agg.withIp}; with request id ${agg.withRequestId}`);
      line();
      line('### By action / route');
      line();
      line('| action | route | count |');
      line('|---|---|---|');
      for (const a of agg.byAction()) line(`| ${a.action} | ${a.route} | ${a.count} |`);
      line();
      line('### By key label, route, source IP, outcome');
      line();
      line('| key label | route | source IP | outcome | count |');
      line('|---|---|---|---|---|');
      for (const g of agg.grouped()) {
        line(`| ${g.keyLabel} | ${g.route} | ${g.sourceIp} | ${g.outcome} | ${g.count} |`);
      }
      line();
      line(`### Flagged: actor not on --known-actors (${agg.flagged.length})`);
      line();
      if (args.knownActors.length === 0) line('(no --known-actors given, so every mutation is listed)');
      line();
      line('| at | action | actor | target | details |');
      line('|---|---|---|---|---|');
      for (const r of agg.flagged.slice(0, args.maxRows)) {
        line(
          `| ${fmt(r.created_at)} | ${r.action} | ${r.actor_id ?? '(none)'} | ${truncate(r.target_id ?? '', 90)} | ${safeDetails(r)} |`,
        );
      }
      if (agg.flagged.length > args.maxRows) line(`| … | ${agg.flagged.length - args.maxRows} more (raise --max-rows) | | | |`);
      json.adminAudit = {
        total: agg.total,
        byAction: agg.byAction(),
        groups: agg.grouped(),
        flagged: agg.flagged.map((r) => ({
          at: fmt(r.created_at),
          action: r.action,
          actor: r.actor_id,
          target: r.target_id,
          details: safeDetails(r),
        })),
      };
    }

    // ── Telemetry ingest ───────────────────────────────────────────────
    if (present('audit_events')) {
      const [eb] = await q(SQL.eventsBounds);
      const ev = await q<{ type: string; source: string; n: number; first: unknown; last: unknown }>(
        SQL.eventsByType,
        [args.since, args.until],
      );
      line();
      line('## Telemetry ingested (POST /api/events -> audit_events)');
      line();
      line(`- table holds ${eb?.n ?? 0} rows overall, ${fmt(eb?.first)} .. ${fmt(eb?.last)} (retention: AUDIT_EVENTS_TTL_DAYS, default 90; older rows are gone)`);
      line();
      line('| type | source | count | first | last |');
      line('|---|---|---|---|---|');
      for (const e of ev) line(`| ${e.type} | ${truncate(e.source || '(none)', 60)} | ${e.n} | ${fmt(e.first)} | ${fmt(e.last)} |`);
      json.events = ev;
    }

    // ── State-table cross-checks ───────────────────────────────────────
    line();
    line('## State tables: rows created in range');

    if (present('agents')) {
      const agents: Row[] = [];
      for (let offset = 0; ; offset += args.pageSize) {
        const page = await q(SQL.agentsPage, [args.since, args.until, offset, args.pageSize]);
        agents.push(...page);
        if (page.length < args.pageSize) break;
      }
      line();
      line(`### Agents registered or re-enrolled (${agents.length}; expired agents are swept after EXPIRED_AGENT_GRACE_DAYS)`);
      line();
      line('| aid | name | namespace | org | status | endpoint host | registered | last enrolled |');
      line('|---|---|---|---|---|---|---|---|');
      for (const a of agents.slice(0, args.maxRows)) {
        line(
          `| ${truncate(String(a.aid), 70)} | ${truncate(String(a.display_name ?? ''), 40)} | ${a.namespace ?? ''} | ${a.org ?? ''} | ${a.status} | ${hostOf(a.handshake_endpoint)} | ${fmt(a.registered_at)} | ${fmt(a.last_enrolled_at)} |`,
        );
      }
      if (agents.length > args.maxRows) line(`| … ${agents.length - args.maxRows} more | | | | | | | |`);
      json.agents = agents.map((a) => ({
        aid: a.aid,
        name: a.display_name,
        namespace: a.namespace,
        org: a.org,
        status: a.status,
        endpointHost: hostOf(a.handshake_endpoint),
        registeredAt: fmt(a.registered_at),
        lastEnrolledAt: fmt(a.last_enrolled_at),
      }));
    }

    if (present('webhooks')) {
      const [all] = await q(SQL.webhooksAll);
      const hooks = await q(SQL.webhooksInRange, [args.since, args.until]);
      line();
      line(`### Webhooks created (${hooks.length}; ${all?.n ?? 0} exist now, ${all?.active ?? 0} active)`);
      line();
      line('| id | url | events | active | created |');
      line('|---|---|---|---|---|');
      for (const h of hooks) {
        line(`| ${h.id} | ${redactUrl(String(h.url))} | ${(h.events as string[] | null)?.join('|') ?? ''} | ${h.active} | ${fmt(h.created_at)} |`);
      }
      json.webhooks = hooks.map((h) => ({ id: h.id, url: redactUrl(String(h.url)), events: h.events, active: h.active, createdAt: fmt(h.created_at) }));
    }

    if (present('revocation_entries')) {
      const revs = await q(SQL.revocationsInRange, [args.since, args.until]);
      line();
      line(`### Revocations (${revs.length})`);
      line();
      line('| jti | reason | revoked | created |');
      line('|---|---|---|---|');
      for (const r of revs.slice(0, args.maxRows)) line(`| ${r.jti} | ${truncate(String(r.reason ?? ''), 80)} | ${fmt(r.revoked_at)} | ${fmt(r.created_at)} |`);
      json.revocations = revs.map((r) => ({ jti: r.jti, reason: r.reason, createdAt: fmt(r.created_at) }));
    }

    if (present('enrollment_jtis')) {
      const days = await q<{ day: unknown; n: number }>(SQL.enrollmentsByDay, [args.since, args.until]);
      const total = days.reduce((s, d) => s + d.n, 0);
      line();
      line(`### Enrollment tokens spent (${total}; rows are swept once the token expires, so this undercounts)`);
      line();
      for (const d of days) line(`- ${fmt(d.day).slice(0, 10)}: ${d.n}`);
      json.enrollments = { total, byDay: days.map((d) => ({ day: fmt(d.day).slice(0, 10), n: d.n })) };
    }

    if (present('trust_anchors')) {
      const tas = await q(SQL.trustAnchorsInRange, [args.since, args.until]);
      line();
      line(`### Trust anchors added (${tas.length})`);
      for (const t of tas) line(`- ${fmt(t.created_at)} ${t.namespace} ${redactUrl(String(t.issuer_url))} by ${t.added_by ?? '(none)'}`);
      json.trustAnchors = tas.length;
    }

    if (present('pinned_keys')) {
      const pks = await q(SQL.pinnedKeysInRange, [args.since, args.until]);
      line();
      line(`### Pinned keys added (${pks.length})`);
      for (const p of pks) line(`- ${fmt(p.created_at)} ${p.namespace} ${truncate(String(p.aid), 70)} by ${p.added_by ?? '(none)'}`);
      json.pinnedKeys = pks.length;
    }
  } finally {
    await txn(TXN.end).catch(() => undefined);
    await client.end().catch(() => undefined);
  }

  process.stdout.write(args.json ? `${JSON.stringify(json, null, 2)}\n` : `${out.join('\n')}\n`);
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function hostOf(v: unknown): string {
  try {
    return new URL(String(v)).host;
  } catch {
    return '(unparseable)';
  }
}

main().catch((err: unknown) => {
  // The message of a pg error can echo the host but not the password; still,
  // print only the message, never the connection string or a stack with env.
  process.stderr.write(`audit-review: ${(err as Error).message}\n`);
  process.exit(1);
});
