/**
 * Recognising an ATS board from a URL or from a careers page's HTML.
 */
import type { Ats } from '../domain/types.ts';

export interface BoardRef {
  ats: Ats;
  org: string;
}

const RESERVED = new Set(['embed', 'api', 'apply', 'v1', 'jobs', 'j', 'o', 'careers', 'www']);

/** Board identifiers are plain slugs; anything else is a template or a fragment. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An ATS board a URL points into, if it is one of the hosted boards we know. */
export function detectFromUrl(input: string): BoardRef | null {
  const ref = boardInUrl(input);
  return ref && SLUG.test(ref.org) ? ref : null;
}

function boardInUrl(input: string): BoardRef | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const first = url.pathname.split('/').filter(Boolean)[0];
  const forParam = url.searchParams.get('for');

  if (host === 'jobs.ashbyhq.com' && first) return { ats: 'ashby', org: decodeURIComponent(first) };
  if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host)) {
    if (first === 'embed' && forParam) return { ats: 'greenhouse', org: forParam };
    if (first && !RESERVED.has(first)) return { ats: 'greenhouse', org: first };
  }
  if (host === 'jobs.lever.co' && first) return { ats: 'lever', org: first };
  if (host === 'apply.workable.com' && first && !RESERVED.has(first)) {
    return { ats: 'workable', org: first };
  }
  const sub = /^([a-z0-9-]+)\.(recruitee|workable|teamtailor)\.com$/.exec(host);
  if (sub?.[1] && !RESERVED.has(sub[1])) {
    if (sub[2] === 'recruitee') return { ats: 'recruitee', org: sub[1] };
    if (sub[2] === 'workable') return { ats: 'workable', org: sub[1] };
    return { ats: 'teamtailor', org: host };
  }
  return null;
}

/**
 * Boards referenced from a careers page: links and embeds pointing at a hosted board, and
 * Ashby's embedded-board snippet (`const board = "jobs.example.com"`), which is how a
 * board on a custom domain gives its identifier away.
 */
export function detectInHtml(html: string, pageUrl?: string): BoardRef[] {
  const found = new Map<string, BoardRef>();
  const add = (ref: BoardRef | null) => {
    // Board slugs are case-insensitive ("Svix" and "svix" are one board); keep the first.
    const key = ref && `${ref.ats}:${ref.org.toLowerCase()}`;
    if (ref && key && !found.has(key)) found.set(key, ref);
  };
  for (const [url] of html.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)\\]*/gi)) {
    add(detectFromUrl(url.replace(/&amp;/g, '&')));
  }
  for (const [, board] of html.matchAll(/\bboard\s*[=:]\s*["']([a-z0-9.-]+)["']/gi)) {
    if (board && SLUG.test(board) && /ashby/i.test(html)) add({ ats: 'ashby', org: board });
  }
  // A Teamtailor career site served from the company's own domain: the page itself is the
  // board, recognisable by the career-site bundle it loads. Its feed lives on that host.
  const host = pageUrl ? hostOf(pageUrl) : null;
  if (host && /teamtailor-cdn\.com\/assets\/careersite/i.test(html)) {
    add({ ats: 'teamtailor', org: host });
  }
  return [...found.values()];
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Applicant-tracking systems we have no adapter for, by the fingerprints their hosted
 * boards and embeds leave in a careers page. Only counted, to decide which adapter is
 * worth writing next; nothing is fetched from them.
 */
const UNSUPPORTED: [name: string, pattern: RegExp][] = [
  ['workday', /\.myworkdayjobs\.com|\.myworkdaysite\.com/i],
  ['smartrecruiters', /(careers|jobs)\.smartrecruiters\.com/i],
  ['personio', /\.jobs\.personio\.(de|com)/i],
  ['icims', /\.icims\.com/i],
  ['successfactors', /successfactors\.(com|eu)|jobs\.sap\.com|career\d*\.successfactors/i],
  ['bamboohr', /\.bamboohr\.com\/(careers|jobs)/i],
  ['breezy', /\.breezy\.hr/i],
  ['jazzhr', /\.applytojob\.com|jazzhr/i],
  ['jobvite', /jobs\.jobvite\.com/i],
  ['rippling', /ats\.rippling\.com/i],
  ['dover', /app\.dover\.(io|com)\/(apply|jobs)/i],
  ['pinpoint', /\.pinpointhq\.com/i],
  ['comeet', /comeet\.(co|com)\/jobs/i],
  ['homerun', /\.homerun\.co/i],
  ['join', /join\.com\/companies/i],
  ['factorial', /\.factorialhr\.com/i],
  ['hibob', /\.careers\.hibob\.com/i],
  ['welcometothejungle', /welcometothejungle\.com\/[a-z]{2}\/companies/i],
  ['manatal', /careers-page\.com/i],
  ['phenom', /phenompeople\.com|cdn\.phenompeople/i],
  ['wellfound', /(wellfound|angel)\.co(m)?\/company/i],
];

export function detectUnsupported(html: string): string[] {
  return UNSUPPORTED.filter(([, pattern]) => pattern.test(html)).map(([name]) => name);
}

const CAREERS_HINT =
  /career|jobs?\b|join[-_ ]?(us|the[-_ ]team|our[-_ ]team)|work[-_ ]with[-_ ]us|hiring|vacanc|open[-_ ]positions|openings|stellen|karriere|kariyer/i;

/**
 * Links on a company's home page that look like its careers page: same site (or a hosted
 * board), most likely first. Used for one hop when the given page carries no board.
 */
export function careersLinks(html: string, pageUrl: string, max = 3): string[] {
  const base = hostOf(pageUrl);
  if (!base) return [];
  const site = base.replace(/^www\./, '');
  const out: string[] = [];
  for (const [, href, text] of html.matchAll(
    /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gis,
  )) {
    if (!href || href.startsWith('#')) continue;
    let url: URL;
    try {
      url = new URL(href.replace(/&amp;/g, '&'), pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    const host = url.hostname.toLowerCase();
    const sameSite = host === site || host.endsWith(`.${site}`);
    const label = (text ?? '').replace(/<[^>]*>/g, ' ');
    if (!sameSite && !detectFromUrl(url.href)) continue;
    if (!CAREERS_HINT.test(url.pathname + ' ' + host) && !CAREERS_HINT.test(label)) continue;
    url.hash = '';
    if (url.href !== pageUrl && !out.includes(url.href)) out.push(url.href);
    if (out.length >= max) break;
  }
  return out;
}
