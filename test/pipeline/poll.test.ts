import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WatchlistEntry } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/client.ts';
import {
  company,
  compensation,
  locationClaim,
  posting,
  postingVersion,
  run,
  runSource,
} from '../../src/db/schema.ts';
import type { NormalizedPosting } from '../../src/domain/types.ts';
import { canonicalJson } from '../../src/pipeline/hash.ts';
import { poll } from '../../src/pipeline/poll.ts';
import { SourceError, type HttpClient, type Validators } from '../../src/sources/http.ts';
import type { BoardSource, FetchOutcome } from '../../src/sources/types.ts';

interface FakeJob {
  id: string;
  title: string;
  country?: string;
}

/** A scripted board: each call to fetch() returns the next scripted response for that org. */
function fakeSource(script: Record<string, (FetchOutcome<FakeJob> | Error)[]>) {
  const calls: { org: string; previous: Validators | undefined }[] = [];
  const source: BoardSource<FakeJob> = {
    ats: 'ashby',
    fetch(org, { previous }) {
      calls.push({ org, previous });
      const next = script[org]?.shift();
      if (!next) throw new Error(`no scripted response for ${org}`);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    normalize(job): NormalizedPosting {
      return {
        atsPostingId: job.id,
        title: job.title,
        url: `https://example.test/${job.id}`,
        department: null,
        employmentType: 'full_time',
        postedAt: null,
        locations: job.country
          ? [
              {
                kind: 'remote_region',
                countryCode: job.country as 'TR',
                region: null,
                city: null,
                raw: job.country,
              },
            ]
          : [],
        compensation: [{ min: 1, max: 2, currency: 'EUR', period: 'year', source: 'test' }],
      };
    },
  };
  return { source, calls };
}

const ok = (postings: FakeJob[], etag: string | null = null): FetchOutcome<FakeJob> => ({
  status: 'ok',
  httpStatus: 200,
  postings,
  validators: { etag, lastModified: null },
});

const WATCHLIST: WatchlistEntry[] = [
  { name: 'Acme', ats: 'ashby', org: 'acme' },
  { name: 'Globex', ats: 'ashby', org: 'globex' },
];

let db: Db;
let clock: number;
const now = () => new Date(clock);
const http: HttpClient = { getJson: () => Promise.reject(new Error('unused')) };

function runPoll(source: BoardSource<FakeJob>, watchlist = WATCHLIST) {
  clock += 86_400_000;
  return poll({ db, http, sources: { ashby: source }, now }, watchlist);
}

function postingsOf(org: string) {
  const c = db.select().from(company).where(eq(company.orgSlug, org)).get();
  if (!c) return [];
  return db.select().from(posting).where(eq(posting.companyId, c.id)).all();
}

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.UTC(2026, 10, 1);
});

