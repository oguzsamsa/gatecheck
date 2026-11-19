/**
 * Golden tests over every adapter. Fixtures are real public board responses (Nov 2026),
 * trimmed to postings that each exercise a normalization edge case, with long text fields
 * shortened. Each one goes through the adapter's real fetch path (schema validation
 * included), then normalize, then the eligibility rules for a TR applicant.
 *
 * Reviewing a change to these files is reviewing a change in behaviour.
 */
import { describe, expect, it } from 'vitest';
import { ATS_VALUES } from '../../src/domain/types.ts';
import { decide } from '../../src/eligibility/rules.ts';
import { boards, normalizeFixture } from '../helpers/fixtures.ts';

describe('normalized output', () => {
  for (const ats of ATS_VALUES) {
    it.each(boards(ats))(`${ats}: %s`, async (board) => {
      const postings = await normalizeFixture(ats, board);
      await expect(JSON.stringify(postings, null, 2) + '\n').toMatchFileSnapshot(
        `../fixtures/${ats}/__golden__/${board}.normalized.json`,
      );
    });
  }
});

describe('verdicts for a TR applicant', () => {
  it('matches', async () => {
    const lines: string[] = [];
    for (const ats of ATS_VALUES) {
      for (const board of boards(ats)) {
        for (const p of await normalizeFixture(ats, board)) {
          const { verdict, reason } = decide(p.locations, 'TR');
          lines.push(`${verdict.padEnd(7)} ${ats}/${board} · ${p.title}\n        ${reason}`);
        }
      }
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('../fixtures/verdicts-TR.txt');
  });
});
