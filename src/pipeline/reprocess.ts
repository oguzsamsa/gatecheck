/**
 * Re-reads stored postings with the current adapters.
 *
 * Ingest derives location claims and salary bands only when a posting's content changes, so
 * a fix to an adapter or the place resolver would otherwise never reach postings that stay
 * the same on the board. This replays each open posting's latest stored payload through
 * `normalize` (which is pure) and replaces its claims and bands. No network, no new
 * versions: the posting did not change, our reading of it did. Verdicts are left to the
 * next evaluation, which records any that flip.
 */
import { desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { company, compensation, locationClaim, posting, postingVersion } from '../db/schema.ts';
import type { Ats } from '../domain/types.ts';
import type { BoardSource } from '../sources/types.ts';

export interface ReprocessReport {
  postings: number;
  /** Postings whose claims or bands came out different. */
  changed: number;
  failed: { postingId: number; error: string }[];
}

export function reprocessPostings(db: Db, sources: Record<Ats, BoardSource>): ReprocessReport {
  const report: ReprocessReport = { postings: 0, changed: 0, failed: [] };
  const open = db
    .select({ id: posting.id, ats: company.ats })
    .from(posting)
    .innerJoin(company, eq(company.id, posting.companyId))
    .where(isNull(posting.closedAt))
    .all();

  /** Rows as sets of their meaningful fields: no ids, no nulls, key order ignored. */
  const comparable = (rows: object[]) =>
    JSON.stringify(
      rows
        .map((r) =>
          JSON.stringify(
            Object.entries(r)
              .filter(([k, v]) => k !== 'id' && k !== 'postingId' && v != null)
              .sort(([a], [b]) => a.localeCompare(b)),
          ),
        )
        .sort(),
    );

  db.transaction((tx) => {
    for (const p of open) {
      const latest = tx
        .select({ payload: postingVersion.payloadJson })
        .from(postingVersion)
        .where(eq(postingVersion.postingId, p.id))
        .orderBy(desc(postingVersion.id))
        .limit(1)
        .get();
      if (!latest) continue;
      report.postings++;

      let n;
      try {
        n = sources[p.ats].normalize(latest.payload);
      } catch (e) {
        report.failed.push({ postingId: p.id, error: e instanceof Error ? e.message : String(e) });
        continue;
      }

      const before =
        comparable(tx.select().from(locationClaim).where(eq(locationClaim.postingId, p.id)).all()) +
        comparable(tx.select().from(compensation).where(eq(compensation.postingId, p.id)).all());
      const after = comparable(n.locations) + comparable(n.compensation);
      if (before === after) continue;
      report.changed++;

      tx.delete(locationClaim).where(eq(locationClaim.postingId, p.id)).run();
      tx.delete(compensation).where(eq(compensation.postingId, p.id)).run();
      if (n.locations.length > 0) {
        tx.insert(locationClaim)
          .values(n.locations.map((c) => ({ postingId: p.id, ...c })))
          .run();
      }
      if (n.compensation.length > 0) {
        tx.insert(compensation)
          .values(n.compensation.map((c) => ({ postingId: p.id, ...c })))
          .run();
      }
    }
  });
  return report;
}
