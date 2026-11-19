/**
 * The single entry point a scheduler runs: `pnpm poll`. Host-independent — launchd today,
 * cron or a systemd timer on a VPS tomorrow.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigError, loadConfig } from '../config.ts';
import { openDb } from '../db/client.ts';
import { evaluateOpenPostings } from '../eligibility/evaluate.ts';
import { poll, type SourceReport } from '../pipeline/poll.ts';
import { createHttpClient } from '../sources/http.ts';
import { SOURCES } from '../sources/index.ts';

try {
  const config = loadConfig();
  mkdirSync(dirname(config.database), { recursive: true });
  const db = openDb(config.database);
  const http = createHttpClient(config.userAgent ? { userAgent: config.userAgent } : {});

  const report = await poll({ db, http, sources: SOURCES }, config.watchlist);
  console.log(`run #${report.runId}: ${report.status}`);
  for (const s of report.sources) console.log(`  ${describe(s)}`);

  const changes = evaluateOpenPostings(db, config.applicant.country, new Date());
  const count = (v: string) => changes.filter((c) => c.to === v).length;
  console.log(
    `eligibility: ${changes.length} changed (${count('open')} open, ${count('unknown')} unknown, ${count('closed')} closed)`,
  );
  if (report.status === 'failed') process.exitCode = 1;
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exitCode = 2;
}

function describe(s: SourceReport): string {
  const name = `${s.company} (${s.ats}/${s.org})`;
  switch (s.status) {
    case 'ok':
      return `${name}: ${s.seen} open, +${s.created} new, ${s.changed} changed, ${s.closed} closed`;
    case 'not_modified':
      return `${name}: unchanged`;
    case 'error':
      return `${name}: ERROR ${s.httpStatus ?? ''} ${s.error}`;
  }
}
