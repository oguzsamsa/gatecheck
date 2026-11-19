/**
 * Supranational areas that postings scope remote work to. This module only recognises
 * them; whether a region covers a given applicant country is an eligibility decision and
 * lives with the eligibility rules, not here.
 */
export const REGIONS = [
  'WORLDWIDE',
  'EMEA',
  'EUROPE',
  'EU',
  'MENA',
  'AMERICAS',
  'NORTH_AMERICA',
  'LATAM',
  'APAC',
] as const;
export type Region = (typeof REGIONS)[number];

/** Keys are folded (see foldPlaceText). */
const ALIASES: Record<string, Region> = {
  worldwide: 'WORLDWIDE',
  global: 'WORLDWIDE',
  anywhere: 'WORLDWIDE',
  'anywhere in the world': 'WORLDWIDE',
  emea: 'EMEA',
  'europe middle east and africa': 'EMEA',
  europe: 'EUROPE',
  eu: 'EU',
  'european union': 'EU',
  mena: 'MENA',
  'middle east and north africa': 'MENA',
  amer: 'AMERICAS',
  americas: 'AMERICAS',
  'north america': 'NORTH_AMERICA',
  latam: 'LATAM',
  'latin america': 'LATAM',
  'south america': 'LATAM',
  apac: 'APAC',
  'asia pacific': 'APAC',
};

export function regionByFoldedName(folded: string): Region | null {
  return ALIASES[folded] ?? null;
}
