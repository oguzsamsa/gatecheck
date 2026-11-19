import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.ts';
import { company, discoveryMiss } from '../../src/db/schema.ts';
import { himalayas, weworkremotely, type Listing } from '../../src/discovery/aggregators.ts';
import { detectFromUrl, detectInHtml } from '../../src/discovery/detect.ts';
import { discover, sameTitle, slugCandidates } from '../../src/discovery/discover.ts';
import type { Ats, NormalizedPosting } from '../../src/domain/types.ts';
import { SourceError, type HttpClient, type HttpResponse } from '../../src/sources/http.ts';
import { SOURCES } from '../../src/sources/index.ts';
import type { BoardSource } from '../../src/sources/types.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/discovery/${name}`, import.meta.url), 'utf8');

const ok = <B>(body: B): HttpResponse<B> => ({
  status: 'ok',
  httpStatus: 200,
  body,
  validators: { etag: null, lastModified: null },
});

describe('detectFromUrl', () => {
  it.each([
    ['https://jobs.ashbyhq.com/codeway/1234', 'ashby', 'codeway'],
    ['https://job-boards.greenhouse.io/gitlab/jobs/8638232002', 'greenhouse', 'gitlab'],
    ['https://boards.greenhouse.io/embed/job_board?for=stripe&b=x', 'greenhouse', 'stripe'],
    ['https://jobs.lever.co/spotify/2a55d6c9', 'lever', 'spotify'],
    ['https://apply.workable.com/blueground/j/BA193E747D/', 'workable', 'blueground'],
    ['https://cyberarrow.recruitee.com/o/qa-engineer', 'recruitee', 'cyberarrow'],
    ['https://acme.teamtailor.com/jobs/1-engineer', 'teamtailor', 'acme.teamtailor.com'],
  ])('%s → %s/%s', (url, ats, org) => {
    expect(detectFromUrl(url)).toEqual({ ats, org });
  });

  it('rejects non-board and template URLs', () => {
    expect(detectFromUrl('https://apply.workable.com/j/BA193E747D')).toBeNull();
    expect(detectFromUrl('https://jobs.ashbyhq.com/${board}/embed')).toBeNull();
    expect(detectFromUrl('https://example.com/careers')).toBeNull();
    expect(detectFromUrl('not a url')).toBeNull();
  });
});

describe('detectInHtml', () => {
  it("finds an Ashby board embedded under a custom domain (FunnelFox's careers page)", () => {
    expect(detectInHtml(fixture('funnelfox-careers.html'))).toEqual([
      { ats: 'ashby', org: 'jobs.funnelfox.com' },
    ]);
  });
});

describe('slugCandidates / sameTitle', () => {
  it('derives slugs from a company name, legal suffixes optional', () => {
    expect(slugCandidates('Proxify AB')).toEqual(['proxify-ab', 'proxify', 'proxifyab']);
    expect(slugCandidates('Grafana Labs')).toEqual(['grafana-labs', 'grafanalabs', 'grafana']);
    expect(slugCandidates('Ödeal')).toEqual(['odeal']);
  });

  it('compares titles after folding', () => {
    expect(sameTitle('Senior Backend Engineer', 'senior backend engineer!')).toBe(true);
    expect(sameTitle('Staff Field Engineer | US | Remote', 'Staff Field Engineer')).toBe(true);
    expect(sameTitle('Engineer', 'Engineer II')).toBe(false);
  });
});

describe('aggregators', () => {
  it('reads company and title from WeWorkRemotely feeds', async () => {
    const http: HttpClient = {
      getJson: () => Promise.reject(new Error('unused')),
      getText: () => Promise.resolve(ok(fixture('weworkremotely.rss'))),
    };
    const listings = await weworkremotely.listings(http, { pages: 1 });
    expect(listings.map((l) => [l.company, l.title])).toEqual([
      ['Proxify AB', 'Senior Fullstack Developer (React.js / Node.js)'],
      ['CircleCI', 'Senior Software Engineer, Query'],
      ['Gemini', 'Senior Data Engineer'],
    ]);
  });

  it('reads Himalayas API pages', async () => {
    const http: HttpClient = {
      getJson: () => Promise.resolve(ok(JSON.parse(fixture('himalayas.json')) as unknown)),
      getText: () => Promise.reject(new Error('unused')),
    };
    const listings = await himalayas.listings(http, { pages: 1 });
    expect(listings[0]).toMatchObject({
      company: 'Grafana Labs',
      title: 'Staff Field Engineer | US | Remote',
      url: 'https://himalayas.app/companies/grafana-labs/jobs/staff-field-engineer-us-remote',
    });
  });
});

