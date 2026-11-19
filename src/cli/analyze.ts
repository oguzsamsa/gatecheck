/**
 * Phase 3: `pnpm analyze [--limit N]` reads postings that passed the filter with a model
 * and writes a draft per posting to data/drafts/. Each posting is one paid API call.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config.ts';
import { openDb } from '../db/client.ts';
import { claudeAnalyzer } from '../analysis/claude.ts';
import { analyzePending, describeReport } from '../analysis/run.ts';
import { readProfile } from '../analysis/profile.ts';
import { SOURCES } from '../sources/index.ts';

const { values } = parseArgs({ options: { limit: { type: 'string' } } });

try {
  const config = loadConfig();
  if (!config.analysis) {
    throw new ConfigError('analysis is not configured — add an "analysis" section to config.json');
  }
  mkdirSync(dirname(config.database), { recursive: true });
  const db = openDb(config.database);
  const a = config.analysis;
  const report = await analyzePending(
    {
      db,
      analyzer: claudeAnalyzer({ model: a.model, effort: a.effort }),
      sources: SOURCES,
      applicant: config.applicant.country,
      profile: readProfile(a.profileFile),
      titleKeywords: config.profile.titleKeywords,
      excludeTitleKeywords: config.profile.excludeTitleKeywords,
      draftsDir: a.draftsDir,
    },
    { limit: values.limit ? Number(values.limit) : a.maxPerRun },
  );
  console.log(describeReport(report));
  if (report.failed.length > 0) process.exitCode = 1;
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exitCode = 2;
}
