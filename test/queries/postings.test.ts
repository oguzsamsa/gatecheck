import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.ts';
import { openReadonlyDb } from '../../src/db/readonly.ts';
import {
  company,
  compensation,
  eligibility,
  locationClaim,
  posting,
  postingChange,
  postingVersion,
  run,
  runSource,
  type Verdict,
} from '../../src/db/schema.ts';
import { facets, lastRun, listPostings, postingDetail } from '../../src/queries/postings.ts';

let db: Db;
const day = (n: number) => new Date(Date.UTC(2026, 10, n));

function seed() {
  const acme = db
    .insert(company)
    .values({ name: 'Acme', ats: 'ashby', orgSlug: 'acme', addedAt: day(1) })
    .returning()
    .get().id;
  const globex = db
    .insert(company)
    .values({ name: 'Globex', ats: 'lever', orgSlug: 'globex', addedAt: day(1) })
    .returning()
    .get().id;
  const add = (
    companyId: number,
    title: string,
    verdict: Verdict,
    country: 'TR' | 'US',
    seen: number,
    closed = false,
  ) => {
    const id = db
      .insert(posting)
      .values({
        companyId,
        atsPostingId: title,
        title,
        url: `https://x.test/${title}`,
        firstSeenAt: day(seen),
        lastSeenAt: day(seen),
        closedAt: closed ? day(seen + 1) : null,
      })
      .returning()
      .get().id;
    db.insert(eligibility)
      .values({ postingId: id, verdict, reason: `${verdict} reason`, evaluatedAt: day(seen) })
      .run();
    db.insert(locationClaim)
      .values({ postingId: id, kind: 'remote_region', countryCode: country, raw: country })
      .run();
    return id;
  };
  return {
    acme,
    open: add(acme, 'Backend Engineer', 'open', 'TR', 3),
    closed: add(globex, 'Sales Lead', 'closed', 'US', 2),
    unknown: add(globex, 'Data Engineer', 'unknown', 'US', 4),
    gone: add(acme, 'Old Engineer', 'open', 'TR', 1, true),
  };
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('listPostings', () => {
  it('lists open postings newest first with places and verdicts', () => {
    const ids = seed();
    const { rows, total } = listPostings(db);
    expect(total).toBe(3);
    expect(rows.map((r) => r.id)).toEqual([ids.unknown, ids.open, ids.closed]);
    expect(rows[1]).toMatchObject({ company: 'Acme', verdict: 'open', places: ['TR (remote)'] });
  });

  it('filters by verdict, text, company and country', () => {
    const ids = seed();
    expect(listPostings(db, { verdicts: ['open', 'unknown'] }).rows.map((r) => r.id)).toEqual([
      ids.unknown,
      ids.open,
    ]);
    expect(listPostings(db, { q: 'engineer' }).total).toBe(2);
    expect(listPostings(db, { q: 'globex' }).total).toBe(2);
    expect(listPostings(db, { companyId: ids.acme }).rows.map((r) => r.id)).toEqual([ids.open]);
    expect(listPostings(db, { country: 'tr' }).rows.map((r) => r.id)).toEqual([ids.open]);
    expect(listPostings(db, { includeClosed: true }).total).toBe(4);
  });

  it('pages', () => {
    seed();
    const page = listPostings(db, { limit: 2, offset: 2 });
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(1);
  });

  it('treats LIKE wildcards in the search box as text', () => {
    seed();
    expect(listPostings(db, { q: '%' }).total).toBe(3);
  });
});

describe('facets / postingDetail / lastRun', () => {
  it('counts verdicts and open postings per company', () => {
    seed();
    const f = facets(db);
    expect(f.verdicts).toEqual({ open: 1, closed: 1, unknown: 1 });
    expect(f.companies.map((c) => [c.name, c.open])).toEqual([
      ['Acme', 1],
      ['Globex', 2],
    ]);
  });

  it('assembles a posting with its history', () => {
    const ids = seed();
    db.insert(compensation)
      .values({
        postingId: ids.open,
        min: 60_000,
        max: 80_000,
        currency: 'EUR',
        period: 'year',
        source: 't',
      })
      .run();
    db.insert(postingVersion)
      .values({ postingId: ids.open, fetchedAt: day(3), contentHash: 'a', payloadJson: {} })
      .run();
    db.insert(postingChange)
      .values({
        postingId: ids.open,
        detectedAt: day(5),
        kind: 'verdict',
        before: 'unknown',
        after: 'open: r',
      })
      .run();

    const detail = postingDetail(db, ids.open);
    expect(detail).toMatchObject({
      title: 'Backend Engineer',
      verdict: 'open',
      compensation: ['EUR 60K–80K / year'],
      versions: [{ contentHash: 'a' }],
      changes: [{ kind: 'verdict' }],
      analysis: null,
    });
    expect(postingDetail(db, 9999)).toBeNull();
  });

  it('reports the latest run and its failing sources', () => {
    const ids = seed();
    expect(lastRun(db)).toBeNull();
    const runId = db
      .insert(run)
      .values({ startedAt: day(5), status: 'partial' })
      .returning()
      .get().id;
    db.insert(runSource)
      .values({
        runId,
        companyId: ids.acme,
        status: 'error',
        httpStatus: 404,
        error: 'HTTP 404',
        startedAt: day(5),
        durationMs: 1,
      })
      .run();
    expect(lastRun(db)).toMatchObject({
      status: 'partial',
      errors: [{ company: 'Acme', httpStatus: 404 }],
    });
  });
});

describe('openReadonlyDb', () => {
  it('reads a database the poller wrote, and refuses to write', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gatecheck-ro-')), 'db.sqlite');
    db = openDb(path);
    seed();
    const ro = openReadonlyDb(path);
    expect(listPostings(ro).total).toBe(3);
    expect(() =>
      ro
        .insert(company)
        .values({ name: 'X', ats: 'ashby', orgSlug: 'x', addedAt: day(1) })
        .run(),
    ).toThrow(/readonly/);
  });
});
