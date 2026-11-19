import { isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from 'gatecheck/config';
import { openReadonlyDb } from 'gatecheck/db';

/** The repo root: the dashboard runs from dashboard/. */
const ROOT = resolve(process.cwd(), '..');

function databasePath(): string {
  if (process.env.GATECHECK_DB) return process.env.GATECHECK_DB;
  const config = loadConfig(process.env.GATECHECK_CONFIG ?? join(ROOT, 'config.json'));
  // Runtime data, not a build input: keep the bundler from tracing the repo.
  return isAbsolute(config.database)
    ? config.database
    : join(/* turbopackIgnore: true */ ROOT, config.database);
}

type Db = ReturnType<typeof openReadonlyDb>;
const cache = globalThis as unknown as { gatecheckDb?: Db };

/** Read-only: the dashboard never writes while the poller may be running. */
export function db(): Db {
  cache.gatecheckDb ??= openReadonlyDb(databasePath());
  return cache.gatecheckDb;
}
