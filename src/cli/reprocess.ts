/**
 * `pnpm reprocess`: re-reads every open posting's stored payload with the current adapters,
 * then re-evaluates eligibility. Run it after a fix to an adapter or the place resolver.
 * Offline: nothing is fetched, nothing is sent; the next digest reports flipped verdicts.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigError, loadConfig } from '../config.ts';
import { openDb } from '../db/client.ts';
import { evaluateOpenPostings } from '../eligibility/evaluate.ts';
import { reprocessPostings } from '../pipeline/reprocess.ts';
import { SOURCES } from '../sources/index.ts';

try {
  const config = loadConfig();
  mkdirSync(dirname(config.database), { recursive: true });
  const db = openDb(config.database);

  const report = reprocessPostings(db, SOURCES);
  console.log(
    `reprocessed ${report.postings} open posting(s): ${report.changed} read differently now`,
  );
  for (const f of report.failed) console.log(`  ✗ posting ${f.postingId}: ${f.error}`);

  const changes = evaluateOpenPostings(db, config.applicant.country, new Date());
  const count = (v: string) => changes.filter((c) => c.to === v).length;
  console.log(
    `eligibility: ${changes.length} changed (${count('open')} open, ${count('unknown')} unknown, ${count('closed')} closed)`,
  );
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
