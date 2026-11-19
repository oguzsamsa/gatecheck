/**
 * Recruitee careers site API.
 *
 * GET https://{org}.recruitee.com/api/offers/
 *
 * The most structured of the four: every location carries an ISO `country_code`, and
 * `remote` / `hybrid` / `on_site` are explicit. When a remote offer makes the applicant
 * pick one of its locations (`locations_question_required`), that list is a requirement on
 * the applicant, not just a label.
 */
import { z } from 'zod';
import type { LocationKind } from '../domain/types.ts';
import { claimsFromEntries, type LocationEntry } from './claims.ts';
import { fetchValidated, omitKeys } from './fetch.ts';
import { employmentTypeFromText, periodFromText, toNumber } from './fields.ts';
import { SourceError } from './http.ts';
import { htmlToText } from './text.ts';
import type { BoardSource } from './types.ts';

const NumberLike = z.union([z.number(), z.string()]).nullish();

const RecruiteeLocation = z.looseObject({
  name: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  country_code: z.string().nullish(),
});

const RecruiteeOffer = z.looseObject({
  id: z.number(),
  slug: z.string(),
  title: z.string(),
  careers_url: z.string(),
  remote: z.boolean().nullish(),
  hybrid: z.boolean().nullish(),
  on_site: z.boolean().nullish(),
  location: z.string().nullish(),
  city: z.string().nullish(),
  country_code: z.string().nullish(),
  locations: z.array(RecruiteeLocation).nullish(),
  locations_question_required: z.boolean().nullish(),
  employment_type_code: z.string().nullish(),
  department: z.string().nullish(),
  description: z.string().nullish(),
  requirements: z.string().nullish(),
  published_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  salary: z
    .looseObject({
      min: NumberLike,
      max: NumberLike,
      period: z.string().nullish(),
      currency: z.string().nullish(),
    })
    .nullish(),
});
type RecruiteeOffer = z.infer<typeof RecruiteeOffer>;

const RecruiteeBoard = z.looseObject({ offers: z.array(RecruiteeOffer) });

export const recruitee: BoardSource<RecruiteeOffer> = {
  ats: 'recruitee',

  fetch(org, ctx) {
    // The org is a subdomain, so it must be a hostname label, not arbitrary text.
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(org)) {
      return Promise.reject(
        new SourceError(`invalid Recruitee org "${org}"`, { url: `https://${org}.recruitee.com` }),
      );
    }
    const url = `https://${org}.recruitee.com/api/offers/`;
    return fetchValidated(ctx, url, RecruiteeBoard, (data) => data.offers);
  },

  normalize(offer) {
    const salary = offer.salary;
    const min = toNumber(salary?.min);
    const max = toNumber(salary?.max);
    return {
      atsPostingId: String(offer.id),
      title: offer.title.trim(),
      url: offer.careers_url,
      department: offer.department ?? null,
      employmentType: employmentTypeFromText(offer.employment_type_code),
      postedAt: offer.published_at ? parseRecruiteeDate(offer.published_at) : null,
      locations: claimsFromEntries(locationEntries(offer)),
      compensation:
        min !== null || max !== null
          ? [
              {
                min,
                max,
                currency: salary?.currency ?? null,
                period: periodFromText(salary?.period),
                source: 'recruitee.salary',
              },
            ]
          : [],
    };
  },

  fingerprint: (offer) => omitKeys(offer, ['updated_at']),

  text: (offer) =>
    [htmlToText(offer.description), htmlToText(offer.requirements)].filter(Boolean).join('\n\n'),
};

function locationEntries(offer: RecruiteeOffer): LocationEntry[] {
  const kind: LocationKind = offer.remote
    ? offer.locations_question_required
      ? 'applicant_requirement'
      : 'remote_region'
    : 'office';
  const locations = offer.locations?.length
    ? offer.locations
    : [{ name: offer.location, city: offer.city, state: null, country_code: offer.country_code }];
  return locations.map((l) => ({
    label: l.name ?? '',
    kind,
    country: l.country_code,
    locality: l.city,
    region: l.state,
  }));
}

/** "2025-12-25 10:02:52 UTC" → Date. */
function parseRecruiteeDate(text: string): Date | null {
  const date = new Date(text.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}
