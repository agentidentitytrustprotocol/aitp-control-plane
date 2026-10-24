import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdminAuditAggregator,
  assertSelectOnly,
  isKnownActor,
  keyLabelOf,
  NotReadOnlyError,
  parseArgs,
  redactUrl,
  routeForAction,
  SQL,
  TXN,
  type AdminAuditRow,
} from './audit-review';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'audit-review.ts'), 'utf8');
const LIB = readFileSync(join(__dirname, 'audit-review.ts'), 'utf8');

describe('audit-review is SELECT-only (H0.2 acceptance 2)', () => {
  // The grep half: no data-modifying SQL keyword appears anywhere in either
  // file, in SQL's conventional upper case. (The guard's own pattern is lower
  // case, action names such as `webhook.update` are lower case, and an HTTP
  // method in a route label, `DELETE /api/...`, is excluded by the lookahead.)
  it.each([
    ['scripts/audit-review.ts', SCRIPT],
    ['src/lib/audit-review.ts', LIB],
  ])('%s contains no data-modifying SQL keyword', (_name, src) => {
    expect(src).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|LOCK|CALL|EXECUTE)\b(?! \/api\/)/,
    );
  });

  it('every registered query is a single SELECT', () => {
    for (const [name, sql] of Object.entries(SQL)) {
      expect(() => assertSelectOnly(sql)).not.toThrow();
      expect(sql.trim()).toMatch(/^SELECT\b/);
      expect(name).toBeTruthy();
    }
  });

  it('the only non-SELECT statements are a READ ONLY begin and a rollback', () => {
    expect(TXN).toEqual({
      begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      end: 'ROLLBACK',
    });
  });

  it('the script reaches the database only through the guarded q() and txn() helpers', () => {
    const calls = SCRIPT.match(/\.query\(/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(SCRIPT).toMatch(/assertSelectOnly\(sql\);\s*const res = await client\.query\(sql, params\)/);
    expect(SCRIPT).toMatch(/default_transaction_read_only=on/);
    // Every q() call passes a registered SQL.<name>, never an inline string.
    const qCalls = SCRIPT.match(/await q(<[^>]*>)?\(([^,)]+)/g) ?? [];
    expect(qCalls.length).toBeGreaterThan(5);
    for (const c of qCalls) expect(c).toMatch(/\(\s*SQL\.[A-Za-z]+$/);
  });

  it('assertSelectOnly rejects writes, chained statements and data-modifying CTEs', () => {
    const bad = [
      'DELETE FROM webhooks',
      'update agents set status = 1',
      'insert into x values (1)',
      'SELECT 1; DROP TABLE agents',
      'WITH d AS (DELETE FROM webhooks RETURNING *) SELECT * FROM d',
      'SELECT set_config(\'x\', \'y\', false)',
      'TRUNCATE admin_audit_log',
      'SELECT nextval(\'s\')',
    ];
    for (const sql of bad) expect(() => assertSelectOnly(sql)).toThrow(NotReadOnlyError);
  });
});

function row(p: Partial<AdminAuditRow>): AdminAuditRow {
  return {
    id: 'id',
    action: 'webhook.create',
    actor_id: null,
    target_id: null,
    details: {},
    request_id: null,
    created_at: '2026-06-01T00:00:00Z',
    ...p,
  };
}

describe('AdminAuditAggregator', () => {
  it('groups by key label, route, source IP and outcome, and flags unknown actors', () => {
    const agg = new AdminAuditAggregator(['key:console', 'key:ops-*']);
    agg.add(row({ actor_id: 'key:console', details: { client_ip: '198.51.100.1' } }));
    agg.add(row({ actor_id: 'key:console', details: { client_ip: '198.51.100.1' } }));
    agg.add(row({ actor_id: 'key:ops-alice', action: 'revocation.add' }));
    agg.add(row({ actor_id: null, action: 'agent.register' }));
    agg.add(row({ actor_id: 'key:unlabelled-1', action: 'webhook.delete', request_id: 'r' }));

    expect(agg.total).toBe(5);
    expect(agg.withActor).toBe(4);
    expect(agg.withIp).toBe(2);
    expect(agg.withRequestId).toBe(1);
    expect(agg.grouped()[0]).toEqual({
      keyLabel: 'console',
      route: 'POST /api/webhooks',
      sourceIp: '198.51.100.1',
      outcome: 'success',
      count: 2,
    });
    expect(agg.flagged.map((r) => r.action)).toEqual(['agent.register', 'webhook.delete']);
    expect(agg.byAction().find((a) => a.action === 'revocation.add')).toEqual({
      action: 'revocation.add',
      route: 'POST /api/revocation/entries',
      count: 1,
    });
  });

  it('reports missing fields as placeholders instead of failing', () => {
    expect(keyLabelOf(null)).toBe('(none recorded)');
    expect(keyLabelOf('key:console')).toBe('console');
    expect(keyLabelOf('enrollment-token')).toBe('enrollment-token');
    expect(routeForAction('something.new')).toBe('(unmapped action something.new)');
    const agg = new AdminAuditAggregator([]);
    agg.add(row({ details: null }));
    expect(agg.grouped()[0]!.sourceIp).toBe('(not recorded)');
  });

  it('isKnownActor matches exact ids and trailing-* prefixes only', () => {
    expect(isKnownActor('key:ops-bob', ['key:ops-*'])).toBe(true);
    expect(isKnownActor('key:opsx', ['key:ops-*'])).toBe(false);
    expect(isKnownActor(null, ['*'])).toBe(false);
  });
});

describe('helpers', () => {
  it('redactUrl drops query strings and credentials', () => {
    expect(redactUrl('https://u:p@hooks.example.com/a/b?token=s3cret')).toBe(
      'https://hooks.example.com/a/b?<redacted>',
    );
    expect(redactUrl('not a url')).toBe('(unparseable url)');
  });

  it('parseArgs requires --since, normalises dates and accepts --dry-run', () => {
    expect(() => parseArgs([])).toThrow(/--since/);
    expect(() => parseArgs(['--since', 'nope'])).toThrow(/not a date/);
    const a = parseArgs(
      ['--since', '2026-05-23', '--until=2026-10-24', '--dry-run', '--known-actors', 'key:a, key:b'],
      new Date('2026-10-24T00:00:00Z'),
    );
    expect(a.since).toBe('2026-05-23T00:00:00.000Z');
    expect(a.until).toBe('2026-10-24T00:00:00.000Z');
    expect(a.knownActors).toEqual(['key:a', 'key:b']);
    expect(a.pageSize).toBe(500);
    expect(parseArgs(['--since', '2026-01-01', '--page-size', '999999']).pageSize).toBe(5000);
  });
});
