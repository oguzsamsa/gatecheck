import type { Compensation, CompensationPeriod, EmploymentType } from '../../domain/types.ts';
import { claimsFromEntries, kindFromLabel, type LocationEntry } from '../claims.ts';
import { fetchValidated } from '../fetch.ts';
import type { BoardSource } from '../types.ts';
import { AshbyBoard, type AshbyJob } from './schema.ts';

export const ashby: BoardSource<AshbyJob> = {
  ats: 'ashby',

  fetch(board, ctx) {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`;
    return fetchValidated(ctx, url, AshbyBoard, (data) => data.jobs);
  },

  normalize(job) {
    return {
      atsPostingId: job.id,
      title: job.title.trim(),
      url: job.jobUrl,
      department: job.department ?? job.team ?? null,
      employmentType: job.employmentType ? (EMPLOYMENT_TYPES[job.employmentType] ?? null) : null,
      postedAt: job.publishedAt ? new Date(job.publishedAt) : null,
      locations: claimsFromEntries(locationEntries(job)),
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

/**
 * Ashby gives each location twice: the label the company typed and a structured postal
 * address that is often missing or lossy. Both go to the shared claim rules.
 */
function locationEntries(job: AshbyJob): LocationEntry[] {
  const locations = [
    { label: job.location, address: job.address },
    ...(job.secondaryLocations ?? []).map((s) => ({ label: s.location, address: s.address })),
  ];
  return locations.map(({ label, address }) => {
    const postal = address?.postalAddress;
    return {
      label,
      kind: locationKind(job, label),
      country: postal?.addressCountry,
      locality: postal?.addressLocality,
      region: postal?.addressRegion,
    };
  });
}

/**
 * The most specific signal wins: the location's own label, then the posting's
 * workplaceType, then isRemote — which Ashby also sets for Hybrid postings, so it is only a
 * last resort.
 */
function locationKind(job: AshbyJob, label: string) {
  const fromLabel = kindFromLabel(label);
  if (fromLabel) return fromLabel;
  switch (job.workplaceType) {
    case 'Remote':
      return 'remote_region';
    case 'Hybrid':
    case 'OnSite':
      return 'office';
  }
  return job.isRemote ? 'remote_region' : 'office';
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
