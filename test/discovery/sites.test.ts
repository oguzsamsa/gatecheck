import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.ts';
import { company, discoveryMiss } from '../../src/db/schema.ts';
import { careersLinks, detectInHtml, detectUnsupported } from '../../src/discovery/detect.ts';
import { entryFromProfile, parseTextList, readList } from '../../src/discovery/lists.ts';
import { discoverFromSites } from '../../src/discovery/sites.ts';
import type { Ats, NormalizedPosting } from '../../src/domain/types.ts';
import { SourceError, type HttpClient } from '../../src/sources/http.ts';
import { SOURCES } from '../../src/sources/index.ts';
import type { BoardSource } from '../../src/sources/types.ts';

describe('detectInHtml on a custom domain', () => {
  it('takes a Teamtailor career site served from the page host as the board', () => {
    const html =
      '<link rel="stylesheet" href="https://assets-aws.teamtailor-cdn.com/assets/careersite-c6d1720e.css">';
    expect(detectInHtml(html, 'https://jobs.tennaxia.com/en')).toEqual([
      { ats: 'teamtailor', org: 'jobs.tennaxia.com' },
    ]);
    // Without the page URL there is no host to name the board by.
    expect(detectInHtml(html)).toEqual([]);
    // A Teamtailor image alone (say, a logo on a partner page) is not a career site.
    expect(
      detectInHtml('<img src="https://images.teamtailor-cdn.com/x.png">', 'https://a.test/'),
    ).toEqual([]);
  });
});

describe('detectInHtml dedupe', () => {
  it('treats board slugs differing only in case as one board', () => {
    expect(
      detectInHtml(
        '<a href="https://jobs.ashbyhq.com/Svix">Jobs</a><a href="https://jobs.ashbyhq.com/svix/1">x</a>',
      ),
    ).toEqual([{ ats: 'ashby', org: 'Svix' }]);
  });
});

describe('detectUnsupported', () => {
  it('names the ATSes a page points at that have no adapter', () => {
    expect(
      detectUnsupported(
        '<a href="https://proofpoint.wd5.myworkdayjobs.com/ProofpointCareers">Jobs</a>' +
          '<iframe src="https://acme.jobs.personio.de/"></iframe>',
      ),
    ).toEqual(['workday', 'personio']);
    expect(detectUnsupported('<p>We are hiring!</p>')).toEqual([]);
  });
});

describe('careersLinks', () => {
  const home = 'https://www.acme.test/';
  it('picks same-site and hosted-board links that look like a careers page', () => {
    const html = `
      <a href="/about">About</a>
      <a href="/company/careers#top">Careers</a>
      <a href="https://jobs.acme.test/">Open roles</a>
      <a href="https://jobs.lever.co/acme">Work with us</a>
      <a href="https://twitter.com/acme/jobs">jobs on X</a>
      <a href="mailto:jobs@acme.test">Email</a>`;
    expect(careersLinks(html, home)).toEqual([
      'https://www.acme.test/company/careers',
      'https://jobs.acme.test/',
      'https://jobs.lever.co/acme',
    ]);
  });

  it('matches on the link text too', () => {
    expect(careersLinks('<a href="/team"><span>Join us</span></a>', home)).toEqual([
      'https://www.acme.test/team',
    ]);
  });
});

describe('lists', () => {
  it('parses a text list of URLs, optionally named', () => {
    expect(
      parseTextList(`
        # Turkish companies
        Insider | https://useinsider.com/careers/
        https://jobs.lever.co/acme   # straight to the board
        not a url
      `),
    ).toEqual([
      { name: 'Insider', urls: ['https://useinsider.com/careers/'] },
      { name: 'jobs.lever.co', urls: ['https://jobs.lever.co/acme'] },
    ]);
  });

  it('reads remoteintech company profiles, careers page first', () => {
    const profile = `---
title: "42 Technologies"
slug: 42-technologies
website: https://www.42technologies.com/
careers_url: https://www.42technologies.com/careers
region: worldwide
---

## Company blurb`;
    expect(entryFromProfile(profile)).toEqual({
      name: '42 Technologies',
      urls: ['https://www.42technologies.com/careers', 'https://www.42technologies.com/'],
    });
    expect(entryFromProfile('---\ntitle: No links\n---')).toBeNull();
    expect(entryFromProfile('no front matter')).toBeNull();
  });

  it('reads a directory of profiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gatecheck-list-'));
    writeFileSync(join(dir, 'b.md'), '---\ntitle: Beta\nwebsite: https://beta.test/\n---\n');
    writeFileSync(join(dir, 'a.md'), '---\ntitle: Alpha\nwebsite: https://alpha.test/\n---\n');
    writeFileSync(join(dir, 'companies.json'), '{}');
    expect(readList(dir).map((e) => e.name)).toEqual(['Alpha', 'Beta']);
  });
});

