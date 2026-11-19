import { cityByFoldedName, type City } from './cities.ts';
import { countryByFoldedName, type CountryCode } from './countries.ts';
import { regionByFoldedName, type Region } from './regions.ts';
import { foldPlaceText } from './text.ts';

export interface ResolvedPlaces {
  /** Includes the country of every recognised city. */
  countries: CountryCode[];
  regions: Region[];
  cities: City[];
  /** Folded segments that carried meaning but matched nothing (kept for diagnostics). */
  unresolved: string[];
}

/** Hard delimiters between independent places: "Remote (US | EU)", "Berlin, Germany". */
const SEGMENT_DELIMITERS = /[,;|/()[\]]|\s[-–—]\s/;

/**
 * Words that describe the work arrangement, not the place. "Remote in Spain",
 * "Hybrid (UK)", "New York (HQ)" and "Work from anywhere" reduce to their place.
 */
const MODALITY_WORDS = new Set([
  'remote',
  'hybrid',
  'onsite',
  'on',
  'site',
  'office',
  'offices',
  'hq',
  'headquarters',
  'only',
  'based',
  'fully',
  'distributed',
  'in',
  'from',
  'within',
  'the',
  'work',
  'home',
  'homeoffice',
  'job',
  'location',
  'locations',
]);

/** Labels that say nothing about place at all. */
const NO_PLACE = new Set(['n a', 'na', 'tbd', 'tba', 'various', 'multiple', 'flexible']);

/**
 * Turns a free-text location label into countries, regions and cities.
 *
 * The rule is deliberately strict: a segment counts only when, after dropping modality
 * words, the *whole* segment is a known country, region or city name — or when every
 * alternative ("US or Canada") or every word ("US-NYC", "London UK") of it is. No
 * substring matching: that is how "New Mexico" becomes Mexico and "Türkiye" goes missing.
 * Anything else is reported as unresolved so the caller can keep it as an unknown claim
 * rather than guess.
 */
export function resolvePlaces(
  text: string,
  options: {
    /** Segments to leave uninterpreted, e.g. ones known to name a sub-national area. */
    skip?: readonly (string | null | undefined)[];
  } = {},
): ResolvedPlaces {
  const countries = new Set<CountryCode>();
  const regions = new Set<Region>();
  const cities = new Map<string, City>();
  const unresolved: string[] = [];
  const skip = new Set(options.skip?.filter((s) => s != null).map(foldPlaceText));

  // A label that says nothing about place ("N/A") must not be split into fragments.
  if (NO_PLACE.has(foldPlaceText(text))) {
    return { countries: [], regions: [], cities: [], unresolved };
  }

  // The longest reading wins: the text as one exact name first ("Europe, Middle East and
  // Africa" is EMEA, not Europe plus leftovers), and only then its delimited segments.
  const asWhole = readSegment(text, skip, { exactOnly: true });
  const readings = asWhole?.places
    ? [asWhole]
    : text.split(SEGMENT_DELIMITERS).map((segment) => readSegment(segment, skip));

  for (const reading of readings) {
    if (!reading) continue;
    if (!reading.places) {
      unresolved.push(reading.text);
      continue;
    }
    for (const place of reading.places) {
      if (place.type === 'country') countries.add(place.code);
      else if (place.type === 'region') regions.add(place.region);
      else {
        countries.add(place.city.country);
        cities.set(`${place.city.country}|${place.city.name}`, place.city);
      }
    }
  }

  return {
    countries: [...countries],
    regions: [...regions],
    cities: [...cities.values()],
    unresolved,
  };
}

type Place =
  | { type: 'country'; code: CountryCode }
  | { type: 'region'; region: Region }
  | { type: 'city'; city: City };

/** Null when the segment is skipped or carries no place words at all. */
function readSegment(
  segment: string,
  skip: ReadonlySet<string>,
  { exactOnly = false } = {},
): { text: string; places: Place[] | null } | null {
  const folded = foldPlaceText(segment);
  if (skip.has(folded)) return null;
  const stripped = folded
    .split(' ')
    .filter((w) => w !== '' && !MODALITY_WORDS.has(w))
    .join(' ');
  if (stripped === '' || NO_PLACE.has(stripped)) return null;

  // The unstripped form first, so names that contain a modality word
  // ("Anywhere in the world") still match as a whole.
  // Then "US or Canada" (every alternative is a place), then "US-NYC" / "London UK"
  // (every word is a place on its own) — never a partial match.
  const exact = matchOne(folded) ?? matchOne(stripped);
  // "Anywhere in France" narrows to France; only "anywhere" on its own means worldwide.
  if (!exact && stripped.startsWith('anywhere ')) {
    return readSegment(stripped.slice('anywhere '.length), skip, { exactOnly });
  }
  const places = exactOnly
    ? exact
    : (exact ?? matchAll(stripped.split(/ (?:or|and) /)) ?? matchAll(stripped.split(' ')));
  return { text: stripped, places };
}

function matchOne(folded: string): Place[] | null {
  const code = countryByFoldedName(folded);
  if (code) return [{ type: 'country', code }];
  const region = regionByFoldedName(folded);
  if (region) return [{ type: 'region', region }];
  const city = cityByFoldedName(folded);
  if (city) return [{ type: 'city', city }];
  return null;
}

function matchAll(parts: string[]): Place[] | null {
  if (parts.length < 2) return null;
  const places: Place[] = [];
  for (const part of parts) {
    const match = matchOne(part);
    if (!match) return null;
    places.push(...match);
  }
  return places;
}
