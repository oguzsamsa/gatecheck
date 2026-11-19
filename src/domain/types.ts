/**
 * The normalized posting model. Every ATS adapter reduces its own payload shape to this,
 * and nothing downstream (storage, eligibility, notifications) ever looks at ATS-specific
 * fields again — they survive only in `posting_version.payload_json` for auditing.
 */
import type { CountryCode } from '../geo/countries.ts';
import type { Region } from '../geo/regions.ts';

/** Grows one entry per adapter; the source registry is typed to require an adapter for each. */
export const ATS_VALUES = ['ashby', 'greenhouse', 'lever', 'recruitee'] as const;
export type Ats = (typeof ATS_VALUES)[number];

/**
 * - `office`: the posting is tied to a physical location (on-site or hybrid).
 * - `remote_region`: remote, but scoped to where the employee may live.
 * - `applicant_requirement`: an explicit eligibility statement about the applicant
 *   (e.g. Teamtailor's `applicantLocationRequirements`), stronger than a location label.
 */
export const LOCATION_KINDS = ['office', 'remote_region', 'applicant_requirement'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/**
 * One structured statement about where a posting can be done from.
 *
 * A claim resolves to at most one of `countryCode` / `region`. When it resolves to neither
 * it is kept anyway: `raw` preserves what the ATS said, and an unresolved claim is exactly
 * what pushes a posting into the `unknown` bucket instead of silently dropping it.
 */
export interface LocationClaim {
  kind: LocationKind;
  countryCode: CountryCode | null;
  region: Region | null;
  city: string | null;
  /** The source text this claim was derived from, verbatim. */
  raw: string;
}

export const COMPENSATION_PERIODS = ['year', 'month', 'week', 'day', 'hour'] as const;
export type CompensationPeriod = (typeof COMPENSATION_PERIODS)[number];

export interface Compensation {
  min: number | null;
  max: number | null;
  /** ISO 4217. */
  currency: string | null;
  period: CompensationPeriod | null;
  /** Where in the payload this came from, e.g. `ashby.summaryComponents`. */
  source: string;
}

export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'internship',
  'temporary',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export interface NormalizedPosting {
  atsPostingId: string;
  title: string;
  url: string;
  department: string | null;
  employmentType: EmploymentType | null;
  postedAt: Date | null;
  locations: LocationClaim[];
  compensation: Compensation[];
}