describe('discoverFromSites', () => {
  let db: Db;
  const now = () => new Date(Date.UTC(2026, 10, 19));

  /** Boards that exist, by "ats/org". */
  function sourcesWith(boards: string[]) {
    const fake = (ats: Ats): BoardSource<string> => ({
      ats,
      fetch(org) {
        if (!boards.includes(`${ats}/${org}`))
          return Promise.reject(new SourceError('HTTP 404', { url: org, httpStatus: 404 }));
        return Promise.resolve({
          status: 'ok',
          httpStatus: 200,
          postings: [],
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
    return Object.fromEntries(Object.keys(SOURCES).map((ats) => [ats, fake(ats as Ats)])) as Record<
      Ats,
      BoardSource
    >;
  }

  /** A web of pages by URL; anything else is unreachable. */
  function site(pages: Record<string, string>) {
    const fetched: string[] = [];
    const http: HttpClient = {
      getJson: () => Promise.reject(new Error('unused')),
      getText: (url) => {
        fetched.push(url);
        const body = pages[url];
        if (body === undefined) return Promise.reject(new SourceError('HTTP 404', { url }));
        return Promise.resolve({
          status: 'ok',
          httpStatus: 200,
          body,
          validators: { etag: null, lastModified: null },
        });
      },
    };
    return { http, fetched };
  }

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('follows a careers link from the home page to a hosted board', async () => {
    const { http } = site({
      'https://acme.test/': '<a href="/careers">Careers</a>',
      'https://acme.test/careers': '<a href="https://jobs.ashbyhq.com/acme">See roles</a>',
    });
    const report = await discoverFromSites(
      { db, http, sources: sourcesWith(['ashby/acme']), now },
      [{ name: 'Acme', urls: ['https://acme.test/'] }],
      { limit: 10 },
    );
    expect(report.added).toEqual([
      {
        company: 'Acme',
        ats: 'ashby',
        org: 'acme',
        page: 'https://acme.test/careers',
      },
    ]);
    expect(db.select().from(company).all()).toMatchObject([
      { name: 'Acme', ats: 'ashby', orgSlug: 'acme', careersUrl: 'https://acme.test/careers' },
    ]);
  });

  it('takes a careers URL that is itself a board without fetching a page', async () => {
    const { http, fetched } = site({});
    const report = await discoverFromSites(
      { db, http, sources: sourcesWith(['workable/civica-uk-ltd-1']), now },
      [{ name: 'Civica', urls: ['https://apply.workable.com/civica-uk-ltd-1/'] }],
      { limit: 10 },
    );
    expect(report.added).toMatchObject([{ ats: 'workable', org: 'civica-uk-ltd-1' }]);
    expect(fetched).toEqual([]);
  });

  it('tallies unsupported ATSes and remembers the miss', async () => {
    const { http } = site({
      'https://big.test/careers': '<a href="https://big.wd1.myworkdayjobs.com/Careers">Apply</a>',
    });
    const report = await discoverFromSites(
      { db, http, sources: sourcesWith([]), now },
      [{ name: 'BigCo', urls: ['https://big.test/careers'] }],
      { limit: 10 },
    );
    expect(report.added).toEqual([]);
    expect([...report.unsupported]).toEqual([['workday', ['BigCo']]]);
    expect(report.notFound).toEqual(['BigCo']);
    expect(db.select().from(discoveryMiss).all()).toMatchObject([{ name: 'BigCo' }]);
  });

  it('drops a board link that does not resolve, and reports unreachable sites', async () => {
    const { http } = site({
      'https://dead.test/': '<a href="https://jobs.lever.co/gone">Jobs</a>',
    });
    const report = await discoverFromSites(
      { db, http, sources: sourcesWith([]), now },
      [
        { name: 'Dead', urls: ['https://dead.test/'] },
        { name: 'Down', urls: ['https://down.test/'] },
      ],
      { limit: 10 },
    );
    expect(report.added).toEqual([]);
    expect(report.notFound).toEqual(['Dead']);
    expect(report.errors).toEqual([{ company: 'Down', error: 'HTTP 404' }]);
  });

  it('skips watched companies, recent misses and duplicates; counts known boards; dry run writes nothing', async () => {
    db.insert(company)
      .values({ name: 'Codeway', ats: 'ashby', orgSlug: 'codeway', addedAt: now() })
      .run();
    db.insert(discoveryMiss).values({ nameKey: 'tried', name: 'Tried', lastTriedAt: now() }).run();
    const { http } = site({});
    const report = await discoverFromSites(
      { db, http, sources: sourcesWith(['ashby/codeway', 'lever/new']), now },
      [
        { name: 'Codeway', urls: ['https://jobs.ashbyhq.com/codeway'] },
        { name: 'Tried', urls: ['https://tried.test/'] },
        { name: 'Codeway Games', urls: ['https://jobs.ashbyhq.com/codeway'] },
        { name: 'New', urls: ['https://jobs.lever.co/new'] },
        { name: 'new', urls: ['https://jobs.lever.co/new'] },
      ],
      { limit: 10, dryRun: true },
    );
    expect(report.skipped).toBe(3);
    expect(report.known).toBe(1);
    expect(report.added).toMatchObject([{ company: 'New' }]);
    expect(db.select().from(company).all()).toHaveLength(1);
    expect(db.select().from(discoveryMiss).all()).toHaveLength(1);
  });

  it('respects the limit', async () => {
    const { http, fetched } = site({});
    await discoverFromSites(
      { db, http, sources: sourcesWith([]), now },
      [
        { name: 'One', urls: ['https://one.test/'] },
        { name: 'Two', urls: ['https://two.test/'] },
      ],
      { limit: 1 },
    );
    expect(fetched).toEqual(['https://one.test/']);
  });
});
