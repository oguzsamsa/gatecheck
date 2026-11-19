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
 * 4. Text we could not read always yields a claim with only `raw`, so it pushes the
 *    posting to `unknown` instead of vanishing.
 * 5. Fallbacks only fill silence. Weak entries (secondary hints such as Greenhouse office
 *    groups, which may be a whole region or even a department) count only when the strong
 *    entries resolve no place; a label that names no place at all ("Remote", "N/A") counts
 *    only when nothing else about the posting is known.
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
  const read = entries.map((entry) => ({ entry, ...readEntry(entry) }));
  const strong = read.filter((r) => !r.entry.weak);

  const claims = strong.flatMap((r) => r.places);
  if (claims.length === 0)
    claims.push(...read.filter((r) => r.entry.weak).flatMap((r) => r.places));
  claims.push(...strong.filter((r) => r.unreadable).flatMap((r) => r.bare ?? []));
  if (claims.length === 0) claims.push(...strong.flatMap((r) => r.bare ?? []));

  const unique = new Map<string, LocationClaim>();
  for (const claim of claims) {
    const key = [claim.kind, claim.countryCode, claim.region, claim.city].join('|');
    if (!unique.has(key)) unique.set(key, claim);
  }
  return [...unique.values()];
}

/** The places one entry resolves to, or — if none — the bare claim that keeps its text. */
function readEntry(entry: LocationEntry): {
  places: LocationClaim[];
  bare: LocationClaim | null;
  unreadable: boolean;
} {
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

  const regions = new Set([...fromLabel.regions, ...structured.regions]);
  const countries = new Set([...structured.countries, ...fromLabel.countries]);
  const places: LocationClaim[] = [
    ...[...regions].map((region) => ({ kind, countryCode: null, region, city: null, raw })),
    ...[...countries].map((code) => ({
      kind,
      countryCode: code,
      region: null,
      city: cityFor(code),
      raw,
    })),
  ];
  if (places.length > 0 || raw === '') return { places, bare: null, unreadable: false };
  return {
    places,
    bare: { kind, countryCode: null, region: null, city: locality, raw },
    unreadable: fromLabel.unresolved.length + structured.unresolved.length > 0,
  };
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
