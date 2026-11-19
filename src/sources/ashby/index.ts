import { z } from 'zod';
import type {
  Compensation,
  CompensationPeriod,
  EmploymentType,
  LocationClaim,
  LocationKind,
} from '../../domain/types.ts';
import type { CountryCode } from '../../geo/countries.ts';
import { resolvePlaces } from '../../geo/resolve.ts';
import { SourceError } from '../http.ts';
import type { BoardSource } from '../types.ts';
import { AshbyBoard, type AshbyJob } from './schema.ts';

export const ashby: BoardSource<AshbyJob> = {
  ats: 'ashby',

  async fetch(board, { http, previous }) {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`;
    const response = await http.getJson(url, previous);
    if (response.status === 'not_modified') return response;

    const parsed = AshbyBoard.safeParse(response.body);
    if (!parsed.success) {
      throw new SourceError(`unexpected payload shape: ${z.prettifyError(parsed.error)}`, {
        url,
        httpStatus: response.httpStatus,
      });
    }
    return {
      status: 'ok',
      httpStatus: response.httpStatus,
      postings: parsed.data.jobs,
      validators: response.validators,
    };
  },

  normalize(job) {
    return {
      atsPostingId: job.id,
      title: job.title.trim(),
      url: job.jobUrl,
      department: job.department ?? job.team ?? null,
      employmentType: job.employmentType ? (EMPLOYMENT_TYPES[job.employmentType] ?? null) : null,
      postedAt: job.publishedAt ? new Date(job.publishedAt) : null,
      locations: locationClaims(job),
      compensation: compensation(job),
    };
  },
};

const EMPLOYMENT_TYPES: Record<string, EmploymentType> = {
  FullTime: 'full_time',
  PartTime: 'part_time',
  Contract: 'contract',
  Intern: 'internship',
  Temporary: 'temporary',
};

type AshbyAddress = AshbyJob['address'];

/**
 * Ashby gives each location twice: a free-text label the company typed ("Remote, EMEA",
 * "Yerevan, Armenia") and a structured postal address that is often missing or lossy
 * (a "North America" label stored with addressCountry "United States"). Both are read and
 * their places are unioned: a spurious extra claim costs a glance, a dropped one can hide
 * an open posting — and false negatives are the expensive kind here.
 */
function locationClaims(job: AshbyJob): LocationClaim[] {
  const entries = [
    { label: job.location, address: job.address },
    ...(job.secondaryLocations ?? []).map((s) => ({ label: s.location, address: s.address })),
  ];

  const claims = new Map<string, LocationClaim>();
  const add = (claim: LocationClaim) => {
    const key = [claim.kind, claim.countryCode, claim.region, claim.city].join('|');
    if (!claims.has(key)) claims.set(key, claim);
  };

  for (const { label, address } of entries) {
    const postal = address?.postalAddress;
    const kind = locationKind(job, label);
    const raw = describe(label, address);
    // Label segments that restate the address's locality or region ("Atlanta, Georgia" with
    // addressRegion "Georgia") are the address, not extra places — don't reinterpret them.
    const fromLabel = resolvePlaces(label, {
      skip: [postal?.addressLocality, postal?.addressRegion],
    });
    const fromAddress = postal?.addressCountry
      ? resolvePlaces(postal.addressCountry)
      : { countries: [], regions: [] };

    // The locality belongs to the address's country, so only attach it when that is unambiguous.
    const addressCountry = fromAddress.countries.length === 1 ? fromAddress.countries[0] : null;
    const city = postal?.addressLocality?.trim() || null;
    const cityFor = (code: CountryCode) => (code === addressCountry ? city : null);

    const countries = new Set([...fromAddress.countries, ...fromLabel.countries]);
    const regions = new Set([...fromLabel.regions, ...fromAddress.regions]);

    for (const region of regions) add({ kind, countryCode: null, region, city: null, raw });
    for (const code of countries)
      add({ kind, countryCode: code, region: null, city: cityFor(code), raw });
    if (countries.size === 0 && regions.size === 0) {
      add({ kind, countryCode: null, region: null, city, raw });
    }
  }
  return [...claims.values()];
}

/**
 * The most specific signal wins: the location's own label ("Remote (US or Canada)" on a
 * posting marked Hybrid), then the posting's workplaceType, then isRemote — which Ashby
 * also sets for Hybrid postings, so it is only a last resort.
 */
function locationKind(job: AshbyJob, label: string): LocationKind {
  if (/\bremote\b/i.test(label)) return 'remote_region';
  if (/\b(hybrid|on-?site|office)\b/i.test(label)) return 'office';
  switch (job.workplaceType) {
    case 'Remote':
      return 'remote_region';
    case 'Hybrid':
    case 'OnSite':
      return 'office';
  }
  return job.isRemote ? 'remote_region' : 'office';
}

/** "Remote [Serbia]", "Istanbul [Istanbul, Şişli, Turkey]" — label plus address, no street. */
function describe(label: string, address: AshbyAddress): string {
  const postal = address?.postalAddress;
  const parts = [postal?.addressLocality, postal?.addressRegion, postal?.addressCountry]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  const text = label.trim();
  return parts.length === 0 || parts.join(', ') === text ? text : `${text} [${parts.join(', ')}]`;
}

const PERIODS: Record<string, CompensationPeriod> = {
  '1 YEAR': 'year',
  '1 MONTH': 'month',
  '1 WEEK': 'week',
  '1 DAY': 'day',
  '1 HOUR': 'hour',
};

/** Base salary only; equity and bonus components stay in the stored payload. */
function compensation(job: AshbyJob): Compensation[] {
  return (job.compensation?.summaryComponents ?? [])
    .filter((c) => c.compensationType === 'Salary' && (c.minValue != null || c.maxValue != null))
    .map((c) => ({
      min: c.minValue ?? null,
      max: c.maxValue ?? null,
      currency: c.currencyCode ?? null,
      period: c.interval ? (PERIODS[c.interval] ?? null) : null,
      source: 'ashby.summaryComponents',
    }));
}
