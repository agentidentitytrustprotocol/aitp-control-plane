function readNumber(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function readList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  isProduction: process.env.NODE_ENV === 'production',
  port: readNumber('PORT', 4000),
  cpBaseUrl: process.env.CP_BASE_URL ?? 'http://localhost:4000',
  cpAidSeedHex: process.env.CP_AID_SEED_HEX ?? '',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/aitp_cp',
  dbPoolMax: readNumber('DB_POOL_MAX', 20),
  apiKeys: readList('API_KEYS'),
  enrollmentSecret: process.env.ENROLLMENT_SECRET ?? '',
  maxAuditEventsInMemory: readNumber('MAX_AUDIT_EVENTS_MEMORY', 500),
  revocationListTtlSecs: readNumber('REVOCATION_LIST_TTL_SECS', 3600),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  webhookRetryAttempts: readNumber('WEBHOOK_RETRY_ATTEMPTS', 3),
} as const;

export type Config = typeof config;
