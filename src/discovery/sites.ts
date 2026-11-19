/**
 * Discovery from a company list: each company's own careers page (or home page) is read
 * for a link to, or an embed of, a hosted ATS board.
 *
 * Unlike aggregator discovery there are no titles to cross-check, and none are needed: the
 * board is taken from the company's own site, not guessed from its name. A board is still
 * fetched once before it is added, so dead links never reach the watch list.
 *
 * Pages that point at an ATS we have no adapter for are tallied per system, which is what
 * decides the next adapter worth writing.
 */
import { and, eq, gt } from 'drizzle-orm';
import { company, discoveryMiss } from '../db/schema.ts';
import { foldPlaceText as fold } from '../geo/text.ts';
import type { HttpClient } from '../sources/http.ts';
import {
  careersLinks,
  detectFromUrl,
  detectInHtml,
  detectUnsupported,
  type BoardRef,
} from './detect.ts';
import type { DiscoveryDeps } from './discover.ts';
import type { ListEntry } from './lists.ts';

export interface SiteDiscoveryOptions {
  /** Most companies to try in one run. */
  limit: number;
  /** Companies looked at in parallel; requests to one host are still spaced out. */
  concurrency?: number;
  retryAfterDays?: number;
  dryRun?: boolean;
  /** Called after each company, for progress output. */
  onProgress?: (done: number, total: number) => void;
}

export interface SiteFound extends BoardRef {
  company: string;
  page: string;
}

export interface SiteDiscoveryReport {
  added: SiteFound[];
  /** Boards found that are already watched. */
  known: number;
  /** Unsupported ATS → companies seen using it. */
  unsupported: Map<string, string[]>;
  notFound: string[];
  errors: { company: string; error: string }[];
  /** Companies skipped: already watched by name, or missed recently. */
  skipped: number;
}

/** Most boards taken from one company (a group with several brands has a few). */
const MAX_BOARDS = 3;

interface Explored {
  refs: BoardRef[];
  unsupported: Set<string>;
  page: string;
  error?: string;
}

/** Reads a company's pages until one yields a board: each given URL, then one hop to a careers link. */
async function explore(http: HttpClient, urls: string[]): Promise<Explored> {
  const unsupported = new Set<string>();
  let error: string | undefined;
  const seen = new Set<string>();

  const look = async (url: string, hop: boolean): Promise<Explored | null> => {
    if (seen.has(url)) return null;
    seen.add(url);
    const direct = detectFromUrl(url);
    if (direct) return { refs: [direct], unsupported, page: url };
    let html: string;
    try {
      const page = await http.getText(url);
      if (page.status !== 'ok') return null;
      html = page.body;
    } catch (e) {
      error ??= e instanceof Error ? e.message : String(e);
      return null;
    }
    const refs = detectInHtml(html, url);
    if (refs.length) return { refs, unsupported, page: url };
    for (const name of detectUnsupported(html)) unsupported.add(name);
    if (!hop) return null;
    for (const link of careersLinks(html, url, 2)) {
      const found = await look(link, false);
      if (found) return found;
    }
    return null;
  };

  for (const url of urls) {
    const found = await look(url, true);
    if (found) return found;
  }
  return { refs: [], unsupported, page: urls[0] ?? '', ...(error ? { error } : {}) };
}

async function boardExists(deps: DiscoveryDeps, ref: BoardRef): Promise<boolean> {
  try {
    return (await deps.sources[ref.ats].fetch(ref.org, { http: deps.http })).status === 'ok';
  } catch {
    return false;
  }
}

export async function discoverFromSites(
  deps: DiscoveryDeps,
  entries: ListEntry[],
  options: SiteDiscoveryOptions,
): Promise<SiteDiscoveryReport> {
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

  const report: SiteDiscoveryReport = {
    added: [],
    known: 0,
    unsupported: new Map(),
    notFound: [],
    errors: [],
    skipped: 0,
  };

  const queue: ListEntry[] = [];
  const queued = new Set<string>();
  for (const entry of entries) {
    const key = fold(entry.name);
    if (!key || watched.has(key) || recentMisses.has(key) || queued.has(key)) {
      report.skipped++;
      continue;
    }
    if (queue.length >= options.limit) break;
    queued.add(key);
    queue.push(entry);
  }

  const isWatched = (ref: BoardRef) =>
    db
      .select({ id: company.id })
      .from(company)
      .where(and(eq(company.ats, ref.ats), eq(company.orgSlug, ref.org)))
      .get() !== undefined;

  const miss = (entry: ListEntry) => {
    if (options.dryRun) return;
    db.insert(discoveryMiss)
      .values({ nameKey: fold(entry.name), name: entry.name, lastTriedAt: now() })
      .onConflictDoUpdate({ target: discoveryMiss.nameKey, set: { lastTriedAt: now() } })
      .run();
  };

  let done = 0;
  const one = async (entry: ListEntry) => {
    const explored = await explore(deps.http, entry.urls);
    for (const name of explored.unsupported) {
      report.unsupported.set(name, [...(report.unsupported.get(name) ?? []), entry.name]);
    }
    let found = 0;
    for (const ref of explored.refs.slice(0, MAX_BOARDS)) {
      if (isWatched(ref)) {
        report.known++;
        found++;
        continue;
      }
      if (!(await boardExists(deps, ref))) continue;
      found++;
      report.added.push({ company: entry.name, ...ref, page: explored.page });
      if (!options.dryRun) {
        db.insert(company)
          .values({
            name: entry.name,
            ats: ref.ats,
            orgSlug: ref.org,
            careersUrl: explored.page,
            discoveredFrom: explored.page,
            addedAt: now(),
          })
          .onConflictDoNothing()
          .run();
      }
    }
    if (found === 0) {
      if (explored.error && explored.unsupported.size === 0) {
        report.errors.push({ company: entry.name, error: explored.error });
      } else {
        report.notFound.push(entry.name);
      }
      miss(entry);
    }
    options.onProgress?.(++done, queue.length);
  };

  // A small worker pool: companies are on different hosts, so they can overlap.
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const entry = queue[next++];
      if (entry) await one(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 6) }, worker));
  return report;
}
