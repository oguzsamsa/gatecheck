/**
 * Fetches one live board and prints what gatecheck makes of it. Touches no database —
 * it is the quickest way to see how a new company's postings normalize.
 *
 *   pnpm inspect ashby codeway
 *   pnpm inspect ashby jobs.funnelfox.com --json
 */
import { parseArgs } from 'node:util';
import { ATS_VALUES, type Ats, type LocationClaim } from '../domain/types.ts';
import { SOURCES } from '../sources/index.ts';
import { createHttpClient, SourceError } from '../sources/http.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { json: { type: 'boolean', default: false } },
});
const [ats, org] = positionals;

if (!isAts(ats) || !org) {
  console.error(`usage: pnpm inspect <${ATS_VALUES.join('|')}> <org> [--json]`);
  process.exit(2);
}

const source = SOURCES[ats];
try {
  const outcome = await source.fetch(org, { http: createHttpClient() });
  if (outcome.status === 'not_modified') {
    console.log('not modified');
    process.exit(0);
  }
  const postings = outcome.postings.map((raw) => source.normalize(raw));

  if (values.json) {
    console.log(JSON.stringify(postings, null, 2));
  } else {
    console.log(`${ats}/${org}: ${postings.length} postings (HTTP ${outcome.httpStatus})\n`);
    for (const p of postings) {
      console.log(p.title);
      for (const claim of p.locations) console.log(`  ${describe(claim)}`);
      for (const c of p.compensation) {
        console.log(`  $ ${c.min ?? '?'}–${c.max ?? '?'} ${c.currency ?? ''} / ${c.period ?? '?'}`);
      }
    }
  }
} catch (error) {
  if (!(error instanceof SourceError)) throw error;
  console.error(`${error.message}\n  ${error.url}`);
  process.exit(1);
}

function describe(claim: LocationClaim): string {
  const place = claim.countryCode ?? claim.region ?? '(unresolved)';
  const city = claim.city ? ` ${claim.city}` : '';
  return `${claim.kind.padEnd(14)} ${place}${city}  ← ${claim.raw}`;
}

function isAts(value: string | undefined): value is Ats {
  return (ATS_VALUES as readonly (string | undefined)[]).includes(value);
}
