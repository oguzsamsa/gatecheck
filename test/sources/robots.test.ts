import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, SourceError } from '../../src/sources/http.ts';
import { parseRobots } from '../../src/sources/robots.ts';

describe('parseRobots', () => {
  it('blocks everything under "Disallow: /" for *', () => {
    const robots = parseRobots('User-Agent: *\nDisallow: /\nContent-Signal: search=no');
    expect(robots.isAllowed('/jobs.rss')).toBe(false);
    expect(robots.isAllowed('/robots.txt')).toBe(true);
  });

  it('applies our own group instead of *, and merges groups for the same agent', () => {
    const robots = parseRobots(
      [
        'User-agent: *',
        'Disallow: /',
        '',
        'User-agent: gatecheck',
        'Disallow: /private',
        '',
        'User-agent: gatecheck',
        'Disallow: /secret',
      ].join('\n'),
    );
    expect(robots.isAllowed('/jobs.rss')).toBe(true);
    expect(robots.isAllowed('/private/x')).toBe(false);
    expect(robots.isAllowed('/secret')).toBe(false);
  });

  it('lets the longest match win, and Allow win a tie', () => {
    const robots = parseRobots(
      'User-agent: *\nDisallow: /jobs\nAllow: /jobs/public\nAllow: /a\nDisallow: /a',
    );
    expect(robots.isAllowed('/jobs/internal/1')).toBe(false);
    expect(robots.isAllowed('/jobs/public/1')).toBe(true);
    expect(robots.isAllowed('/a')).toBe(true);
  });

  it('supports * wildcards and $ anchors', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/cache');
    expect(robots.isAllowed('/files/cv.pdf')).toBe(false);
    expect(robots.isAllowed('/files/cv.pdf?x=1')).toBe(true);
    expect(robots.isAllowed('/tmp-1/cache/a')).toBe(false);
  });

  it('shares rules among consecutive user-agent lines and ignores an empty Disallow', () => {
    const robots = parseRobots('User-agent: other\nUser-agent: *\nDisallow:\nCrawl-delay: 10');
    expect(robots.isAllowed('/anything')).toBe(true);
    expect(robots.crawlDelay).toBe(10);
  });
});

const urlOf = (input: string | URL | Request) =>
  input instanceof Request ? input.url : input.toString();

describe('createHttpClient + robots.txt', () => {
  const respond = (routes: Record<string, () => Response>) =>
    vi.fn<typeof fetch>((input) => {
      const url = urlOf(input);
      const route = routes[url];
      if (!route) return Promise.reject(new Error(`unexpected ${url}`));
      return Promise.resolve(route());
    });

  it('refuses a path robots.txt disallows, without requesting it', async () => {
    const fetch = respond({
      'https://careers.example.com/robots.txt': () => new Response('User-Agent: *\nDisallow: /'),
    });
    const http = createHttpClient({ fetch, sleep: () => Promise.resolve() });

    const error = await http
      .getText('https://careers.example.com/jobs.rss')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SourceError);
    expect(String(error)).toContain('disallowed by robots.txt');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reads robots.txt once per origin and treats 4xx as allow-all', async () => {
    const fetch = respond({
      'https://api.example.com/robots.txt': () => new Response('nope', { status: 401 }),
      'https://api.example.com/a': () => Response.json({ a: 1 }),
      'https://api.example.com/b': () => Response.json({ b: 2 }),
    });
    const http = createHttpClient({ fetch, sleep: () => Promise.resolve() });

    await http.getJson('https://api.example.com/a');
    await http.getJson('https://api.example.com/b');

    expect(fetch.mock.calls.map((c) => urlOf(c[0]))).toEqual([
      'https://api.example.com/robots.txt',
      'https://api.example.com/a',
      'https://api.example.com/b',
    ]);
  });

  it('treats an unreachable robots.txt as disallow-all', async () => {
    const fetch = respond({
      'https://down.example.com/robots.txt': () => new Response('', { status: 503 }),
    });
    const http = createHttpClient({ fetch, sleep: () => Promise.resolve() });
    await expect(http.getJson('https://down.example.com/a')).rejects.toThrow(/robots/);
  });

  it('spaces requests to one host by Crawl-delay', async () => {
    let clock = 0;
    const sleep = vi.fn((ms: number) => {
      clock += ms;
      return Promise.resolve();
    });
    const fetch = respond({
      'https://slow.example.com/robots.txt': () => new Response('User-agent: *\nCrawl-delay: 5'),
      'https://slow.example.com/a': () => Response.json({}),
      'https://slow.example.com/b': () => Response.json({}),
    });
    const http = createHttpClient({ fetch, sleep, now: () => clock, minIntervalMs: 1000 });

    await http.getJson('https://slow.example.com/a');
    await http.getJson('https://slow.example.com/b');

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 5000]);
  });

  it('queues concurrent requests to one host instead of firing them together', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const fetch = respond({
      'https://busy.example.com/a': () => Response.json({}),
      'https://busy.example.com/b': () => Response.json({}),
      'https://busy.example.com/c': () => Response.json({}),
    });
    const http = createHttpClient({
      fetch,
      sleep,
      now: () => 0,
      minIntervalMs: 1000,
      ignoreRobots: true,
    });

    await Promise.all(['a', 'b', 'c'].map((p) => http.getJson(`https://busy.example.com/${p}`)));

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });
});
