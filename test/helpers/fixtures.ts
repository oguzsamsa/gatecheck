/**
 * Fixture boards: real public responses (Nov 2026), trimmed to postings that each exercise
 * an edge case, long text shortened. JSON boards are `{board}.json`; feed-based boards are
 * `{board}.rss` plus `{board}.pages.json` mapping each fetched job-page URL to its HTML.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { Ats, NormalizedPosting } from '../../src/domain/types.ts';
import type { HttpClient, HttpResponse } from '../../src/sources/http.ts';
import { SourceError } from '../../src/sources/http.ts';
import { SOURCES } from '../../src/sources/index.ts';

const FIXTURES = new URL('../fixtures/', import.meta.url);

export function boards(ats: Ats): string[] {
  return readdirSync(new URL(`${ats}/`, FIXTURES))
    .filter((f) => /\.(json|rss)$/.test(f) && !f.endsWith('.pages.json'))
    .map((f) => f.replace(/\.(json|rss)$/, ''));
}

const ok = <Body>(body: Body): HttpResponse<Body> => ({
  status: 'ok',
  httpStatus: 200,
  body,
  validators: { etag: null, lastModified: null },
});

/** An HttpClient that serves one fixture board and its job pages. */
export function fixtureHttp(ats: Ats, board: string): HttpClient {
  const file = (ext: string) => new URL(`${ats}/${board}${ext}`, FIXTURES);
  const pages: Record<string, string> = existsSync(file('.pages.json'))
    ? (JSON.parse(readFileSync(file('.pages.json'), 'utf8')) as Record<string, string>)
    : {};
  return {
    getJson: () => Promise.resolve(ok(JSON.parse(readFileSync(file('.json'), 'utf8')) as unknown)),
    getText: (url) => {
      if (url.endsWith('.rss')) return Promise.resolve(ok(readFileSync(file('.rss'), 'utf8')));
      const page = pages[url];
      return page === undefined
        ? Promise.reject(new SourceError('HTTP 404', { url, httpStatus: 404 }))
        : Promise.resolve(ok(page));
    },
  };
}

export async function normalizeFixture(ats: Ats, board: string): Promise<NormalizedPosting[]> {
  const source = SOURCES[ats];
  const outcome = await source.fetch(board, { http: fixtureHttp(ats, board) });
  if (outcome.status !== 'ok') throw new Error('fixture fetch did not return ok');
  return outcome.postings.map((raw) => source.normalize(raw));
}
