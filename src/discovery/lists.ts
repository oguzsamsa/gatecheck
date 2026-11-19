/**
 * Company lists to discover boards from: a plain text file of careers URLs, or a directory
 * of Markdown company profiles with YAML front matter (the format of the community
 * remote-company directory github.com/remoteintech/remote-jobs, `src/companies/*.md`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ListEntry {
  name: string;
  /** Pages to look for a board on, most specific first (careers page, then home page). */
  urls: string[];
}

/** Reads a list file or profile directory. */
export function readList(path: string): ListEntry[] {
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => entryFromProfile(readFileSync(join(path, f), 'utf8')))
      .filter((e): e is ListEntry => e !== null);
  }
  return parseTextList(readFileSync(path, 'utf8'));
}

/**
 * One company per line: `URL` or `Name | URL [| URL…]`. Blank lines and `#` comments are
 * skipped. Without a name, the host stands in for it.
 */
export function parseTextList(text: string): ListEntry[] {
  const out: ListEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split('|').map((p) => p.trim());
    const urls = parts.filter(isHttpUrl);
    if (urls.length === 0) continue;
    const name = parts.find((p) => p && !isHttpUrl(p)) ?? new URL(urls[0] ?? '').hostname;
    out.push({ name, urls });
  }
  return out;
}

/** A remoteintech-style profile: `title`, `careers_url` and `website` from its front matter. */
export function entryFromProfile(markdown: string): ListEntry | null {
  const front = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1];
  if (!front) return null;
  const field = (key: string) => {
    const value = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)?.[1]?.trim();
    return value?.replace(/^(["'])(.*)\1$/, '$2').trim() || undefined;
  };
  const name = field('title');
  const urls = [field('careers_url'), field('website')].filter(
    (u, i, all): u is string => u !== undefined && isHttpUrl(u) && all.indexOf(u) === i,
  );
  return name && urls.length ? { name, urls } : null;
}

function isHttpUrl(s: string): boolean {
  try {
    return /^https?:$/.test(new URL(s).protocol);
  } catch {
    return false;
  }
}
