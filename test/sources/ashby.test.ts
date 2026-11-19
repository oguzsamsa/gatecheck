import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LocationClaim, NormalizedPosting } from '../../src/domain/types.ts';
import { ashby } from '../../src/sources/ashby/index.ts';
import { AshbyBoard, type AshbyJob } from '../../src/sources/ashby/schema.ts';
import { SourceError, type HttpClient, type JsonResponse } from '../../src/sources/http.ts';

/**
 * Fixtures are real public Ashby responses (Nov 2026), trimmed to postings that each
 * exercise a normalization edge case, with descriptions shortened.
 */
const FIXTURES = new URL('../fixtures/ashby/', import.meta.url);
const boards = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

function board(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
}

function jobs(name: string): AshbyJob[] {
  return AshbyBoard.parse(board(name)).jobs;
}

function job(name: string, predicate: (job: AshbyJob) => boolean): AshbyJob {
  const found = jobs(name).find(predicate);
  if (!found) throw new Error(`fixture ${name} has no matching job`);
  return found;
}

function normalized(name: string, title: string): NormalizedPosting {
  return ashby.normalize(job(name, (j) => j.title.trim() === title));
}

/** Claims as compact, order-insensitive strings: "remote_region TR", "office GB Cambridge". */
function claims(posting: NormalizedPosting): string[] {
  const show = (c: LocationClaim) =>
    [c.kind, c.countryCode ?? c.region ?? '?', c.city].filter(Boolean).join(' ');
  return [...new Set(posting.locations.map(show))].sort();
}

describe('ashby.normalize — golden files', () => {
  it.each(boards)('%s', async (name) => {
    const output = jobs(name).map((job) => ashby.normalize(job));
    await expect(JSON.stringify(output, null, 2) + '\n').toMatchFileSnapshot(
      `../fixtures/ashby/__golden__/${name}.normalized.json`,
    );
  });
});

describe('ashby.normalize — location claims', () => {
  it('trusts workplaceType over isRemote (Ashby sets isRemote on Hybrid postings)', () => {
    const hybrid = job('codeway', (j) => j.workplaceType === 'Hybrid');
    expect(hybrid.isRemote).toBe(true);
    expect(claims(ashby.normalize(hybrid))).toEqual(['office TR Istanbul']);
  });

  it('reads every secondary location, including ones with no address', () => {
    const posting = normalized('jobs.funnelfox.com', 'Fullstack Engineer');
    expect(claims(posting)).toEqual(
      expect.arrayContaining(['remote_region TR', 'remote_region KZ Almaty', 'remote_region TH']),
    );
  });

  it('keeps the region a lossy address hides ("North America" stored as United States)', () => {
    const posting = normalized('linear', 'Senior / Staff Product Engineer');
    expect(claims(posting)).toEqual(['remote_region NORTH_AMERICA', 'remote_region US']);
  });

  it('maps "European Union" in addressCountry to a region, not a country', () => {
    const posting = normalized('linear', 'Senior / Staff Fullstack Engineer');
    expect(claims(posting)).toEqual(['remote_region EU', 'remote_region EUROPE']);
  });

  it('splits a multi-valued addressCountry ("US | EU")', () => {
    const posting = normalized('posthog', 'Technical Support Engineer');
    expect(claims(posting)).toEqual(['remote_region EU', 'remote_region US']);
  });

  it('reads the region from the label when workplaceType is null', () => {
    expect(claims(normalized('supabase', 'Support Engineer (EMEA)'))).toEqual([
      'remote_region EMEA',
    ]);
    expect(claims(normalized('supabase', 'AI Platform Engineer'))).toEqual([
      'remote_region WORLDWIDE',
    ]);
  });

  it('lets a location label override the posting-level workplaceType', () => {
    const posting = normalized('ramp', 'Chief Compliance Officer, Ramp Advisory LLC');
    expect(claims(posting)).toEqual([
      'office US Miami',
      'office US New York City',
      'office US San Fransisco',
      'remote_region CA',
      'remote_region US',
    ]);
  });

  it('does not reinterpret a US state in the label as a country', () => {
    const posting = normalized('notion', 'Enterprise Solutions Consultant (Atlanta, GA)');
    expect(claims(posting)).toEqual(['remote_region US Atlanta']);
  });

  it('keeps the raw text of every claim', () => {
    const posting = normalized('posthog', 'AI Research Engineer');
    expect(posting.locations).toEqual([
      {
        kind: 'office',
        countryCode: 'GB',
        region: null,
        city: 'Cambridge',
        raw: 'Hybrid (UK) [Cambridge, United Kingdom]',
      },
    ]);
  });
});

describe('ashby.normalize — posting fields', () => {
  it('extracts base salary and ignores equity components', () => {
    const posting = normalized('linear', 'Senior / Staff Product Engineer');
    expect(posting.compensation).toEqual([
      {
        min: 240_000,
        max: 320_000,
        currency: 'USD',
        period: 'year',
        source: 'ashby.summaryComponents',
      },
    ]);
  });

  it('maps identity and metadata', () => {
    const posting = normalized('posthog', 'Technical Support Engineer');
    expect(posting).toMatchObject({
      atsPostingId: 'db808740-242e-4a40-ad43-d41f26c049d7',
      title: 'Technical Support Engineer',
      employmentType: 'full_time',
      url: 'https://jobs.ashbyhq.com/PostHog/db808740-242e-4a40-ad43-d41f26c049d7',
    });
    expect(posting.postedAt).toBeInstanceOf(Date);
  });
});

describe('ashby.fetch', () => {
  const httpReturning = (response: JsonResponse): HttpClient => ({
    getJson: () => Promise.resolve(response),
  });
  const validators = { etag: 'W/"x"', lastModified: null };

  it('validates and returns the postings', async () => {
    const http = httpReturning({
      status: 'ok',
      httpStatus: 200,
      body: board('codeway'),
      validators,
    });
    const outcome = await ashby.fetch('codeway', { http });
    expect(outcome).toMatchObject({ status: 'ok', httpStatus: 200, validators });
    expect(outcome.status === 'ok' && outcome.postings).toHaveLength(2);
  });

  it('passes not_modified through', async () => {
    const http = httpReturning({ status: 'not_modified', httpStatus: 304, validators });
    await expect(ashby.fetch('codeway', { http, previous: validators })).resolves.toEqual({
      status: 'not_modified',
      httpStatus: 304,
      validators,
    });
  });

  it('fails the source when the payload shape changes', async () => {
    const http = httpReturning({
      status: 'ok',
      httpStatus: 200,
      body: { jobs: [{ id: 1 }] },
      validators,
    });
    const error = await ashby.fetch('codeway', { http }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(String(error)).toMatch(/unexpected payload shape/);
  });
});
