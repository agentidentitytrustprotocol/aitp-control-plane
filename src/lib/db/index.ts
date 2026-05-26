import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

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
  globalThis.__dbPool = pool;
  return drizzle(pool, { schema });
}

export const db = globalThis.__db ?? (globalThis.__db = createDb());
export const pool = globalThis.__dbPool!;
export type Db = typeof db;
export { schema };
