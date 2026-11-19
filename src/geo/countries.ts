import { COUNTRY_NAMES } from './countries.data.ts';
import { foldPlaceText } from './text.ts';

/** ISO 3166-1 alpha-2 (plus XK). */
export type CountryCode = keyof typeof COUNTRY_NAMES;

/**
 * Names that ATS payloads actually use but CLDR spells differently. Two-letter codes are
 * deliberately NOT matched in general — "CA", "IL", "MA" and "CO" in "Boston, MA" or
 * "Denver, CO" are US states, not Canada, Israel, Morocco or Colombia. Only the codes
 * that are unambiguous in practice get an alias here.
 */
const ALIASES: Record<string, CountryCode> = {
  us: 'US',
  usa: 'US',
  'united states of america': 'US',
  uk: 'GB',
  'great britain': 'GB',
  britain: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  uae: 'AE',
  turkey: 'TR',
  'czech republic': 'CZ',
  'republic of korea': 'KR',
  'russian federation': 'RU',
  holland: 'NL',
  'hong kong': 'HK',
  macau: 'MO',
  macao: 'MO',
  myanmar: 'MM',
  burma: 'MM',
  'ivory coast': 'CI',
  macedonia: 'MK',
  palestine: 'PS',
  'viet nam': 'VN',
  'cape verde': 'CV',
  swaziland: 'SZ',
  'east timor': 'TL',
  'vatican city': 'VA',
};

const BY_FOLDED_NAME = new Map<string, CountryCode>();
for (const [code, name] of Object.entries(COUNTRY_NAMES) as [CountryCode, string][]) {
  BY_FOLDED_NAME.set(foldPlaceText(name), code);
}
for (const [alias, code] of Object.entries(ALIASES)) {
  BY_FOLDED_NAME.set(alias, code);
}

/** Exact match of an already-folded name. No substring or fuzzy matching, by design. */
export function countryByFoldedName(folded: string): CountryCode | null {
  return BY_FOLDED_NAME.get(folded) ?? null;
}

export function countryName(code: CountryCode): string {
  return COUNTRY_NAMES[code];
}
