import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { config } from '../config/env.js';
import * as schema from './schema.js';

let pool = null;
if (!config.isTestMode) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error('The server runtime must provide WebSocket support for Neon Postgres. Use Node.js 22 or newer.');
  }
  neonConfig.webSocketConstructor = globalThis.WebSocket;
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (error) => {
    console.error(JSON.stringify({ level: 'error', event: 'database.pool_error', name: error.name, code: error.code }));
  });
}

export const db = pool ? drizzle({ client: pool, schema }) : null;

// Isolated in-memory adapter keeps tests independent from hosted services.
const testData = { conversations: [], messages: [], users: [], rateLimitBuckets: new Map(), messageSequences: new Map() };
export const memoryStore = config.isTestMode ? testData : null;

export async function pingDatabase() {
  if (memoryStore) return true;
  await db.execute(sql`select 1`);
  return true;
}

export async function closeDatabase() {
  if (pool) await pool.end();
}
