/**
 * Aggregators as a company-discovery source, never as a posting source: all we take from
 * them is "company X is hiring for title Y" (plus any links in the text). Postings are
 * then read from the company's own ATS, so the aggregator's delay and paywall are paid
 * once per company and skipped forever after.
 *
 * Not used, on purpose: LinkedIn (its terms forbid automated collection), Jobgether
 * (paywalled), and job pages behind bot protection (WeWorkRemotely's listing pages answer
 * automated clients with 403 — only its public RSS is read).
 */
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { SourceError, type HttpClient } from '../sources/http.ts';

export interface Listing {
  company: string;
  title: string;
  /** The aggregator's page for this listing — recorded as `discovered_from`. */
  url: string;
  /** URLs found in the listing text; may point straight at an ATS board. */
  links: string[];
}

export interface Aggregator {
  readonly name: string;
  listings(http: HttpClient, opts: { pages: number }): Promise<Listing[]>;
}

const linksIn = (html: string | null | undefined) =>
  [...(html ?? '').matchAll(/https?:\/\/[^\s"'<>)]+/g)].map(([u]) => u.replace(/&amp;/g, '&'));

const HimalayasPage = z.looseObject({
  jobs: z.array(
    z.looseObject({
      title: z.string(),
      companyName: z.string(),
      guid: z.string(),
      description: z.string().nullish(),
    }),
  ),
});

/** https://himalayas.app/jobs/api — newest remote jobs, paginated by offset. */
export const himalayas: Aggregator = {
  name: 'himalayas',
  async listings(http, { pages }) {
    const limit = 20;
    const out: Listing[] = [];
    for (let page = 0; page < pages; page++) {
      const url = `https://himalayas.app/jobs/api?limit=${limit}&offset=${page * limit}`;
      const response = await http.getJson(url);
      if (response.status !== 'ok') break;
      const parsed = HimalayasPage.safeParse(response.body);
      if (!parsed.success) throw new SourceError('unexpected Himalayas payload', { url });
      for (const job of parsed.data.jobs) {
        out.push({
          company: job.companyName,
          title: job.title,
          url: job.guid,
          links: linksIn(job.description),
        });
      }
      if (parsed.data.jobs.length < limit) break;
    }
    return out;
  },
};

const WWR_CATEGORIES = [
  'remote-full-stack-programming-jobs',
  'remote-back-end-programming-jobs',
  'remote-front-end-programming-jobs',
  'remote-devops-sysadmin-jobs',
];

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (n) => n === 'item',
});
const WwrFeed = z.looseObject({
  rss: z.looseObject({
    channel: z.looseObject({
      item: z
        .array(
          z.looseObject({ title: z.string(), link: z.string(), description: z.string().nullish() }),
        )
        .nullish(),
    }),
  }),
});

/** WeWorkRemotely's public category feeds; titles read "Company: Role". */
export const weworkremotely: Aggregator = {
  name: 'weworkremotely',
  async listings(http, { pages }) {
    const out: Listing[] = [];
    for (const category of WWR_CATEGORIES.slice(0, Math.max(1, pages))) {
      const url = `https://weworkremotely.com/categories/${category}.rss`;
      const response = await http.getText(url);
      if (response.status !== 'ok') continue;
      const parsed = WwrFeed.safeParse(parser.parse(response.body));
      if (!parsed.success) throw new SourceError('unexpected WeWorkRemotely feed', { url });
      for (const item of parsed.data.rss.channel.item ?? []) {
        const split = item.title.indexOf(': ');
        if (split <= 0) continue;
        out.push({
          company: item.title.slice(0, split).trim(),
          title: item.title.slice(split + 2).trim(),
          url: item.link,
          links: linksIn(item.description),
        });
      }
    }
    return out;
  },
};

export const AGGREGATORS: Record<string, Aggregator> = { himalayas, weworkremotely };
