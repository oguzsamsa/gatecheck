import { and, eq, inArray, isNull, notExists } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import {
  company,
  compensation,
  eligibility,
  notification,
  posting,
  runSource,
} from '../db/schema.ts';

export interface DigestItem {
  postingId: number;
  company: string;
  title: string;
  url: string;
  reason: string;
  salary: string | null;
  belowFloor: boolean;
}

export interface Digest {
  open: DigestItem[];
  unknown: DigestItem[];
  errors: { company: string; source: string; error: string }[];
}

type Profile = Config['profile'];

/**
 * What to announce: open and unknown postings not yet sent on this channel (optionally
 * narrowed to titles matching the profile's keywords), plus this run's failing sources so
 * a silent gap never looks like "no new postings".
 */
export function collectDigest(db: Db, runId: number, profile: Profile): Digest {
  const rows = db
    .select({
      postingId: posting.id,
      company: company.name,
      title: posting.title,
      url: posting.url,
      verdict: eligibility.verdict,
      reason: eligibility.reason,
    })
    .from(posting)
    .innerJoin(company, eq(company.id, posting.companyId))
    .innerJoin(eligibility, eq(eligibility.postingId, posting.id))
    .where(
      and(
        isNull(posting.closedAt),
        inArray(eligibility.verdict, ['open', 'unknown']),
        notExists(
          db
            .select()
            .from(notification)
            .where(
              and(eq(notification.postingId, posting.id), eq(notification.channel, 'telegram')),
            ),
        ),
      ),
    )
    .orderBy(company.name, posting.title)
    .all()
    .filter((r) => matchesKeywords(r.title, profile.titleKeywords));

  const salaries = Map.groupBy(
    rows.length === 0
      ? []
      : db
          .select()
          .from(compensation)
          .where(
            inArray(
              compensation.postingId,
              rows.map((r) => r.postingId),
            ),
          )
          .all(),
    (c) => c.postingId,
  );

  const items = rows.map((r) => {
    const band = salaries.get(r.postingId)?.[0];
    return {
      item: {
        postingId: r.postingId,
        company: r.company,
        title: r.title,
        url: r.url,
        reason: r.reason,
        salary: band ? formatBand(band) : null,
        belowFloor: band ? isBelowFloor(band, profile.salaryFloor) : false,
      },
      verdict: r.verdict,
    };
  });

  const errors = db
    .select({
      company: company.name,
      ats: company.ats,
      org: company.orgSlug,
      httpStatus: runSource.httpStatus,
      error: runSource.error,
    })
    .from(runSource)
    .innerJoin(company, eq(company.id, runSource.companyId))
    .where(and(eq(runSource.runId, runId), eq(runSource.status, 'error')))
    .all()
    .map((e) => ({
      company: e.company,
      source: `${e.ats}/${e.org}`,
      error: e.error ?? `HTTP ${e.httpStatus ?? '?'}`,
    }));

  return {
    open: items.filter((i) => i.verdict === 'open').map((i) => i.item),
    unknown: items.filter((i) => i.verdict === 'unknown').map((i) => i.item),
    errors,
  };
}

export function matchesKeywords(title: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true;
  const t = title.toLocaleLowerCase('en');
  return keywords.some((k) => t.includes(k.toLocaleLowerCase('en')));
}

type Band = typeof compensation.$inferSelect;

function formatBand(b: Band): string {
  const amount = (n: number | null) =>
    n === null ? '?' : n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
  const range = b.min === b.max ? amount(b.min) : `${amount(b.min)}–${amount(b.max)}`;
  return `${b.currency ?? ''} ${range}${b.period ? ` / ${b.period}` : ''}`.trim();
}

/** Only comparable bands are judged; a different currency or period is never "below". */
function isBelowFloor(b: Band, floor: Profile['salaryFloor']): boolean {
  if (!floor || b.currency !== floor.currency || b.period !== floor.period) return false;
  const top = b.max ?? b.min;
  return top !== null && top < floor.amount;
}
