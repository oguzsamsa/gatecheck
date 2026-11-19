/**
 * Workable's public careers widget API.
 *
 * GET https://apply.workable.com/api/v1/widget/accounts/{account}?details=true
 *
 * Every location carries an ISO `countryCode`; `telecommuting` marks the job remote. Hidden
 * locations (an internal-only office) are skipped.
 */
import { z } from 'zod';
import { claimsFromEntries, type LocationEntry } from './claims.ts';
import { fetchValidated } from './fetch.ts';
import { employmentTypeFromText } from './fields.ts';
import type { BoardSource } from './types.ts';

const WorkableLocation = z.looseObject({
  country: z.string().nullish(),
  countryCode: z.string().nullish(),
  city: z.string().nullish(),
  region: z.string().nullish(),
  hidden: z.boolean().nullish(),
});

const WorkableJob = z.looseObject({
  shortcode: z.string(),
  title: z.string(),
  url: z.string(),
  employment_type: z.string().nullish(),
  telecommuting: z.boolean().nullish(),
  department: z.string().nullish(),
  published_on: z.string().nullish(),
  country: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  locations: z.array(WorkableLocation).nullish(),
});
type WorkableJob = z.infer<typeof WorkableJob>;

const WorkableAccount = z.looseObject({ jobs: z.array(WorkableJob) });

export const workable: BoardSource<WorkableJob> = {
  ats: 'workable',

  fetch(account, ctx) {
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}?details=true`;
    return fetchValidated(ctx, url, WorkableAccount, (data) => data.jobs);
  },

  normalize(job) {
    return {
      atsPostingId: job.shortcode,
      title: job.title.trim(),
      url: job.url,
      department: job.department || null,
      employmentType: employmentTypeFromText(job.employment_type),
      postedAt: job.published_on ? new Date(`${job.published_on}T00:00:00Z`) : null,
      locations: claimsFromEntries(locationEntries(job)),
      compensation: [],
    };
  },
};

function locationEntries(job: WorkableJob): LocationEntry[] {
  const kind = job.telecommuting ? 'remote_region' : 'office';
  const visible = (job.locations ?? []).filter((l) => !l.hidden);
  const locations = visible.length
    ? visible
    : [{ country: job.country, countryCode: null, city: job.city, region: job.state }];
  return locations.map((l) => ({
    label: '',
    kind,
    country: l.countryCode || l.country,
    locality: l.city,
    region: l.region,
  }));
}
