/**
 * Read models for the dashboard (phase 4). Plain functions over the database so they are
 * tested here, next to the schema, and the web app only renders.
 */
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import {
  analysis,
  company,
  compensation,
  eligibility,
  locationClaim,
  posting,
  postingChange,
  postingVersion,
  run,
  runSource,
  VERDICTS,
  type Verdict,
} from '../db/schema.ts';
import { formatBand, placeLabel } from '../domain/format.ts';

export interface PostingFilters {
  verdicts?: Verdict[];
  /** Matches title or company, case-insensitively. */
  q?: string;
  companyId?: number;
  /** ISO code; postings with a claim naming it. */
  country?: string;
  includeClosed?: boolean;
  limit?: number;
  offset?: number;
}

export interface PostingRow {
  id: number;
  company: string;
  ats: string;
  title: string;
  url: string;
  verdict: Verdict | null;
  reason: string | null;
  places: string[];
  salary: string | null;
  fit: string | null;
  firstSeenAt: Date;
  closedAt: Date | null;
}

export function listPostings(
  db: Db,
  f: PostingFilters = {},
): { rows: PostingRow[]; total: number } {
  const conditions = [
    f.includeClosed ? undefined : isNull(posting.closedAt),
    f.verdicts?.length ? inArray(eligibility.verdict, f.verdicts) : undefined,
    f.companyId ? eq(posting.companyId, f.companyId) : undefined,
    f.q
      ? or(like(posting.title, `%${escapeLike(f.q)}%`), like(company.name, `%${escapeLike(f.q)}%`))
      : undefined,
    f.country
      ? inArray(
          posting.id,
          db
            .select({ id: locationClaim.postingId })
            .from(locationClaim)
            .where(eq(locationClaim.countryCode, f.country.toUpperCase() as 'TR')),
        )
      : undefined,
  ];
  const where = and(...conditions);

  const base = db
    .select({
      id: posting.id,
      company: company.name,
      ats: company.ats,
      title: posting.title,
      url: posting.url,
      verdict: eligibility.verdict,
      reason: eligibility.reason,
      fit: analysis.fit,
      firstSeenAt: posting.firstSeenAt,
      closedAt: posting.closedAt,
    })
    .from(posting)
    .innerJoin(company, eq(company.id, posting.companyId))
    .leftJoin(eligibility, eq(eligibility.postingId, posting.id))
    .leftJoin(analysis, eq(analysis.postingId, posting.id))
    .where(where);

  const total =
    db
      .select({ n: count() })
      .from(posting)
      .innerJoin(company, eq(company.id, posting.companyId))
      .leftJoin(eligibility, eq(eligibility.postingId, posting.id))
      .where(where)
      .get()?.n ?? 0;

  const page = base
    .orderBy(desc(posting.firstSeenAt), desc(posting.id))
    .limit(f.limit ?? 100)
    .offset(f.offset ?? 0)
    .all();

  const ids = page.map((p) => p.id);
  const claims = Map.groupBy(
    ids.length
      ? db.select().from(locationClaim).where(inArray(locationClaim.postingId, ids)).all()
      : [],
    (c) => c.postingId,
  );
  const bands = Map.groupBy(
    ids.length
      ? db.select().from(compensation).where(inArray(compensation.postingId, ids)).all()
      : [],
    (c) => c.postingId,
  );

  return {
    total,
    rows: page.map((p) => {
      const band = bands.get(p.id)?.[0];
      return {
        ...p,
        places: [...new Set((claims.get(p.id) ?? []).map(placeLabel))],
        salary: band ? formatBand(band) : null,
      };
    }),
  };
}

const escapeLike = (s: string) => s.replace(/[%_]/g, '');

export interface Facets {
  verdicts: Record<Verdict, number>;
  companies: { id: number; name: string; ats: string; open: number }[];
}

/** Counts for the filter bar, over open postings. */
export function facets(db: Db): Facets {
  const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const r of db
    .select({ verdict: eligibility.verdict, n: count() })
    .from(eligibility)
    .innerJoin(posting, eq(posting.id, eligibility.postingId))
    .where(isNull(posting.closedAt))
    .groupBy(eligibility.verdict)
    .all()) {
    verdicts[r.verdict] = r.n;
  }
  const companies = db
    .select({
      id: company.id,
      name: company.name,
      ats: company.ats,
      open: sql<number>`count(${posting.id})`.mapWith(Number),
    })
    .from(company)
    .leftJoin(posting, and(eq(posting.companyId, company.id), isNull(posting.closedAt)))
    .groupBy(company.id)
    .orderBy(asc(company.name))
    .all();
  return { verdicts, companies };
}

export function postingDetail(db: Db, id: number) {
  const p = db
    .select({
      id: posting.id,
      title: posting.title,
      url: posting.url,
      department: posting.department,
      employmentType: posting.employmentType,
      postedAt: posting.postedAt,
      firstSeenAt: posting.firstSeenAt,
      lastSeenAt: posting.lastSeenAt,
      closedAt: posting.closedAt,
      company: company.name,
      ats: company.ats,
      org: company.orgSlug,
      verdict: eligibility.verdict,
      reason: eligibility.reason,
    })
    .from(posting)
    .innerJoin(company, eq(company.id, posting.companyId))
    .leftJoin(eligibility, eq(eligibility.postingId, posting.id))
    .where(eq(posting.id, id))
    .get();
  if (!p) return null;
  return {
    ...p,
    claims: db.select().from(locationClaim).where(eq(locationClaim.postingId, id)).all(),
    compensation: db
      .select()
      .from(compensation)
      .where(eq(compensation.postingId, id))
      .all()
      .map(formatBand),
    versions: db
      .select({ fetchedAt: postingVersion.fetchedAt, contentHash: postingVersion.contentHash })
      .from(postingVersion)
      .where(eq(postingVersion.postingId, id))
      .orderBy(desc(postingVersion.id))
      .all(),
    changes: db
      .select()
      .from(postingChange)
      .where(eq(postingChange.postingId, id))
      .orderBy(desc(postingChange.id))
      .all(),
    analysis: db.select().from(analysis).where(eq(analysis.postingId, id)).get() ?? null,
  };
}

/** The latest run and the sources that failed in it. */
export function lastRun(db: Db) {
  const latest = db.select().from(run).orderBy(desc(run.id)).limit(1).get();
  if (!latest) return null;
  const errors = db
    .select({ company: company.name, httpStatus: runSource.httpStatus, error: runSource.error })
    .from(runSource)
    .innerJoin(company, eq(company.id, runSource.companyId))
    .where(and(eq(runSource.runId, latest.id), eq(runSource.status, 'error')))
    .all();
  return { ...latest, errors };
}
