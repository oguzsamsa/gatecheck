/**
 * Greenhouse job board API.
 *
 * GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true
 *
 * Location is a free-text `location.name` (several places joined with ";"), plus `offices`
 * — usually places ("Ireland Locations", "EMEA"), sometimes business units ("Legal Group"),
 * so offices are read as weak hints. There is no workplace-type field; the label decides.
 */
import { z } from 'zod';
import { claimsFromEntries, kindFromLabel, type LocationEntry } from './claims.ts';
import { fetchValidated, omitKeys } from './fetch.ts';
import { htmlToText } from './text.ts';
import type { BoardSource } from './types.ts';

const GreenhouseJob = z.looseObject({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  location: z.looseObject({ name: z.string().nullish() }).nullish(),
  offices: z.array(z.looseObject({ name: z.string() })).nullish(),
  departments: z.array(z.looseObject({ name: z.string() })).nullish(),
  first_published: z.string().nullish(),
  updated_at: z.string().nullish(),
  content: z.string().nullish(),
});
type GreenhouseJob = z.infer<typeof GreenhouseJob>;

const GreenhouseBoard = z.looseObject({ jobs: z.array(GreenhouseJob) });

export const greenhouse: BoardSource<GreenhouseJob> = {
  ats: 'greenhouse',

  fetch(board, ctx) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`;
    return fetchValidated(ctx, url, GreenhouseBoard, (data) => data.jobs);
  },

  normalize(job) {
    return {
      atsPostingId: String(job.id),
      title: job.title.trim(),
      url: job.absolute_url,
      department: job.departments?.[0]?.name ?? null,
      employmentType: null,
      postedAt: job.first_published ? new Date(job.first_published) : null,
      locations: claimsFromEntries(locationEntries(job)),
      compensation: [],
    };
  },

  fingerprint: (job) => omitKeys(job, ['updated_at']),

  text: (job) => htmlToText(job.content),
};

function locationEntries(job: GreenhouseJob): LocationEntry[] {
  const labels = (job.location?.name ?? '')
    .split(';')
    .map((l) => l.trim())
    .filter(Boolean);
  const entries: LocationEntry[] = labels.map((label) => ({
    label,
    kind: kindFromLabel(label) ?? 'office',
  }));
  const kind = entries[0]?.kind ?? 'office';
  for (const office of job.offices ?? []) {
    entries.push({ label: office.name, kind, weak: true });
  }
  return entries;
}
