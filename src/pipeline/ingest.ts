import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import {
  compensation,
  locationClaim,
  posting,
  postingChange,
  postingVersion,
} from '../db/schema.ts';
import type { NormalizedPosting } from '../domain/types.ts';
import { diffPostings } from './diff.ts';
import { contentHash } from './hash.ts';

export interface FetchedPosting {
  raw: unknown;
  normalized: NormalizedPosting;
  /** What the content hash covers; defaults to `raw`. */
  fingerprint?: unknown;
}

export interface IngestResult {
  created: number;
  /** Existing postings whose payload changed (a new posting_version was stored). */
  changed: number;
  closed: number;
  reopened: number;
}

/**
 * Stores one company's complete current board, atomically.
 *
 * - new posting → row + first version + claims
 * - same content hash → only `last_seen_at` moves
 * - different hash → new version; claims and compensation are replaced, and any change in
 *   places, salary band or title is recorded in posting_change
 * - open posting missing from the board → closed; a closed one reappearing → reopened
 */
export function ingestBoard(
  db: Db,
  companyId: number,
  postings: FetchedPosting[],
  now: Date,
): IngestResult {
  const result: IngestResult = { created: 0, changed: 0, closed: 0, reopened: 0 };

  db.transaction((tx) => {
    for (const { raw, normalized: n, fingerprint = raw } of postings) {
      const hash = contentHash(fingerprint);
      const fields = {
        title: n.title,
        url: n.url,
        department: n.department,
        employmentType: n.employmentType,
        postedAt: n.postedAt,
        lastSeenAt: now,
        closedAt: null,
      };

      const existing = tx
        .select({ id: posting.id, title: posting.title, closedAt: posting.closedAt })
        .from(posting)
        .where(and(eq(posting.companyId, companyId), eq(posting.atsPostingId, n.atsPostingId)))
        .get();

      let postingId: number;
      if (existing) {
        postingId = existing.id;
        if (existing.closedAt) result.reopened++;
        tx.update(posting).set(fields).where(eq(posting.id, postingId)).run();
      } else {
        postingId = tx
          .insert(posting)
          .values({ companyId, atsPostingId: n.atsPostingId, firstSeenAt: now, ...fields })
          .returning({ id: posting.id })
          .get().id;
        result.created++;
      }

      const latest = tx
        .select({ contentHash: postingVersion.contentHash })
        .from(postingVersion)
        .where(eq(postingVersion.postingId, postingId))
        .orderBy(desc(postingVersion.id))
        .limit(1)
        .get();
      if (latest?.contentHash === hash) continue;
      if (latest && existing) {
        result.changed++;
        const changes = diffPostings(
          {
            title: existing.title,
            locations: tx
              .select()
              .from(locationClaim)
              .where(eq(locationClaim.postingId, postingId))
              .all(),
            compensation: tx
              .select()
              .from(compensation)
              .where(eq(compensation.postingId, postingId))
              .all(),
          },
          n,
        );
        if (changes.length > 0) {
          tx.insert(postingChange)
            .values(changes.map((c) => ({ postingId, detectedAt: now, ...c })))
            .run();
        }
      }

      tx.insert(postingVersion)
        .values({ postingId, fetchedAt: now, contentHash: hash, payloadJson: raw })
        .run();
      tx.delete(locationClaim).where(eq(locationClaim.postingId, postingId)).run();
      tx.delete(compensation).where(eq(compensation.postingId, postingId)).run();
      if (n.locations.length > 0) {
        tx.insert(locationClaim)
          .values(n.locations.map((c) => ({ postingId, ...c })))
          .run();
      }
      if (n.compensation.length > 0) {
        tx.insert(compensation)
          .values(n.compensation.map((c) => ({ postingId, ...c })))
          .run();
      }
    }

    const seen = postings.map((p) => p.normalized.atsPostingId);
    result.closed = tx
      .update(posting)
      .set({ closedAt: now })
      .where(
        and(
          eq(posting.companyId, companyId),
          isNull(posting.closedAt),
          seen.length > 0 ? notInArray(posting.atsPostingId, seen) : undefined,
        ),
      )
      .run().changes;
  });

  return result;
}

/** A 304 means the board is unchanged: everything open is still there. */
export function touchBoard(db: Db, companyId: number, now: Date): void {
  db.update(posting)
    .set({ lastSeenAt: now })
    .where(and(eq(posting.companyId, companyId), isNull(posting.closedAt)))
    .run();
}
