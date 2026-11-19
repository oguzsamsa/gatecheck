import { z } from 'zod';

/**
 * The subset of Ashby's public job-board API we read. Objects are `looseObject` so unknown
 * fields survive into the stored payload, and fields are `nullish` rather than defaulted so
 * the parsed value stays identical to what Ashby sent (it is what gets hashed and stored).
 *
 * GET https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true
 */

const PostalAddress = z.looseObject({
  addressCountry: z.string().nullish(),
  addressRegion: z.string().nullish(),
  addressLocality: z.string().nullish(),
});

const Address = z.looseObject({ postalAddress: PostalAddress.nullish() }).nullish();

const CompensationComponent = z.looseObject({
  compensationType: z.string(),
  interval: z.string().nullish(),
  currencyCode: z.string().nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
});

export const AshbyJob = z.looseObject({
  id: z.string(),
  title: z.string(),
  department: z.string().nullish(),
  team: z.string().nullish(),
  /** FullTime | PartTime | Intern | Contract | Temporary */
  employmentType: z.string().nullish(),
  /** Free-text label of the primary location, e.g. "Remote", "Barcelona", "Remote, EMEA". */
  location: z.string(),
  address: Address,
  secondaryLocations: z.array(z.looseObject({ location: z.string(), address: Address })).nullish(),
  /** Remote | Hybrid | OnSite — null on some boards. */
  workplaceType: z.string().nullish(),
  /** Not reliable on its own: Ashby reports `true` for Hybrid postings too. */
  isRemote: z.boolean().nullish(),
  isListed: z.boolean().nullish(),
  publishedAt: z.string().nullish(),
  jobUrl: z.string(),
  descriptionPlain: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  compensation: z
    .looseObject({ summaryComponents: z.array(CompensationComponent).nullish() })
    .nullish(),
});
export type AshbyJob = z.infer<typeof AshbyJob>;

export const AshbyBoard = z.looseObject({ jobs: z.array(AshbyJob) });
