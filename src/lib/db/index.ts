import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';
import { logger } from '../logger';

const { Pool } = pg;

declare global {
  // eslint-disable-next-line no-var
  var __db: ReturnType<typeof drizzle<typeof schema>> | undefined;
  // eslint-disable-next-line no-var
  var __dbPool: pg.Pool | undefined;
}

function createDb() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX ?? '20', 10),
  });
  // A backend error on an IDLE pooled client (Postgres restart, failover,
  // pg_terminate_backend) is emitted on the pool, which has already discarded
  // that client. Without a listener it is an unhandled 'error' event: Next's
  // server only logs it unstructured, and anything else crashes. Log it
  // structured; the next checkout simply opens a new connection.
  pool.on('error', (err) => logger.warn({ err }, 'idle database client error'));
  globalThis.__dbPool = pool;
  return drizzle(pool, { schema });
}

export const db = globalThis.__db ?? (globalThis.__db = createDb());
export const pool = globalThis.__dbPool!;
export type Db = typeof db;
export { schema };
