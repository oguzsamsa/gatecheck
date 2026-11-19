import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from '../../src/pipeline/hash.ts';

describe('contentHash', () => {
  it('ignores key order at every depth', () => {
    const a = { id: 1, address: { country: 'TR', city: 'Istanbul' }, tags: [{ b: 1, a: 2 }] };
    const b = { tags: [{ a: 2, b: 1 }], address: { city: 'Istanbul', country: 'TR' }, id: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('is sensitive to array order and values', () => {
    expect(contentHash({ l: ['TR', 'DE'] })).not.toBe(contentHash({ l: ['DE', 'TR'] }));
    expect(contentHash({ max: 100 })).not.toBe(contentHash({ max: 90 }));
  });
});
