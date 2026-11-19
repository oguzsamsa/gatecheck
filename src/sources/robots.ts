/**
 * robots.txt per RFC 9309.
 *
 * - The group for our product token applies if present, otherwise the `*` group; several
 *   groups naming the same agent are merged.
 * - The longest matching rule wins; on a tie, Allow wins. `*` matches any run of
 *   characters and a trailing `$` anchors the end.
 * - A 4xx robots.txt (none published, or access refused) means everything is allowed; a
 *   5xx or unreachable one means nothing is, until it can be read.
 *
 * `Crawl-delay` is not in the RFC but is honoured when present: being slower than asked
 * costs nothing.
 */

export const PRODUCT_TOKEN = 'gatecheck';

interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

export interface Robots {
  isAllowed(pathAndQuery: string): boolean;
  /** Seconds, if the applicable group sets one. */
  crawlDelay: number | null;
}

export const ALLOW_ALL: Robots = { isAllowed: () => true, crawlDelay: null };
export const DISALLOW_ALL: Robots = { isAllowed: () => false, crawlDelay: null };

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Percent-encoding is compared case-insensitively and unreserved escapes are decoded. */
function normalizePath(path: string): string {
  return path.replace(/%[0-9a-f]{2}/gi, (escape) => {
    const ch = String.fromCharCode(parseInt(escape.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : escape.toUpperCase();
  });
}

export function parseRobots(text: string, token = PRODUCT_TOKEN): Robots {
  interface Group {
    agents: string[];
    rules: Rule[];
    crawlDelay: number | null;
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if ((key === 'allow' || key === 'disallow') && value !== '') {
      const pattern = normalizePath(value);
      current.rules.push({ allow: key === 'allow', pattern, regex: toRegex(pattern) });
    } else if (key === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }

  const ours = groups.filter((g) => g.agents.some((a) => a === token.toLowerCase()));
  const applicable = ours.length > 0 ? ours : groups.filter((g) => g.agents.includes('*'));
  const rules = applicable.flatMap((g) => g.rules);
  const delays = applicable.map((g) => g.crawlDelay).filter((d): d is number => d !== null);

  return {
    crawlDelay: delays.length > 0 ? Math.max(...delays) : null,
    isAllowed(pathAndQuery) {
      const path = normalizePath(pathAndQuery);
      if (path === '/robots.txt') return true;
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.regex.test(path)) continue;
        if (
          !best ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow)
        ) {
          best = rule;
        }
      }
      return best?.allow ?? true;
    },
  };
}
