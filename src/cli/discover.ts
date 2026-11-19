/**
 * Adds companies to the watch list.
 *
 *   pnpm discover himalayas [--pages 3] [--keyword engineer] [--limit 10] [--dry-run]
 *   pnpm discover weworkremotely [--pages 2] ...
 *   pnpm discover url https://example.com/careers [--name "Example"] [--dry-run]
 *   pnpm discover list companies.txt [--limit 50] [--dry-run]
 *   pnpm discover list path/to/remote-jobs/src/companies [--limit 200]
 *
 * Discovered companies are polled by `pnpm poll` from then on, straight from their ATS.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config.ts';
import { openDb } from '../db/client.ts';
import { company } from '../db/schema.ts';
import { AGGREGATORS } from '../discovery/aggregators.ts';
import { detectFromUrl, detectInHtml, type BoardRef } from '../discovery/detect.ts';
import { discover } from '../discovery/discover.ts';
import { readList } from '../discovery/lists.ts';
import { discoverFromSites } from '../discovery/sites.ts';
import { createHttpClient, SourceError, type HttpClient } from '../sources/http.ts';
import { SOURCES } from '../sources/index.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    pages: { type: 'string', default: '2' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '6' },
    keyword: { type: 'string', multiple: true, default: [] },
    name: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const [command, target] = positionals;
const dryRun = values['dry-run'];

try {
  const config = loadConfig();
  mkdirSync(dirname(config.database), { recursive: true });
  const db = openDb(config.database);
  const http = createHttpClient(config.userAgent ? { userAgent: config.userAgent } : {});

  if (command === 'url' && target) {
    await fromUrl(http, target);
  } else if (command === 'list' && target) {
    const entries = readList(target);
    console.log(`${target}: ${entries.length} companies`);
    const report = await discoverFromSites({ db, http, sources: SOURCES }, entries, {
      limit: Number(values.limit ?? entries.length),
      concurrency: Number(values.concurrency),
      dryRun,
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) console.log(`  … ${done}/${total}`);
      },
    });
    for (const d of report.added) {
      console.log(`  + ${d.company} → ${d.ats}/${d.org}  (${d.page})`);
    }
    const census = [...report.unsupported].sort((a, b) => b[1].length - a[1].length);
    if (census.length) {
      console.log('unsupported ATS seen (companies):');
      for (const [name, companies] of census) {
        console.log(
          `  ${name.padEnd(18)} ${String(companies.length).padStart(4)}  ${companies.slice(0, 6).join(', ')}${companies.length > 6 ? ', …' : ''}`,
        );
      }
    }
    console.log(
      `added ${report.added.length} board(s), ${report.known} already watched, ` +
        `no board found for ${report.notFound.length}, unreachable ${report.errors.length}, ` +
        `skipped ${report.skipped}` +
        (dryRun ? ' — dry run, nothing saved' : ''),
    );
  } else if (command && command in AGGREGATORS) {
    const aggregator = AGGREGATORS[command];
    if (!aggregator) throw new Error('unreachable');
    const keywords = values.keyword.map((k) => k.toLowerCase());
    const listings = (await aggregator.listings(http, { pages: Number(values.pages) })).filter(
      (l) => keywords.length === 0 || keywords.some((k) => l.title.toLowerCase().includes(k)),
    );
    console.log(`${aggregator.name}: ${listings.length} listings`);
    const report = await discover({ db, http, sources: SOURCES }, listings, {
      limit: Number(values.limit ?? 10),
      dryRun,
    });
    for (const d of report.added) {
      console.log(`  + ${d.company} → ${d.ats}/${d.org} (via ${d.via})`);
    }
    console.log(
      `added ${report.added.length}, no board found for ${report.notFound.length}` +
        ` (${report.notFound.join(', ') || '—'}), skipped ${report.skipped} already known` +
        (dryRun ? ' — dry run, nothing saved' : ''),
    );
  } else {
    console.error(
      `usage: pnpm discover <${Object.keys(AGGREGATORS).join('|')}> [--pages N] [--keyword K] [--limit N] [--dry-run]\n` +
        '       pnpm discover url <careers-url> [--name NAME] [--dry-run]\n' +
        '       pnpm discover list <file|profiles-dir> [--limit N] [--concurrency N] [--dry-run]',
    );
    process.exitCode = 2;
  }

  /** A careers URL: either a hosted board itself, or a page that links/embeds one. */
  async function fromUrl(client: HttpClient, url: string) {
    let refs: BoardRef[] = [];
    const direct = detectFromUrl(url);
    if (direct) {
      refs = [direct];
    } else {
      const page = await client.getText(url);
      if (page.status === 'ok') refs = detectInHtml(page.body, url);
    }
    if (refs.length === 0) {
      console.log(`no known ATS board found at ${url}`);
      process.exitCode = 1;
      return;
    }
    for (const ref of refs) {
      const outcome = await SOURCES[ref.ats]
        .fetch(ref.org, { http: client })
        .catch((e: unknown) => e);
      if (outcome instanceof Error || (outcome as { status: string }).status !== 'ok') {
        console.log(`  ✗ ${ref.ats}/${ref.org}: board not reachable`);
        continue;
      }
      const name = values.name ?? ref.org;
      if (!dryRun) {
        db.insert(company)
          .values({
            name,
            ats: ref.ats,
            orgSlug: ref.org,
            discoveredFrom: url,
            addedAt: new Date(),
          })
          .onConflictDoNothing()
          .run();
      }
      console.log(`  + ${name} → ${ref.ats}/${ref.org}${dryRun ? ' (dry run)' : ''}`);
    }
  }
} catch (error) {
  if (error instanceof ConfigError || error instanceof SourceError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
