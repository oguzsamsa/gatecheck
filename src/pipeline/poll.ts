import { and, desc, eq, isNotNull, ne, or } from 'drizzle-orm';
import type { WatchlistEntry } from '../config.ts';
import type { Db } from '../db/client.ts';
import { company, run, runSource } from '../db/schema.ts';
import type { Ats } from '../domain/types.ts';
import { SourceError, type HttpClient, type Validators } from '../sources/http.ts';
import type { BoardSource } from '../sources/types.ts';
import { ingestBoard, touchBoard, type IngestResult } from './ingest.ts';

export interface PollDeps {
  db: Db;
  http: HttpClient;
  sources: Record<Ats, BoardSource>;
  now?: () => Date;
}

export type SourceReport = { companyId: number; company: string; ats: Ats; org: string } & (
  | ({ status: 'ok'; httpStatus: number; seen: number } & IngestResult)
  | { status: 'not_modified' }
  | { status: 'error'; httpStatus: number | null; error: string }
);

export interface PollReport {
  runId: number;
  status: 'ok' | 'partial' | 'failed';
  startedAt: Date;
  sources: SourceReport[];
}

/** Makes the company table reflect the watchlist (new entries added, names kept current). */
export function syncWatchlist(db: Db, watchlist: WatchlistEntry[], now: Date): void {
  for (const w of watchlist) {
    db.insert(company)
      .values({
        name: w.name,
        ats: w.ats,
        orgSlug: w.org,
        careersUrl: w.careersUrl ?? null,
        discoveredFrom: 'config',
        addedAt: now,
      })
      .onConflictDoUpdate({
        target: [company.ats, company.orgSlug],
        set: { name: w.name, careersUrl: w.careersUrl ?? null },
      })
      .run();
  }
}

/**
 * Companies polled this run: everything on the configured watchlist, plus everything
 * discovered automatically. A company removed from config.json stops being polled; its
 * history stays.
 */
function companiesToPoll(db: Db, watchlist: WatchlistEntry[]) {
  const configured = new Set(watchlist.map((w) => `${w.ats}:${w.org}`));
  return db
    .select()
    .from(company)
    .all()
    .filter((c) => c.discoveredFrom !== 'config' || configured.has(`${c.ats}:${c.orgSlug}`));
}

/** Validators from this company's last successful fetch, for a conditional request. */
function previousValidators(db: Db, companyId: number): Validators | undefined {
  const last = db
    .select({ etag: runSource.etag, lastModified: runSource.lastModified })
    .from(runSource)
    .where(
      and(
        eq(runSource.companyId, companyId),
        ne(runSource.status, 'error'),
        or(isNotNull(runSource.etag), isNotNull(runSource.lastModified)),
      ),
    )
    .orderBy(desc(runSource.id))
    .limit(1)
    .get();
  return last ?? undefined;
}

/**
 * One poll over every watched company. Each source is isolated: a failure is recorded in
 * run_source with its HTTP status and message, and the run moves on to the next company.
 */
export async function poll(deps: PollDeps, watchlist: WatchlistEntry[]): Promise<PollReport> {
  const { db, http, sources } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();

  syncWatchlist(db, watchlist, startedAt);
  const runId = db
    .insert(run)
    .values({ startedAt, status: 'running' })
    .returning({ id: run.id })
    .get().id;

  const reports: SourceReport[] = [];
  for (const c of companiesToPoll(db, watchlist)) {
    const source = sources[c.ats];
    const sourceStart = now();
    const base = { companyId: c.id, company: c.name, ats: c.ats, org: c.orgSlug };
    const previous = previousValidators(db, c.id);
    let report: SourceReport;
    let validators: Validators | null = null;

    try {
      const outcome = await source.fetch(c.orgSlug, { http, previous });
      validators = outcome.validators;
      if (outcome.status === 'not_modified') {
        touchBoard(db, c.id, sourceStart);
        report = { ...base, status: 'not_modified' };
      } else {
        const fetched = outcome.postings.map((raw) => ({ raw, normalized: source.normalize(raw) }));
        const result = ingestBoard(db, c.id, fetched, sourceStart);
        report = {
          ...base,
          status: 'ok',
          httpStatus: outcome.httpStatus,
          seen: fetched.length,
          ...result,
        };
      }
    } catch (error) {
      report = {
        ...base,
        status: 'error',
        httpStatus: error instanceof SourceError ? error.httpStatus : null,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    db.insert(runSource)
      .values({
        runId,
        companyId: c.id,
        status: report.status,
        httpStatus: report.status === 'not_modified' ? 304 : report.httpStatus,
        error: report.status === 'error' ? report.error : null,
        postingsSeen: report.status === 'ok' ? report.seen : null,
        etag: validators?.etag ?? null,
        lastModified: validators?.lastModified ?? null,
        startedAt: sourceStart,
        durationMs: now().getTime() - sourceStart.getTime(),
      })
      .run();
    reports.push(report);
  }

  const failures = reports.filter((r) => r.status === 'error').length;
  const status = failures === 0 ? 'ok' : failures === reports.length ? 'failed' : 'partial';
  db.update(run).set({ status, finishedAt: now() }).where(eq(run.id, runId)).run();

  return { runId, status, startedAt, sources: reports };
}
