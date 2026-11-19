/**
 * Lever postings API.
 *
 * GET https://api.lever.co/v0/postings/{org}?mode=json
 *
 * Each posting has free-text `categories.allLocations` ("London", "UAE, Dubai", "Asia"),
 * an ISO `country` for its primary location, a `workplaceType`
 * (remote | hybrid | onsite | unspecified) and sometimes a structured `salaryRange`.
 */
import { z } from 'zod';
import type { LocationKind } from '../domain/types.ts';
import { claimsFromEntries, kindFromLabel, type LocationEntry } from './claims.ts';
import { fetchValidated } from './fetch.ts';
import { employmentTypeFromText, periodFromText } from './fields.ts';
import type { BoardSource } from './types.ts';

const LeverPosting = z.looseObject({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  categories: z.looseObject({
    location: z.string().nullish(),
    allLocations: z.array(z.string()).nullish(),
    department: z.string().nullish(),
    team: z.string().nullish(),
    commitment: z.string().nullish(),
  }),
  country: z.string().nullish(),
  workplaceType: z.string().nullish(),
  createdAt: z.number().nullish(),
  salaryRange: z
    .looseObject({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      interval: z.string().nullish(),
    })
    .nullish(),
});
type LeverPosting = z.infer<typeof LeverPosting>;

export const lever: BoardSource<LeverPosting> = {
  ats: 'lever',

  fetch(org, ctx) {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(org)}?mode=json`;
    return fetchValidated(ctx, url, z.array(LeverPosting), (postings) => postings);
  },

  normalize(p) {
    const salary = p.salaryRange;
    return {
      atsPostingId: p.id,
      title: p.text.trim(),
      url: p.hostedUrl,
      department: p.categories.department ?? p.categories.team ?? null,
      employmentType: employmentTypeFromText(p.categories.commitment),
      postedAt: p.createdAt ? new Date(p.createdAt) : null,
      locations: claimsFromEntries(locationEntries(p)),
      compensation:
        salary && (salary.min != null || salary.max != null)
          ? [
              {
                min: salary.min ?? null,
                max: salary.max ?? null,
                currency: salary.currency ?? null,
                period: periodFromText(salary.interval),
                source: 'lever.salaryRange',
              },
            ]
          : [],
    };
  },
};

const WORKPLACE: Record<string, LocationKind> = {
  remote: 'remote_region',
  hybrid: 'office',
  onsite: 'office',
};

function locationEntries(p: LeverPosting): LocationEntry[] {
  const primary = p.categories.location ?? null;
  const labels = p.categories.allLocations?.length
    ? p.categories.allLocations
    : primary
      ? [primary]
      : [];
  return labels.map((label) => ({
    label,
    kind: kindFromLabel(label) ?? WORKPLACE[p.workplaceType ?? ''] ?? 'office',
    // Lever's ISO country describes the primary location only.
    country: label === primary ? p.country : null,
  }));
}
