/**
 * Turns an ATS's location entries into LocationClaims — the one place where the
 * normalization rules live, so every adapter applies them identically.
 *
 * ATSes describe a location with some mix of a free-text label the company typed
 * ("Remote, EMEA", "Yerevan, Armenia", "Dublin") and structured fields (a country name or
 * ISO code, a locality, a sub-national region). The rules:
 *
 * 1. Both the label and the structured country are read, and their places are unioned.
 *    Structured fields are often lossy ("North America" stored as United States), labels
 *    are often partial ("Remote"). A spurious extra claim costs a glance; a dropped one
 *    can hide an open posting.
 * 2. Label segments that restate the structured locality or region ("Atlanta, Georgia"
 *    with region "Georgia") are the address, not new places.
 * 3. A city belongs to the structured country when it is the structured locality, or to
 *    the country the gazetteer places it in.
 * 4. An entry that resolves to nothing still yields a claim with only `raw`, so it can
 *    push the posting to `unknown`. Weak entries (secondary hints such as Greenhouse office
 *    names, which are sometimes department names) contribute only what they resolve.
 */
import type { LocationClaim, LocationKind } from '../domain/types.ts';
import { COUNTRY_NAMES } from '../geo/countries.data.ts';
import type { CountryCode } from '../geo/countries.ts';
import { resolvePlaces, type ResolvedPlaces } from '../geo/resolve.ts';

export interface LocationEntry {
  label: string;
  kind: LocationKind;
  /** Structured country: an ISO 3166-1 alpha-2 code or a name, as the ATS gives it. */
  country?: string | null;
  locality?: string | null;
  /** Sub-national area (state, province); never read as a place itself. */
  region?: string | null;
  weak?: boolean;
}

const EMPTY: ResolvedPlaces = { countries: [], regions: [], cities: [], unresolved: [] };

function resolveCountry(country: string | null | undefined): ResolvedPlaces {
  const text = country?.trim();
  if (!text) return EMPTY;
  if (/^[A-Z]{2}$/.test(text) && text in COUNTRY_NAMES) {
    return { ...EMPTY, countries: [text as CountryCode] };
  }
  return resolvePlaces(text);
}

/** "Remote [Serbia]", "Istanbul [Istanbul, Şişli, Turkey]" — label plus structured parts. */
export function describeEntry(entry: LocationEntry): string {
  const parts = [entry.locality, entry.region, entry.country]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  const label = entry.label.trim();
  if (parts.length === 0 || parts.join(', ') === label) return label;
  return label ? `${label} [${parts.join(', ')}]` : parts.join(', ');
}

export function claimsFromEntries(entries: readonly LocationEntry[]): LocationClaim[] {
  const claims = new Map<string, LocationClaim>();
  const add = (claim: LocationClaim) => {
    const key = [claim.kind, claim.countryCode, claim.region, claim.city].join('|');
    if (!claims.has(key)) claims.set(key, claim);
  };

  for (const entry of entries) {
    const { kind } = entry;
    const raw = describeEntry(entry);
    const structured = resolveCountry(entry.country);
    const fromLabel = resolvePlaces(entry.label, { skip: [entry.locality, entry.region] });

    const structuredCountry =
      structured.countries.length === 1 ? (structured.countries[0] ?? null) : null;
    const locality = entry.locality?.trim() || null;
    const cityFor = (code: CountryCode): string | null => {
      if (code === structuredCountry && locality) return locality;
      const cities = fromLabel.cities.filter((c) => c.country === code);
      return cities.length === 1 ? (cities[0]?.name ?? null) : null;
    };

    const countries = new Set([...structured.countries, ...fromLabel.countries]);
    const regions = new Set([...fromLabel.regions, ...structured.regions]);

    for (const region of regions) add({ kind, countryCode: null, region, city: null, raw });
    for (const code of countries) {
      add({ kind, countryCode: code, region: null, city: cityFor(code), raw });
    }
    if (countries.size === 0 && regions.size === 0 && !entry.weak && raw !== '') {
      add({ kind, countryCode: null, region: null, city: locality, raw });
    }
  }
  return [...claims.values()];
}

/**
 * The work arrangement a label states for itself ("Remote (US or Canada)" on a posting
 * marked Hybrid), if any. Adapters fall back to posting-level fields when this is null.
 */
export function kindFromLabel(label: string): LocationKind | null {
  if (/\bremote\b/i.test(label)) return 'remote_region';
  if (/\b(hybrid|on-?site|office)\b/i.test(label)) return 'office';
  return null;
}
