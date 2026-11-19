/**
 * What changed between two versions of a posting, reduced to the things a reader cares
 * about. A payload can change for many reasons (a reworded paragraph, a new benefits
 * line); only a different place set, salary band or title is recorded as a change.
 */
import type { ChangeKind } from '../db/schema.ts';
import { formatBand, placeLabel } from '../domain/format.ts';
import type { Compensation, LocationClaim } from '../domain/types.ts';

export interface Change {
  kind: ChangeKind;
  before: string;
  after: string;
}

/** Place lists are stored "; "-joined and sorted, so equal sets compare equal. */
export const LIST_SEPARATOR = '; ';

const places = (
  claims: readonly Pick<LocationClaim, 'kind' | 'countryCode' | 'region' | 'raw'>[],
) => [...new Set(claims.map(placeLabel))].sort().join(LIST_SEPARATOR);

const bands = (comp: readonly Pick<Compensation, 'min' | 'max' | 'currency' | 'period'>[]) =>
  comp.map(formatBand).sort().join(LIST_SEPARATOR) || 'none';

export function diffPostings(
  before: {
    title: string;
    locations: readonly LocationClaim[];
    compensation: readonly Compensation[];
  },
  after: {
    title: string;
    locations: readonly LocationClaim[];
    compensation: readonly Compensation[];
  },
): Change[] {
  const changes: Change[] = [];
  const add = (kind: ChangeKind, b: string, a: string) => {
    if (b !== a) changes.push({ kind, before: b, after: a });
  };
  add('title', before.title, after.title);
  add('locations', places(before.locations), places(after.locations));
  add('compensation', bands(before.compensation), bands(after.compensation));
  return changes;
}

/** "removed TR (remote); added PL (remote)" from two stored place lists. */
export function describeListChange(before: string, after: string): string {
  const split = (s: string) => new Set(s === '' || s === 'none' ? [] : s.split(LIST_SEPARATOR));
  const b = split(before);
  const a = split(after);
  const removed = [...b].filter((x) => !a.has(x));
  const added = [...a].filter((x) => !b.has(x));
  return [
    removed.length > 0 && `removed ${removed.join(', ')}`,
    added.length > 0 && `added ${added.join(', ')}`,
  ]
    .filter(Boolean)
    .join('; ');
}
