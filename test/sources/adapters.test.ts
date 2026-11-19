import { describe, expect, it } from 'vitest';
import type { LocationClaim, NormalizedPosting } from '../../src/domain/types.ts';
import { normalizeFixture } from '../helpers/fixtures.ts';

const show = (c: LocationClaim) =>
  [c.kind, c.countryCode ?? c.region ?? `"${c.raw}"`, c.city].filter(Boolean).join(' ');

async function find(
  ats: Parameters<typeof normalizeFixture>[0],
  board: string,
  title: RegExp,
): Promise<NormalizedPosting> {
  const posting = (await normalizeFixture(ats, board)).find((p) => title.test(p.title));
  if (!posting) throw new Error(`no ${String(title)} in ${ats}/${board}`);
  return posting;
}

describe('greenhouse', () => {
  it('reads a city-only label through the gazetteer', async () => {
    const p = await find('greenhouse', 'stripe', /French/);
    expect(p.locations.map(show)).toEqual(['office IE Dublin']);
  });

  it('falls back to office hints only when the label names no place', async () => {
    const na = await find('greenhouse', 'stripe', /Data Scientist/);
    expect(na.locations.map(show)).toEqual(['office US']);

    // "Remote, KSA" is specific; the "EMEA" office group must not widen it.
    const ksa = await find('greenhouse', 'gitlab', /KSA/);
    expect(ksa.locations.map(show)).toEqual(['remote_region SA']);
  });

  it('keeps unreadable labels as unresolved claims', async () => {
    const p = await find('greenhouse', 'stripe', /Partner Development/);
    expect(p.locations.map(show)).toEqual(
      expect.arrayContaining(['office "CA-Toronto"', 'remote_region "CA-Remote"']),
    );
  });
});

describe('lever', () => {
  it('applies workplaceType to every location and reads the salary range', async () => {
    const remote = await find('lever', 'spotify', /Machine Learning/);
    expect(remote.locations.map(show)).toEqual([
      'remote_region SE Stockholm',
      'remote_region GB London',
    ]);

    const paid = await find('lever', 'spotify', /Accounting Analyst/);
    expect(paid.compensation).toEqual([
      { min: 75645, max: 94556, currency: 'USD', period: 'year', source: 'lever.salaryRange' },
    ]);
  });
});

describe('recruitee', () => {
  it('treats a required location question on a remote offer as an applicant requirement', async () => {
    const p = await find('recruitee', 'cyberarrow', /Sales Development Manager/);
    expect(p.locations.map(show)).toEqual([
      'applicant_requirement PT Lisbon',
      'applicant_requirement RO Bucharest',
    ]);
  });

  it('parses string salaries and its date format', async () => {
    const p = await find('recruitee', 'powerprozesse', /IT-Consultant/);
    expect(p.compensation).toEqual([
      { min: 1500, max: 3000, currency: 'USD', period: 'month', source: 'recruitee.salary' },
    ]);
    expect(p.postedAt?.toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(p.employmentType).toBe('full_time');
  });
});
