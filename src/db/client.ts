import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.ts';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Opens (creating if needed) the database at `path` and brings it to the latest schema. */
export function openDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema, casing: 'snake_case' });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

export type Db = ReturnType<typeof openDb>;
