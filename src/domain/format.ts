import type { Compensation, LocationClaim } from './types.ts';

const KIND: Record<LocationClaim['kind'], string> = {
  office: 'office',
  remote_region: 'remote',
  applicant_requirement: 'required',
};

/** "TR (remote)", "EMEA (remote)", "\"Remote\" (remote)" — city deliberately left out. */
export function placeLabel(claim: Pick<LocationClaim, 'kind' | 'countryCode' | 'region' | 'raw'>) {
  const place = claim.countryCode ?? claim.region ?? `"${claim.raw}"`;
  return `${place} (${KIND[claim.kind]})`;
}

/** "EUR 40K–50K / year", "USD 1.5K–3K / month". */
export function formatBand(b: Pick<Compensation, 'min' | 'max' | 'currency' | 'period'>): string {
  const amount = (n: number | null) =>
    n === null ? '?' : n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
  const range = b.min === b.max ? amount(b.min) : `${amount(b.min)}–${amount(b.max)}`;
  return `${b.currency ?? ''} ${range}${b.period ? ` / ${b.period}` : ''}`.trim();
}
