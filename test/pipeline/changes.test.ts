/**
 * The phase-2 promise end to end: a posting you were sent quietly drops your country and
 * lowers its band; the next digest says so, once.
 */
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/client.ts';
import { postingChange } from '../../src/db/schema.ts';
import type { Compensation, LocationClaim, NormalizedPosting } from '../../src/domain/types.ts';
import { evaluateOpenPostings } from '../../src/eligibility/evaluate.ts';
import { collectDigest } from '../../src/notify/digest.ts';
import { renderDigest } from '../../src/notify/render.ts';
import { deliver } from '../../src/notify/telegram.ts';
import { describeListChange, diffPostings } from '../../src/pipeline/diff.ts';
import { poll } from '../../src/pipeline/poll.ts';
import type { HttpClient } from '../../src/sources/http.ts';
import { SOURCES } from '../../src/sources/index.ts';
import type { BoardSource } from '../../src/sources/types.ts';

const remote = (code: 'TR' | 'PL' | 'DE'): LocationClaim => ({
  kind: 'remote_region',
  countryCode: code,
  region: null,
  city: null,
  raw: code,
});
const band = (min: number, max: number): Compensation => ({
  min,
  max,
  currency: 'EUR',
  period: 'year',
  source: 'test',
});

describe('diffPostings', () => {
  const base = {
    title: 'Engineer',
    locations: [remote('TR'), remote('PL')],
    compensation: [band(60_000, 80_000)],
  };

  it('ignores reordering and content that is not places, band or title', () => {
    expect(diffPostings(base, { ...base, locations: [remote('PL'), remote('TR')] })).toEqual([]);
  });

  it('records place, band and title changes in human terms', () => {
    const changes = diffPostings(base, {
      title: 'Senior Engineer',
      locations: [remote('PL'), remote('DE')],
      compensation: [band(50_000, 70_000)],
    });
    expect(changes).toEqual([
      { kind: 'title', before: 'Engineer', after: 'Senior Engineer' },
      { kind: 'locations', before: 'PL (remote); TR (remote)', after: 'DE (remote); PL (remote)' },
      { kind: 'compensation', before: 'EUR 60K–80K / year', after: 'EUR 50K–70K / year' },
    ]);
    expect(describeListChange('PL (remote); TR (remote)', 'DE (remote); PL (remote)')).toBe(
      'removed TR (remote); added DE (remote)',
    );
  });
});

describe('change notifications', () => {
  it('announces a change to a posting you were sent, exactly once', async () => {
    const db = openDb(':memory:');
    let clock = Date.UTC(2026, 10, 1);
    const now = () => new Date((clock += 3_600_000));

    const versions: NormalizedPosting[] = [
      { locations: [remote('TR'), remote('PL')], compensation: [band(60_000, 80_000)] },
      { locations: [remote('PL')], compensation: [band(50_000, 70_000)] },
    ].map((v) => ({
      atsPostingId: 'p1',
      title: 'Backend Engineer',
      url: 'https://example.test/p1',
      department: null,
      employmentType: null,
      postedAt: null,
      ...v,
    }));
    let current = 0;
    const source: BoardSource<NormalizedPosting> = {
      ats: 'ashby',
      fetch: () =>
        Promise.resolve({
          status: 'ok',
          httpStatus: 200,
          postings: [versions[current] as NormalizedPosting],
          validators: { etag: null, lastModified: null },
        }),
      normalize: (p) => p,
    };
    const http: HttpClient = {
      getJson: () => Promise.reject(new Error('unused')),
      getText: () => Promise.reject(new Error('unused')),
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('{"ok":true}')),
    );
    const target = { botToken: 't', chatId: '1' };
    const watchlist = [{ name: 'Acme', ats: 'ashby' as const, org: 'acme' }];
    const profile = { titleKeywords: [] };

    async function cycle() {
      const report = await poll(
        { db, http, sources: { ...SOURCES, ashby: source }, now },
        watchlist,
      );
      evaluateOpenPostings(db, 'TR', now());
      const messages = renderDigest(collectDigest(db, report.runId, profile));
      await deliver(db, target, messages, now(), fetch);
      return messages.map((m) => m.text).join('\n');
    }

    const first = await cycle();
    expect(first).toContain('Open to you');

    current = 1;
    const second = await cycle();
    expect(second).toContain('Changed since you saw them');
    expect(second).toContain('Locations: removed TR (remote)');
    expect(second).toContain('Salary: EUR 60K–80K / year → EUR 50K–70K / year');
    expect(second).toContain('Verdict: open → closed: limited to PL (remote)');

    expect(await cycle()).toBe('');
    expect(
      db
        .select()
        .from(postingChange)
        .all()
        .every((c) => c.notifiedAt !== null),
    ).toBe(true);
  });
});
