import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpResponse } from '../../src/sources/http.ts';
import { teamtailor } from '../../src/sources/teamtailor.ts';

/**
 * Hand-written, not captured: no robots-permitted Teamtailor site had a fully remote job
 * when the fixtures were taken. The shapes follow the real feed (see
 * test/fixtures/teamtailor) and schema.org's JobPosting.
 */
const feed = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:tt="https://teamtailor.com/locations">
  <channel><title>Acme</title>${items}</channel>
</rss>`;

const item = (id: string, remoteStatus: string, locations = '') => `
  <item>
    <title>Engineer ${id}</title>
    <pubDate>Tue, 10 Nov 2026 21:10:20 +0100</pubDate>
    <link>https://careers.acme.test/jobs/${id}-engineer</link>
    <remoteStatus>${remoteStatus}</remoteStatus>
    <guid>${id}</guid>
    <tt:locations>${locations}</tt:locations>
    <tt:department>Engineering</tt:department>
  </item>`;

const hq = `<tt:location><tt:name>Acme HQ</tt:name><tt:city>Amsterdam</tt:city><tt:country>Netherlands</tt:country></tt:location>`;

const page = (requirements: unknown) => `<html><head>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"Organization","name":"Acme"}</script>
<script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting',
  employmentType: 'FULL_TIME',
  jobLocation: [{ '@type': 'Place', address: { addressCountry: 'NL' } }],
  applicantLocationRequirements: requirements,
})}</script></head></html>`;

function http(rss: string, pages: Record<string, string>) {
  const requested: string[] = [];
  const ok = <B>(body: B): HttpResponse<B> => ({
    status: 'ok',
    httpStatus: 200,
    body,
    validators: { etag: 'W/"1"', lastModified: null },
  });
  const client: HttpClient = {
    getJson: () => Promise.reject(new Error('unused')),
    getText: (url) => {
      requested.push(url);
      if (url.endsWith('/jobs.rss')) return Promise.resolve(ok(rss));
      const html = pages[url];
      return html ? Promise.resolve(ok(html)) : Promise.reject(new Error(`404 ${url}`));
    },
  };
  return { client, requested };
}

async function normalized(rss: string, pages: Record<string, string> = {}) {
  const { client, requested } = http(rss, pages);
  const outcome = await teamtailor.fetch('careers.acme.test', { http: client });
  if (outcome.status !== 'ok') throw new Error('expected ok');
  return { postings: outcome.postings.map((p) => teamtailor.normalize(p)), requested };
}

describe('teamtailor', () => {
  it('reads applicant requirements from the job page of a fully remote posting', async () => {
    const { postings } = await normalized(feed(item('1', 'fully')), {
      'https://careers.acme.test/jobs/1-engineer': page([
        { '@type': 'Country', name: 'Türkiye' },
        { '@type': 'Country', name: 'Poland' },
      ]),
    });
    expect(postings[0]?.locations.map((c) => [c.kind, c.countryCode])).toEqual([
      ['applicant_requirement', 'TR'],
      ['applicant_requirement', 'PL'],
    ]);
    expect(postings[0]?.employmentType).toBe('full_time');
  });

  it('ignores JSON-LD jobLocation, which is the HQ default, not a constraint', async () => {
    const { postings } = await normalized(feed(item('1', 'fully')), {
      'https://careers.acme.test/jobs/1-engineer': page(undefined),
    });
    expect(postings[0]?.locations).toEqual([]);
  });

  it('fetches job pages only for fully remote postings', async () => {
    const { postings, requested } = await normalized(
      feed(item('1', 'hybrid', hq) + item('2', 'none', hq)),
    );
    expect(requested).toEqual(['https://careers.acme.test/jobs.rss']);
    expect(
      postings.map((p) => p.locations.map((c) => `${c.kind} ${c.countryCode} ${c.city}`)),
    ).toEqual([['office NL Amsterdam'], ['office NL Amsterdam']]);
  });

  it('rejects an org that is not a hostname', async () => {
    const { client } = http('', {});
    await expect(teamtailor.fetch('evil.test/../x', { http: client })).rejects.toThrow(/invalid/);
  });
});
