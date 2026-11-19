import { and, eq, gt, inArray, isNull, notExists } from 'drizzle-orm';
import type { Config } from '../config.ts';
import { formatBand } from '../domain/format.ts';
import type { Db } from '../db/client.ts';
import {
  company,
  compensation,
  eligibility,
  notification,
  posting,
  postingChange,
  runSource,
} from '../db/schema.ts';
import { describeListChange } from '../pipeline/diff.ts';

export interface DigestItem {
  postingId: number;
  company: string;
  title: string;
  url: string;
  reason: string;
  salary: string | null;
  belowFloor: boolean;
}

export interface ChangeItem {
  postingId: number;
  company: string;
  title: string;
  url: string;
  /** One human-readable line per change, e.g. "Locations: removed TR (remote)". */
  lines: string[];
  changeIds: number[];
}

export interface Digest {
  open: DigestItem[];
  unknown: DigestItem[];
  changes: ChangeItem[];
  errors: { company: string; source: string; error: string }[];
}

type Profile = Config['profile'];

/**
 * What to announce: open and unknown postings not yet sent on this channel (optionally
 * narrowed to titles matching the profile's keywords); changes to postings you were
 * already sent; and this run's failing sources, so a silent gap never looks like "no new
 * postings".
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
    changes: collectChanges(db, profile),
    errors,
  };
}

/** Pending changes detected after the posting was announced, grouped per posting. */
function collectChanges(db: Db, profile: Profile): ChangeItem[] {
  const rows = db
    .select({
      id: postingChange.id,
      kind: postingChange.kind,
      before: postingChange.before,
      after: postingChange.after,
      postingId: posting.id,
      title: posting.title,
      url: posting.url,
      company: company.name,
    })
    .from(postingChange)
    .innerJoin(posting, eq(posting.id, postingChange.postingId))
    .innerJoin(company, eq(company.id, posting.companyId))
    .innerJoin(
      notification,
      and(eq(notification.postingId, posting.id), eq(notification.channel, 'telegram')),
    )
    .where(and(isNull(postingChange.notifiedAt), gt(postingChange.detectedAt, notification.sentAt)))
    .orderBy(company.name, posting.title, postingChange.id)
    .all()
    .filter((r) => matchesKeywords(r.title, profile.titleKeywords));

  return [...Map.groupBy(rows, (r) => r.postingId).values()].map((group) => {
    const first = group[0] ?? rows[0];
    return {
      postingId: first?.postingId ?? 0,
      company: first?.company ?? '',
      title: first?.title ?? '',
      url: first?.url ?? '',
      lines: group.map(describeChange),
      changeIds: group.map((r) => r.id),
    };
  });
}

function describeChange(c: { kind: string; before: string; after: string }): string {
  switch (c.kind) {
    case 'locations':
      return `Locations: ${describeListChange(c.before, c.after)}`;
    case 'compensation':
      return `Salary: ${c.before} → ${c.after}`;
    case 'title':
      return `Title was "${c.before}"`;
    default:
      return `Verdict: ${c.before} → ${c.after}`;
  }
}

export function matchesKeywords(title: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true;
  const t = title.toLocaleLowerCase('en');
  return keywords.some((k) => t.includes(k.toLocaleLowerCase('en')));
}

type Band = typeof compensation.$inferSelect;

/** Only comparable bands are judged; a different currency or period is never "below". */
function isBelowFloor(b: Band, floor: Profile['salaryFloor']): boolean {
  if (!floor || b.currency !== floor.currency || b.period !== floor.period) return false;
  const top = b.max ?? b.min;
  return top !== null && top < floor.amount;
}
