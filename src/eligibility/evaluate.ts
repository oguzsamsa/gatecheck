import { inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { eligibility, locationClaim, posting, type Verdict } from '../db/schema.ts';
import type { CountryCode } from '../geo/countries.ts';
import { decide } from './rules.ts';

export interface VerdictChange {
  postingId: number;
  from: Verdict | null;
  to: Verdict;
  reason: string;
}

/**
 * Re-evaluates every open posting and stores the current verdict. Cheap enough to run in
 * full each time, which keeps verdicts consistent when the rules themselves change.
 * Returns the postings whose verdict changed (including first evaluations).
 */
export function evaluateOpenPostings(db: Db, applicant: CountryCode, now: Date): VerdictChange[] {
  const openIds = db
    .select({ id: posting.id })
    .from(posting)
    .where(isNull(posting.closedAt))
    .all()
    .map((p) => p.id);
  if (openIds.length === 0) return [];

  const claimsByPosting = Map.groupBy(
    db.select().from(locationClaim).where(inArray(locationClaim.postingId, openIds)).all(),
    (c) => c.postingId,
  );
  const previous = new Map(
    db
      .select({ postingId: eligibility.postingId, verdict: eligibility.verdict })
      .from(eligibility)
      .where(inArray(eligibility.postingId, openIds))
      .all()
      .map((e) => [e.postingId, e.verdict]),
  );

  const changes: VerdictChange[] = [];
  db.transaction((tx) => {
    for (const postingId of openIds) {
      const { verdict, reason } = decide(claimsByPosting.get(postingId) ?? [], applicant);
      tx.insert(eligibility)
        .values({ postingId, verdict, reason, evaluatedAt: now })
        .onConflictDoUpdate({
          target: eligibility.postingId,
          set: { verdict, reason, evaluatedAt: now },
        })
        .run();
      const from = previous.get(postingId) ?? null;
      if (from !== verdict) changes.push({ postingId, from, to: verdict, reason });
    }
  });
  return changes;
}
