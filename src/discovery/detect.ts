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
export function detectInHtml(html: string): BoardRef[] {
  const found = new Map<string, BoardRef>();
  const add = (ref: BoardRef | null) => {
    if (ref) found.set(`${ref.ats}:${ref.org}`, ref);
  };
  for (const [url] of html.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)\\]*/gi)) {
    add(detectFromUrl(url.replace(/&amp;/g, '&')));
  }
  for (const [, board] of html.matchAll(/\bboard\s*[=:]\s*["']([a-z0-9.-]+)["']/gi)) {
    if (board && SLUG.test(board) && /ashby/i.test(html)) add({ ats: 'ashby', org: board });
  }
  return [...found.values()];
}
