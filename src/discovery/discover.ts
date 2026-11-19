/**
 * Turns aggregator listings into watched companies.
 *
 * The acceptance rule: a company is added only when one of its aggregator titles is found
 * on the candidate board. That single check proves both that the slug belongs to this
 * company (not a namesake) and that the ATS is right, so guessing slugs is safe.
 *
 * Order of attempts per company: ATS links found in the listing text, then slug candidates
 * from the company name against each JSON-API ATS. Companies already watched are skipped;
 * a company with no board found is remembered and not retried for a while.
 */
import { gt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { company, discoveryMiss } from '../db/schema.ts';
import type { Ats } from '../domain/types.ts';
import { foldPlaceText as fold } from '../geo/text.ts';
import type { HttpClient } from '../sources/http.ts';
import type { BoardSource } from '../sources/types.ts';
import type { Listing } from './aggregators.ts';
import { detectFromUrl, type BoardRef } from './detect.ts';

/** ATSes whose boards can be probed by slug (Teamtailor needs a host, not a slug). */
const PROBED: Ats[] = ['ashby', 'greenhouse', 'lever', 'workable', 'recruitee'];

const LEGAL_SUFFIXES = new Set(
  'inc llc ltd limited gmbh ag ab bv b v nv sa sas srl sl spa oy oyj as asa aps plc co corp corporation pty pte kk'.split(
    ' ',
  ),
);

/** "Proxify AB" → ["proxify-ab", "proxifyab", "proxify"], deduplicated, most specific first. */
export function slugCandidates(name: string): string[] {
  const words = fold(name).split(' ').filter(Boolean);
  const core = words.filter((w, i) => i === 0 || !LEGAL_SUFFIXES.has(w));
  const out = [words.join('-'), core.join('-'), core.join(''), words.join('')];
  if (core.length > 1 && (core[0]?.length ?? 0) >= 4) out.push(core[0] ?? '');
  return [...new Set(out.filter((s) => s.length >= 2))];
}

/** Same title once case, accents and punctuation are folded away; or one is a prefix. */
export function sameTitle(a: string, b: string): boolean {
  const x = fold(a);
  const y = fold(b);
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.startsWith(short);
}

export interface DiscoveryDeps {
  db: Db;
  http: HttpClient;
  sources: Record<Ats, BoardSource>;
  now?: () => Date;
}

export interface DiscoveryOptions {
  /** Most companies to try in one run. */
  limit: number;
  /** Skip companies that found no board within this many days. */
  retryAfterDays?: number;
  dryRun?: boolean;
}

export interface Discovered extends BoardRef {
  company: string;
  via: 'link' | 'probe';
  listing: string;
}

export interface DiscoveryReport {
  added: Discovered[];
  notFound: string[];
  skipped: number;
}

/** Fetches a candidate board; returns its titles, or null if it doesn't exist. */
async function boardTitles(deps: DiscoveryDeps, ref: BoardRef): Promise<string[] | null> {
  try {
    const source = deps.sources[ref.ats];
    const outcome = await source.fetch(ref.org, { http: deps.http });
    if (outcome.status !== 'ok') return null;
    return outcome.postings.map((raw) => source.normalize(raw).title);
  } catch {
    return null;
  }
}

async function findBoard(
  deps: DiscoveryDeps,
  name: string,
  listings: Listing[],
): Promise<Omit<Discovered, 'company'> | null> {
  const titles = listings.map((l) => l.title);
  const matches = (boardTitlesFound: string[]) =>
    boardTitlesFound.some((t) => titles.some((title) => sameTitle(t, title)));

  for (const listing of listings) {
    for (const link of listing.links) {
      const ref = detectFromUrl(link);
      if (!ref) continue;
      const found = await boardTitles(deps, ref);
      if (found && matches(found)) return { ...ref, via: 'link', listing: listing.url };
    }
  }
  for (const org of slugCandidates(name)) {
    for (const ats of PROBED) {
      const found = await boardTitles(deps, { ats, org });
      if (found && matches(found)) {
        return { ats, org, via: 'probe', listing: listings[0]?.url ?? '' };
      }
    }
  }
  return null;
}

export async function discover(
  deps: DiscoveryDeps,
  listings: Listing[],
  options: DiscoveryOptions,
): Promise<DiscoveryReport> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const retryAfter = new Date(now().getTime() - (options.retryAfterDays ?? 30) * 86_400_000);

  const watched = new Set(
    db
      .select({ name: company.name })
      .from(company)
      .all()
      .map((c) => fold(c.name)),
  );
  const recentMisses = new Set(
    db
      .select({ key: discoveryMiss.nameKey })
      .from(discoveryMiss)
      .where(gt(discoveryMiss.lastTriedAt, retryAfter))
      .all()
      .map((m) => m.key),
  );

  const byCompany = Map.groupBy(listings, (l) => fold(l.company));
  const report: DiscoveryReport = { added: [], notFound: [], skipped: 0 };
  let tried = 0;

  for (const [key, group] of byCompany) {
    const name = group[0]?.company ?? key;
    if (!key || watched.has(key) || recentMisses.has(key)) {
      report.skipped++;
      continue;
    }
    if (tried >= options.limit) break;
    tried++;

    const found = await findBoard(deps, name, group);
    if (!found) {
      report.notFound.push(name);
      if (!options.dryRun) {
        db.insert(discoveryMiss)
          .values({ nameKey: key, name, lastTriedAt: now() })
          .onConflictDoUpdate({ target: discoveryMiss.nameKey, set: { lastTriedAt: now() } })
          .run();
      }
      continue;
    }
    report.added.push({ company: name, ...found });
    if (!options.dryRun) {
      db.insert(company)
        .values({
          name,
          ats: found.ats,
          orgSlug: found.org,
          discoveredFrom: found.listing,
          addedAt: now(),
        })
        .onConflictDoNothing()
        .run();
    }
  }
  return report;
}
