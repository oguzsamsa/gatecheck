import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

/**
 * Opens an existing database read-only, without migrating — for readers such as the
 * dashboard, which must never write while the poller runs. Kept apart from client.ts so a
 * reader bundles no migration code.
 */
export function openReadonlyDb(path: string) {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  return drizzle({ client: sqlite, schema, casing: 'snake_case' });
}
