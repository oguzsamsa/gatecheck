/**
 * The only way adapters talk to the network. Centralising it keeps polling polite by
 * construction: one identifying User-Agent, conditional requests, bounded retries with
 * backoff, and a hard timeout — no adapter can forget any of them.
 */

export const DEFAULT_USER_AGENT = 'gatecheck/0.1 (+https://github.com/oguzsamsa/gatecheck)';

/** Cache validators from a previous successful response, replayed as conditional headers. */
export interface Validators {
  etag: string | null;
  lastModified: string | null;
}

export type JsonResponse =
  | { status: 'ok'; httpStatus: number; body: unknown; validators: Validators }
  | { status: 'not_modified'; httpStatus: 304; validators: Validators };

export interface HttpClient {
  getJson(url: string, previous?: Validators): Promise<JsonResponse>;
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
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const {
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = 20_000,
    maxAttempts = 3,
    baseDelayMs = 1_000,
    maxRetryAfterMs = 60_000,
    fetch = globalThis.fetch,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  async function getJson(url: string, previous?: Validators): Promise<JsonResponse> {
    const headers: Record<string, string> = {
      'user-agent': userAgent,
      accept: 'application/json',
    };
    if (previous?.etag) headers['if-none-match'] = previous.etag;
    if (previous?.lastModified) headers['if-modified-since'] = previous.lastModified;

    for (let attempt = 1; ; attempt++) {
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

      if (response.status === 304) {
        return {
          status: 'not_modified',
          httpStatus: 304,
          validators: previous ?? { etag: null, lastModified: null },
        };
      }

      if (response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch (cause) {
          throw new SourceError('response is not valid JSON', {
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

  return { getJson };
}

/** Retry-After is either delta-seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
