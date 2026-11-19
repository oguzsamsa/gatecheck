import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.ts';
import { company, eligibility, locationClaim, posting } from '../../src/db/schema.ts';
import { evaluateOpenPostings } from '../../src/eligibility/evaluate.ts';

let db: Db;
const t0 = new Date(Date.UTC(2026, 10, 1));

function addPosting(id: string, countries: string[], closed = false): number {
  const companyId = db.select().from(company).get()?.id ?? 0;
  const p = db
    .insert(posting)
    .values({
      companyId,
      atsPostingId: id,
      title: id,
      url: `https://example.test/${id}`,
      firstSeenAt: t0,
      lastSeenAt: t0,
      closedAt: closed ? t0 : null,
    })
    .returning()
    .get();
  for (const c of countries) {
    db.insert(locationClaim)
      .values({ postingId: p.id, kind: 'remote_region', countryCode: c as 'TR', raw: c })
      .run();
  }
  return p.id;
}

beforeEach(() => {
  db = openDb(':memory:');
  db.insert(company).values({ name: 'Acme', ats: 'ashby', orgSlug: 'acme', addedAt: t0 }).run();
});

describe('evaluateOpenPostings', () => {
  it('stores a verdict per open posting and reports first evaluations as changes', () => {
    const open = addPosting('open', ['TR']);
    const closedList = addPosting('closed-list', ['US']);
    addPosting('gone', ['TR'], true);

    const changes = evaluateOpenPostings(db, 'TR', t0);

    expect(changes.map((c) => [c.postingId, c.from, c.to])).toEqual([
      [open, null, 'open'],
      [closedList, null, 'closed'],
    ]);
    expect(db.select().from(eligibility).all()).toHaveLength(2);
  });

  it('reports only verdicts that changed on later runs', () => {
    const id = addPosting('p', ['TR']);
    evaluateOpenPostings(db, 'TR', t0);
    expect(evaluateOpenPostings(db, 'TR', t0)).toEqual([]);

    db.delete(locationClaim).where(eq(locationClaim.postingId, id)).run();
    db.insert(locationClaim)
      .values({ postingId: id, kind: 'remote_region', countryCode: 'PL', raw: 'Poland' })
      .run();

    expect(evaluateOpenPostings(db, 'TR', t0)).toMatchObject([
      { postingId: id, from: 'open', to: 'closed', reason: 'limited to PL (remote)' },
    ]);
  });
});
