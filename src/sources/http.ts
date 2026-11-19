/**
 * The only way adapters talk to the network. Centralising it keeps polling polite by
 * construction — no adapter can forget any of it:
 *
 * - one identifying User-Agent;
 * - robots.txt honoured per host (read once per client, i.e. once per run);
 * - requests to one host spaced out (at least `minIntervalMs`, or the host's Crawl-delay);
 * - conditional requests from the previous run's validators;
 * - bounded retries with jittered backoff, honouring Retry-After;
 * - a hard timeout.
 */
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type Robots } from './robots.ts';

export const DEFAULT_USER_AGENT = 'gatecheck/0.1 (+https://github.com/oguzsamsa/gatecheck)';

/** Cache validators from a previous successful response, replayed as conditional headers. */
export interface Validators {
  etag: string | null;
  lastModified: string | null;
}

export type HttpResponse<Body> =
  | { status: 'ok'; httpStatus: number; body: Body; validators: Validators }
  | { status: 'not_modified'; httpStatus: 304; validators: Validators };

export type JsonResponse = HttpResponse<unknown>;
export type TextResponse = HttpResponse<string>;

export interface HttpClient {
  getJson(url: string, previous?: Validators): Promise<JsonResponse>;
  getText(url: string, previous?: Validators): Promise<TextResponse>;
}

/** A source-level failure. The runner records it per source and moves on. */
export class SourceError extends Error {
  readonly url: string;
  readonly httpStatus: number | null;

  constructor(message: string, opts: { url: string; httpStatus?: number | null; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = 'SourceError';
    this.url = opts.url;
    this.httpStatus = opts.httpStatus ?? null;
  }
}

export interface HttpClientOptions {
  userAgent?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Upper bound for a server-requested Retry-After; beyond it we give up for this run. */
  maxRetryAfterMs?: number;
  /** Minimum spacing between requests to the same host. */
  minIntervalMs?: number;
  /** Skip robots.txt — only for tests that stub the network. */
  ignoreRobots?: boolean;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const {
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = 20_000,
    maxAttempts = 3,
    baseDelayMs = 1_000,
    maxRetryAfterMs = 60_000,
    minIntervalMs = 1_000,
    ignoreRobots = false,
    fetch = globalThis.fetch,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = options;

  const robotsByOrigin = new Map<string, Promise<Robots>>();
  const lastRequestByHost = new Map<string, number>();

  async function paced(url: URL, robots: Robots) {
    const interval = Math.max(minIntervalMs, (robots.crawlDelay ?? 0) * 1000);
    const last = lastRequestByHost.get(url.host);
    if (last !== undefined) {
      const wait = last + interval - now();
      if (wait > 0) await sleep(wait);
    }
    lastRequestByHost.set(url.host, now());
  }

  function robotsFor(url: URL): Promise<Robots> {
    if (ignoreRobots) return Promise.resolve(ALLOW_ALL);
    let robots = robotsByOrigin.get(url.origin);
    if (!robots) {
      robots = (async () => {
        try {
          const response = await fetch(`${url.origin}/robots.txt`, {
            headers: { 'user-agent': userAgent },
            signal: AbortSignal.timeout(timeoutMs),
          });
          lastRequestByHost.set(url.host, now());
          if (response.ok) return parseRobots(await response.text());
          await response.body?.cancel();
          return response.status >= 500 ? DISALLOW_ALL : ALLOW_ALL;
        } catch {
          return DISALLOW_ALL;
        }
      })();
      robotsByOrigin.set(url.origin, robots);
    }
    return robots;
  }

  async function request(
    url: string,
    accept: string,
    previous: Validators | undefined,
  ): Promise<{ status: 'ok'; response: Response } | { status: 'not_modified' }> {
    const target = new URL(url);
    const robots = await robotsFor(target);
    if (!robots.isAllowed(target.pathname + target.search)) {
      throw new SourceError('disallowed by robots.txt', { url });
    }

    const headers: Record<string, string> = { 'user-agent': userAgent, accept };
    if (previous?.etag) headers['if-none-match'] = previous.etag;
    if (previous?.lastModified) headers['if-modified-since'] = previous.lastModified;

    for (let attempt = 1; ; attempt++) {
      await paced(target, robots);
      let response: Response;
      try {
        response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch (cause) {
        if (attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new SourceError(`request failed after ${attempt} attempts`, { url, cause });
      }

      if (response.status === 304) return { status: 'not_modified' };
      if (response.ok) return { status: 'ok', response };

      // Drain the body so the connection can be reused.
      await response.body?.cancel();

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        if (retryAfter === null || retryAfter <= maxRetryAfterMs) {
          await sleep(retryAfter ?? backoff(attempt));
          continue;
        }
      }
      throw new SourceError(`HTTP ${response.status}`, { url, httpStatus: response.status });
    }
  }

  function backoff(attempt: number): number {
    // Exponential with jitter, so retries from several sources don't line up.
    return baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);
  }

  async function get<Body>(
    url: string,
    accept: string,
    previous: Validators | undefined,
    read: (response: Response) => Promise<Body>,
  ): Promise<HttpResponse<Body>> {
    const result = await request(url, accept, previous);
    if (result.status === 'not_modified') {
      return {
        status: 'not_modified',
        httpStatus: 304,
        validators: previous ?? { etag: null, lastModified: null },
      };
    }
    const { response } = result;
    let body: Body;
    try {
      body = await read(response);
    } catch (cause) {
      throw new SourceError('unreadable response body', {
        url,
        httpStatus: response.status,
        cause,
      });
    }
    return {
      status: 'ok',
      httpStatus: response.status,
      body,
      validators: {
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      },
    };
  }

  return {
    getJson: (url, previous) =>
      get(url, 'application/json', previous, (r): Promise<unknown> => r.json()),
    getText: (url, previous) => get(url, '*/*', previous, (r) => r.text()),
  };
}

/** Retry-After is either delta-seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
