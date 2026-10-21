import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../lib/config.js';
import * as schema from './schema.js';

/** Shared postgres pool + drizzle instance. */

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });
