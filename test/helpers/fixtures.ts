import { readFileSync, readdirSync } from 'node:fs';
import type { Ats, NormalizedPosting } from '../../src/domain/types.ts';
import type { HttpClient } from '../../src/sources/http.ts';
import { SOURCES } from '../../src/sources/index.ts';

const FIXTURES = new URL('../fixtures/', import.meta.url);

export function boards(ats: Ats): string[] {
  return readdirSync(new URL(`${ats}/`, FIXTURES))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

export async function normalizeFixture(ats: Ats, board: string): Promise<NormalizedPosting[]> {
  const body: unknown = JSON.parse(readFileSync(new URL(`${ats}/${board}.json`, FIXTURES), 'utf8'));
  const http: HttpClient = {
    getJson: () =>
      Promise.resolve({
        status: 'ok',
        httpStatus: 200,
        body,
        validators: { etag: null, lastModified: null },
      }),
  };
  const source = SOURCES[ats];
  const outcome = await source.fetch(board, { http });
  if (outcome.status !== 'ok') throw new Error('fixture fetch did not return ok');
  return outcome.postings.map((raw) => source.normalize(raw));
}
