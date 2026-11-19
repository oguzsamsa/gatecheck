/**
 * The single entry point a scheduler runs: `pnpm poll`. Host-independent — launchd today,
 * cron or a systemd timer on a VPS tomorrow.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config.ts';
import { openDb } from '../db/client.ts';
import { claudeAnalyzer } from '../analysis/claude.ts';
import { readProfile } from '../analysis/profile.ts';
import { analyzePending, describeReport } from '../analysis/run.ts';
import { evaluateOpenPostings } from '../eligibility/evaluate.ts';
import { collectDigest } from '../notify/digest.ts';
import { renderDigest } from '../notify/render.ts';
import { deliver, TelegramError } from '../notify/telegram.ts';
import { poll, type SourceReport } from '../pipeline/poll.ts';
import { createHttpClient } from '../sources/http.ts';
import { SOURCES } from '../sources/index.ts';

const { values: flags } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
});

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

  // Phase 3, opt-in: read the postings that passed before announcing them.
  const a = config.analysis;
  if (a?.onPoll) {
    const analyzed = await analyzePending(
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
      { limit: a.maxPerRun },
    );
    console.log(describeReport(analyzed));
  }

  const messages = renderDigest(collectDigest(db, report.runId, config.profile));
  if (messages.length === 0) {
    console.log('digest: nothing new');
  } else if (!config.telegram || flags['dry-run']) {
    // Nothing is marked as notified, so the same digest is sent once delivery is configured.
    console.log(`digest (not sent${config.telegram ? ', --dry-run' : ', no telegram config'}):\n`);
    for (const m of messages) console.log(`${m.text}\n`);
  } else {
    const count = await deliver(db, config.telegram, messages, new Date());
    console.log(`digest: sent ${messages.length} message(s), ${count} posting(s)`);
  }

  if (report.status === 'failed') process.exitCode = 1;
} catch (error) {
  if (error instanceof TelegramError) {
    console.error(error.message);
    process.exitCode = 1;
  } else if (error instanceof ConfigError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    throw error;
  }
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