describe('discover', () => {
  let db: Db;
  const now = () => new Date(Date.UTC(2026, 10, 19));

  /** Boards that exist, by "ats/org", each with its posting titles. */
  function sourcesWith(boards: Record<string, string[]>) {
    const probed: string[] = [];
    const fake = (ats: Ats): BoardSource<string> => ({
      ats,
      fetch(org) {
        probed.push(`${ats}/${org}`);
        const titles = boards[`${ats}/${org}`];
        if (!titles)
          return Promise.reject(new SourceError('HTTP 404', { url: org, httpStatus: 404 }));
        return Promise.resolve({
          status: 'ok',
          httpStatus: 200,
          postings: titles,
          validators: { etag: null, lastModified: null },
        });
      },
      normalize: (title): NormalizedPosting => ({
        atsPostingId: title,
        title,
        url: '',
        department: null,
        employmentType: null,
        postedAt: null,
        locations: [],
        compensation: [],
      }),
    });
    const sources = Object.fromEntries(
      Object.keys(SOURCES).map((ats) => [ats, fake(ats as Ats)]),
    ) as Record<Ats, BoardSource>;
    return { sources, probed };
  }

  const http: HttpClient = {
    getJson: () => Promise.reject(new Error('unused')),
    getText: () => Promise.reject(new Error('unused')),
  };
  const listing = (company: string, title: string, links: string[] = []): Listing => ({
    company,
    title,
    url: `https://aggregator.test/${encodeURIComponent(title)}`,
    links,
  });

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('adds a company once a probed board carries one of its titles', async () => {
    const { sources } = sourcesWith({ 'greenhouse/circleci': ['Senior Software Engineer, Query'] });
    const report = await discover(
      { db, http, sources, now },
      [listing('CircleCI', 'Senior Software Engineer, Query')],
      { limit: 10 },
    );
    expect(report.added).toMatchObject([
      { company: 'CircleCI', ats: 'greenhouse', org: 'circleci', via: 'probe' },
    ]);
    expect(db.select().from(company).all()).toMatchObject([
      { name: 'CircleCI', ats: 'greenhouse', orgSlug: 'circleci' },
    ]);
  });

  it('rejects a namesake board that does not carry the title', async () => {
    const { sources } = sourcesWith({ 'ashby/gemini': ['Barista'] });
    const report = await discover(
      { db, http, sources, now },
      [listing('Gemini', 'Senior Data Engineer')],
      { limit: 10 },
    );
    expect(report.added).toEqual([]);
    expect(report.notFound).toEqual(['Gemini']);
    expect(db.select().from(discoveryMiss).all()).toMatchObject([{ nameKey: 'gemini' }]);
  });

  it('prefers an ATS link in the listing over probing', async () => {
    const { sources, probed } = sourcesWith({ 'lever/acme-inc': ['Engineer, Platform'] });
    const report = await discover(
      { db, http, sources, now },
      [listing('Acme', 'Engineer, Platform', ['https://jobs.lever.co/acme-inc/123'])],
      { limit: 10 },
    );
    expect(report.added).toMatchObject([{ ats: 'lever', org: 'acme-inc', via: 'link' }]);
    expect(probed).toEqual(['lever/acme-inc']);
  });

  it('skips watched companies and recent misses, and respects the limit', async () => {
    db.insert(company)
      .values({ name: 'Codeway', ats: 'ashby', orgSlug: 'codeway', addedAt: now() })
      .run();
    db.insert(discoveryMiss)
      .values({ nameKey: 'proxify ab', name: 'Proxify AB', lastTriedAt: now() })
      .run();
    const { sources, probed } = sourcesWith({});

    const report = await discover(
      { db, http, sources, now },
      [
        listing('Codeway', 'A'),
        listing('Proxify AB', 'B'),
        listing('One', 'C'),
        listing('Two', 'D'),
      ],
      { limit: 1 },
    );

    expect(report.skipped).toBe(2);
    expect(report.notFound).toEqual(['One']);
    expect(probed.every((p) => p.endsWith('/one'))).toBe(true);
  });

  it('writes nothing in a dry run', async () => {
    const { sources } = sourcesWith({ 'workable/acme': ['Engineer'] });
    await discover(
      { db, http, sources, now },
      [listing('Acme', 'Engineer'), listing('Nope', 'X')],
      {
        limit: 10,
        dryRun: true,
      },
    );
    expect(db.select().from(company).all()).toEqual([]);
    expect(db.select().from(discoveryMiss).all()).toEqual([]);
  });
});
