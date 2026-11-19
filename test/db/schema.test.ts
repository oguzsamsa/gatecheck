import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.ts';
import { company, locationClaim, notification, posting } from '../../src/db/schema.ts';

let db: Db;
let postingId: number;

beforeEach(() => {
  db = openDb(':memory:');
  const now = new Date();
  const c = db
    .insert(company)
    .values({ name: 'Codeway', ats: 'ashby', orgSlug: 'codeway', addedAt: now })
    .returning()
    .get();
  const p = db
    .insert(posting)
    .values({
      companyId: c.id,
      atsPostingId: 'abc',
      title: 'Product Designer',
      url: 'https://jobs.ashbyhq.com/codeway/abc',
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .returning()
    .get();
  postingId = p.id;
});

describe('schema', () => {
  it('stores a claim with either a country or a region', () => {
    db.insert(locationClaim)
      .values([
        { postingId, kind: 'office', countryCode: 'TR', city: 'Istanbul', raw: 'Istanbul' },
        { postingId, kind: 'remote_region', region: 'EMEA', raw: 'Remote, EMEA' },
        { postingId, kind: 'remote_region', raw: 'Remote' },
      ])
      .run();
    expect(db.select().from(locationClaim).all()).toHaveLength(3);
  });

  it('rejects a claim that is both a country and a region', () => {
    expect(() =>
      db
        .insert(locationClaim)
        .values({ postingId, kind: 'office', countryCode: 'TR', region: 'EMEA', raw: 'x' })
        .run(),
    ).toThrow(/CHECK constraint failed: location_claim_country_or_region_ck/);
  });

  it('rejects an unknown claim kind', () => {
    expect(() =>
      db
        .insert(locationClaim)
        // @ts-expect-error -- deliberately bypassing the TS enum to hit the DB constraint
        .values({ postingId, kind: 'somewhere', raw: 'x' })
        .run(),
    ).toThrow(/CHECK constraint failed: location_claim_kind_ck/);
  });

  it('notifies a posting at most once per channel', () => {
    const row = { postingId, channel: 'telegram' as const, sentAt: new Date() };
    db.insert(notification).values(row).run();
    expect(() => db.insert(notification).values(row).run()).toThrow(/UNIQUE constraint failed/);
  });

  it('cascades posting deletes to its claims', () => {
    db.insert(locationClaim).values({ postingId, kind: 'remote_region', raw: 'Remote' }).run();
    db.delete(posting).where(eq(posting.id, postingId)).run();
    expect(db.select().from(locationClaim).all()).toEqual([]);
  });
});