describe('poll', () => {
  it('stores new postings with a first version, claims and compensation', async () => {
    const { source } = fakeSource({
      acme: [ok([{ id: 'a1', title: 'Engineer', country: 'TR' }])],
      globex: [ok([])],
    });

    const report = await runPoll(source);

    expect(report.status).toBe('ok');
    expect(report.sources[0]).toMatchObject({ status: 'ok', created: 1, seen: 1 });
    const [p] = postingsOf('acme');
    expect(p).toMatchObject({ title: 'Engineer', closedAt: null });
    expect(db.select().from(postingVersion).all()).toHaveLength(1);
    expect(db.select().from(locationClaim).all()).toMatchObject([{ countryCode: 'TR' }]);
    expect(db.select().from(compensation).all()).toHaveLength(1);
  });

  it('stores a new version only when the payload changes', async () => {
    const v1 = { id: 'a1', title: 'Engineer', country: 'TR' };
    const v2 = { id: 'a1', title: 'Engineer', country: 'DE' };
    const { source } = fakeSource({
      acme: [ok([v1]), ok([{ ...v1 }]), ok([v2])],
      globex: [ok([]), ok([]), ok([])],
    });

    await runPoll(source);
    const second = await runPoll(source);
    expect(second.sources[0]).toMatchObject({ created: 0, changed: 0 });
    expect(db.select().from(postingVersion).all()).toHaveLength(1);

    const third = await runPoll(source);
    expect(third.sources[0]).toMatchObject({ created: 0, changed: 1 });
    const versions = db.select().from(postingVersion).all();
    expect(versions.map((v) => canonicalJson(v.payloadJson))).toEqual([
      canonicalJson(v1),
      canonicalJson(v2),
    ]);
    // Current claims follow the latest version.
    expect(db.select().from(locationClaim).all()).toMatchObject([{ countryCode: 'DE' }]);
  });

  it('closes postings that disappear and reopens ones that come back', async () => {
    const a1 = { id: 'a1', title: 'Engineer' };
    const a2 = { id: 'a2', title: 'Designer' };
    const { source } = fakeSource({
      acme: [ok([a1, a2]), ok([a1]), ok([a1, a2])],
      globex: [ok([]), ok([]), ok([])],
    });

    await runPoll(source);
    const second = await runPoll(source);
    expect(second.sources[0]).toMatchObject({ closed: 1 });
    expect(postingsOf('acme').find((p) => p.atsPostingId === 'a2')?.closedAt).toEqual(now());

    const third = await runPoll(source);
    expect(third.sources[0]).toMatchObject({ reopened: 1, created: 0 });
    expect(postingsOf('acme').every((p) => p.closedAt === null)).toBe(true);
  });

  it('closes everything when a board empties', async () => {
    const { source } = fakeSource({
      acme: [ok([{ id: 'a1', title: 'Engineer' }]), ok([])],
      globex: [ok([]), ok([])],
    });
    await runPoll(source);
    await runPoll(source);
    expect(postingsOf('acme')[0]?.closedAt).not.toBeNull();
  });

  it('replays validators and treats 304 as "everything still open"', async () => {
    const { source, calls } = fakeSource({
      acme: [
        ok([{ id: 'a1', title: 'Engineer' }], 'W/"v1"'),
        {
          status: 'not_modified',
          httpStatus: 304,
          validators: { etag: 'W/"v1"', lastModified: null },
        },
      ],
      globex: [ok([]), ok([])],
    });

    await runPoll(source);
    const report = await runPoll(source);

    expect(calls.filter((c) => c.org === 'acme').map((c) => c.previous)).toEqual([
      undefined,
      { etag: 'W/"v1"', lastModified: null },
    ]);
    expect(report.sources[0]).toMatchObject({ status: 'not_modified' });
    const [p] = postingsOf('acme');
    expect(p?.closedAt).toBeNull();
    expect(p?.lastSeenAt).toEqual(now());
  });

  it('isolates a failing source and records why', async () => {
    const { source } = fakeSource({
      acme: [new SourceError('HTTP 404', { url: 'https://example.test', httpStatus: 404 })],
      globex: [ok([{ id: 'g1', title: 'Engineer' }])],
    });

    const report = await runPoll(source);

    expect(report.status).toBe('partial');
    expect(postingsOf('globex')).toHaveLength(1);
    expect(db.select().from(runSource).all()).toMatchObject([
      { status: 'error', httpStatus: 404, error: 'HTTP 404', postingsSeen: null },
      { status: 'ok', httpStatus: 200, postingsSeen: 1 },
    ]);
    expect(db.select().from(run).get()).toMatchObject({ status: 'partial' });
  });

  it('marks the run failed when every source fails', async () => {
    const { source } = fakeSource({ acme: [new Error('boom')], globex: [new Error('boom')] });
    expect((await runPoll(source)).status).toBe('failed');
  });

  it('stops polling a company removed from the watchlist, keeping its history', async () => {
    const { source, calls } = fakeSource({
      acme: [ok([{ id: 'a1', title: 'Engineer' }])],
      globex: [ok([]), ok([])],
    });
    await runPoll(source);
    await runPoll(source, [{ name: 'Globex', ats: 'ashby', org: 'globex' }]);

    expect(calls.map((c) => c.org)).toEqual(['acme', 'globex', 'globex']);
    expect(postingsOf('acme')).toHaveLength(1);
  });
});
