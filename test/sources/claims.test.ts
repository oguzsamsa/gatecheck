import { describe, expect, it } from 'vitest';
import { kindFromLabel } from '../../src/sources/claims.ts';

describe('kindFromLabel', () => {
  it.each([
    ['Remote - EMEA', 'remote_region'],
    ['Home based - EMEA', 'remote_region'],
    ['Home-based, Worldwide', 'remote_region'],
    ['Work from home (TR)', 'remote_region'],
    ['Hybrid (London)', 'office'],
    ['On-site, Berlin', 'office'],
    ['Berlin', null],
  ])('%s → %s', (label, kind) => {
    expect(kindFromLabel(label)).toBe(kind);
  });
});
