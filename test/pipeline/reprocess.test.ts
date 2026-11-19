import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.ts';
import { company, locationClaim, posting, postingVersion } from '../../src/db/schema.ts';
import type { Ats, NormalizedPosting } from '../../src/domain/types.ts';
import { reprocessPostings } from '../../src/pipeline/reprocess.ts';
import { SOURCES } from '../../src/sources/index.ts';
import type { BoardSource } from '../../src/sources/types.ts';

const day = new Date(Date.UTC(2026, 10, 19));

/** Every ATS reads a payload `{ country }` as one remote claim for that country. */
const fake = (ats: Ats): BoardSource => ({
  ats,
  fetch: () => Promise.reject(new Error('offline')),
  normalize: (raw: unknown): NormalizedPosting => {
    const { country } = raw as { country: string };
    if (country === 'boom') throw new Error('unreadable');
    return {
      atsPostingId: 'x',
      title: 'x',
      url: '',
      department: null,
      employmentType: null,
      postedAt: null,
      locations: [
        {
          kind: 'remote_region',
          countryCode: country as 'TR',
          region: null,
          city: null,
          raw: country,
        },
      ],
      compensation: [],
    };
  },
});
const sources = Object.fromEntries(
  Object.keys(SOURCES).map((ats) => [ats, fake(ats as Ats)]),
) as Record<Ats, BoardSource>;

describe('reprocessPostings', () => {
  it('replaces stale claims from the stored payload, leaving matching ones and closed postings', () => {
    const db = openDb(':memory:');
    const companyId = db
      .insert(company)
      .values({ name: 'Acme', ats: 'ashby', orgSlug: 'acme', addedAt: day })
      .returning()
      .get().id;
    const add = (id: string, payload: unknown, claimed: string, closed = false) => {
      const postingId = db
        .insert(posting)
        .values({
          companyId,
          atsPostingId: id,
          title: id,
          url: '',
          firstSeenAt: day,
          lastSeenAt: day,
          closedAt: closed ? day : null,
        })
        .returning()
        .get().id;
      db.insert(postingVersion)
        .values({ postingId, fetchedAt: day, contentHash: id, payloadJson: payload })
        .run();
      db.insert(locationClaim)
        .values({ postingId, kind: 'remote_region', countryCode: claimed as 'TR', raw: claimed })
        .run();
      return postingId;
    };
    const stale = add('stale', { country: 'FR' }, 'US');
    const same = add('same', { country: 'TR' }, 'TR');
    const gone = add('gone', { country: 'FR' }, 'US', true);
    const broken = add('broken', { country: 'boom' }, 'US');

    const report = reprocessPostings(db, sources);

    expect(report).toEqual({
      postings: 3,
      changed: 1,
      failed: [{ postingId: broken, error: 'unreadable' }],
    });
    const claimOf = (id: number) =>
      db.select().from(locationClaim).where(eq(locationClaim.postingId, id)).all()[0]?.countryCode;
    expect(claimOf(stale)).toBe('FR');
    expect(claimOf(same)).toBe('TR');
    expect(claimOf(gone)).toBe('US');
    expect(claimOf(broken)).toBe('US');
  });
});
