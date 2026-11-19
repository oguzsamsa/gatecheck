/**
 * Teamtailor careers sites. There is no JSON board API; the structured sources are:
 *
 * - `https://{careers-host}/jobs.rss` — every published job with `remoteStatus`
 *   (fully | hybrid | temporary | none) and `tt:locations` (name, city, country);
 * - the job page's schema.org JobPosting JSON-LD, whose `applicantLocationRequirements`
 *   is the strongest statement a posting can make about who may apply.
 *
 * Job pages are fetched only for fully remote postings: that is the only case where
 * applicant requirements change the answer, and it keeps a poll to one request per board
 * on most days. JSON-LD `jobLocation` is deliberately ignored — Teamtailor fills it with
 * the company's HQ by default, so it is not a constraint; neither is an empty
 * `tt:locations` list.
 *
 * The org is the careers host, e.g. `career.teamtailor.com` or `careers.example.com`.
 */
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import type { LocationKind } from '../domain/types.ts';
import { claimsFromEntries, type LocationEntry } from './claims.ts';
import { employmentTypeFromText } from './fields.ts';
import { htmlToText } from './text.ts';
import { SourceError } from './http.ts';
import type { BoardSource } from './types.ts';

const RssLocation = z.looseObject({
  'tt:name': z.string().nullish(),
  'tt:city': z.string().nullish(),
  'tt:country': z.string().nullish(),
});

const RssItem = z.looseObject({
  guid: z.string(),
  title: z.string(),
  link: z.string(),
  pubDate: z.string().nullish(),
  description: z.string().nullish(),
  remoteStatus: z.string().nullish(),
  'tt:department': z.string().nullish(),
  'tt:locations': z
    .union([z.looseObject({ 'tt:location': z.array(RssLocation).nullish() }), z.literal('')])
    .nullish(),
});

const Rss = z.looseObject({
  rss: z.looseObject({
    channel: z.looseObject({ item: z.array(RssItem).nullish() }),
  }),
});

export interface TeamtailorPosting {
  id: string;
  title: string;
  url: string;
  pubDate: string | null;
  description: string | null;
  remoteStatus: string | null;
  department: string | null;
  locations: { name: string | null; city: string | null; country: string | null }[];
  /** From the job page; null when the page was not needed or carried no JobPosting. */
  jsonLd: {
    applicantLocationRequirements: string[];
    employmentType: string | null;
  } | null;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === 'item' || name === 'tt:location',
});

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

export const teamtailor: BoardSource<TeamtailorPosting> = {
  ats: 'teamtailor',

  async fetch(host, { http, previous }) {
    const url = `https://${host}/jobs.rss`;
    if (!HOST.test(host)) throw new SourceError(`invalid Teamtailor host "${host}"`, { url });

    const response = await http.getText(url, previous);
    if (response.status === 'not_modified') return response;

    let xml: unknown;
    try {
      xml = parser.parse(response.body);
    } catch (cause) {
      throw new SourceError('feed is not valid XML', {
        url,
        httpStatus: response.httpStatus,
        cause,
      });
    }
    const parsed = Rss.safeParse(xml);
    if (!parsed.success) {
      throw new SourceError(`unexpected feed shape: ${z.prettifyError(parsed.error)}`, {
        url,
        httpStatus: response.httpStatus,
      });
    }

    const postings: TeamtailorPosting[] = [];
    for (const item of parsed.data.rss.channel.item ?? []) {
      const locations =
        item['tt:locations'] === '' ? [] : (item['tt:locations']?.['tt:location'] ?? []);
      const posting: TeamtailorPosting = {
        id: item.guid,
        title: item.title,
        url: item.link,
        pubDate: item.pubDate ?? null,
        description: item.description ?? null,
        remoteStatus: item.remoteStatus ?? null,
        department: item['tt:department'] || null,
        locations: locations.map((l) => ({
          name: l['tt:name'] ?? null,
          city: l['tt:city'] ?? null,
          country: l['tt:country'] ?? null,
        })),
        jsonLd: null,
      };
      if (posting.remoteStatus === 'fully') posting.jsonLd = await readJobPage(http, item.link);
      postings.push(posting);
    }

    return {
      status: 'ok',
      httpStatus: response.httpStatus,
      postings,
      validators: response.validators,
    };
  },

  normalize(p) {
    const postedAt = p.pubDate ? new Date(p.pubDate) : null;
    return {
      atsPostingId: p.id,
      title: p.title.trim(),
      url: p.url,
      department: p.department,
      employmentType: employmentTypeFromText(p.jsonLd?.employmentType),
      postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
      locations: claimsFromEntries(locationEntries(p)),
      compensation: [],
    };
  },

  text: (p) => htmlToText(p.description),
};

function locationEntries(p: TeamtailorPosting): LocationEntry[] {
  const kind: LocationKind = p.remoteStatus === 'fully' ? 'remote_region' : 'office';
  return [
    ...(p.jsonLd?.applicantLocationRequirements ?? []).map((label) => ({
      label,
      kind: 'applicant_requirement' as const,
    })),
    ...p.locations.map((l) => ({
      label: l.name ?? '',
      kind,
      country: l.country,
      locality: l.city,
    })),
  ];
}

const JsonLdPlace = z.looseObject({ name: z.string().nullish() });
const JobPostingLd = z.looseObject({
  '@type': z.literal('JobPosting'),
  employmentType: z.union([z.string(), z.array(z.string())]).nullish(),
  applicantLocationRequirements: z.union([JsonLdPlace, z.array(JsonLdPlace)]).nullish(),
});

/** The JobPosting JSON-LD of a job page; null if the page is gone or carries none. */
async function readJobPage(
  http: Parameters<BoardSource['fetch']>[1]['http'],
  url: string,
): Promise<TeamtailorPosting['jsonLd']> {
  let html: string;
  try {
    const response = await http.getText(url);
    if (response.status !== 'ok') return null;
    html = response.body;
  } catch (error) {
    // Unpublished between the feed and the page: the next poll will see it gone.
    if (error instanceof SourceError && error.httpStatus === 404) return null;
    throw error;
  }
  for (const [, json = ''] of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      continue;
    }
    const ld = JobPostingLd.safeParse(data);
    if (!ld.success) continue;
    const requirements = ld.data.applicantLocationRequirements;
    const employment = ld.data.employmentType;
    return {
      applicantLocationRequirements: (Array.isArray(requirements)
        ? requirements
        : requirements
          ? [requirements]
          : []
      )
        .map((r) => r.name?.trim() ?? '')
        .filter(Boolean),
      employmentType: Array.isArray(employment) ? (employment[0] ?? null) : (employment ?? null),
    };
  }
  return null;
}
