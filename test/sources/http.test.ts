import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, DEFAULT_USER_AGENT, SourceError } from '../../src/sources/http.ts';

const URL_ = 'https://example.test/board';

function fakeFetch(...responses: (Response | Error)[]) {
  const queue = [...responses];
  return vi.fn<typeof fetch>(() => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra request');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
}

const json = (body: unknown, init: { headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...init.headers },
  });

const noSleep = vi.fn(() => Promise.resolve());
/** These tests script every response, so robots.txt and pacing are switched off. */
const offline = { ignoreRobots: true, minIntervalMs: 0 };

describe('createHttpClient', () => {
  it('identifies itself and returns the body with cache validators', async () => {
    const fetch = fakeFetch(json({ jobs: [] }, { headers: { etag: 'W/"abc"' } }));
    const http = createHttpClient({ fetch, sleep: noSleep, ...offline });

    const result = await http.getJson(URL_);

    expect(result).toEqual({
      status: 'ok',
      httpStatus: 200,
      body: { jobs: [] },
      validators: { etag: 'W/"abc"', lastModified: null },
    });
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['user-agent']).toBe(DEFAULT_USER_AGENT);
    expect(headers).not.toHaveProperty('if-none-match');
  });

  it('sends a conditional request and reports not_modified on 304', async () => {
    const fetch = fakeFetch(new Response(null, { status: 304 }));
    const http = createHttpClient({ fetch, sleep: noSleep, ...offline });
    const previous = { etag: 'W/"abc"', lastModified: 'Wed, 18 Nov 2026 10:00:00 GMT' };

    const result = await http.getJson(URL_, previous);

    expect(result).toEqual({ status: 'not_modified', httpStatus: 304, validators: previous });
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['if-none-match']).toBe(previous.etag);
    expect(headers['if-modified-since']).toBe(previous.lastModified);
  });

  it('retries transient failures with backoff', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fetch = fakeFetch(
      new TypeError('fetch failed'),
      new Response(null, { status: 503 }),
      json({ ok: true }),
    );
    const http = createHttpClient({ fetch, sleep, baseDelayMs: 100, ...offline });

    await expect(http.getJson(URL_)).resolves.toMatchObject({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const [first, second] = sleep.mock.calls.map((c: unknown[]) => c[0] as number);
    expect(first).toBeGreaterThanOrEqual(50);
    expect(second).toBeGreaterThanOrEqual(100);
  });

  it('honours Retry-After', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fetch = fakeFetch(
      new Response(null, { status: 429, headers: { 'retry-after': '7' } }),
      json({}),
    );
    await createHttpClient({ fetch, sleep, ...offline }).getJson(URL_);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it('gives up instead of waiting for an excessive Retry-After', async () => {
    const fetch = fakeFetch(
      new Response(null, { status: 429, headers: { 'retry-after': '3600' } }),
    );
    await expect(
      createHttpClient({ fetch, sleep: noSleep, ...offline }).getJson(URL_),
    ).rejects.toMatchObject({
      httpStatus: 429,
    });
  });

  it('does not retry client errors', async () => {
    const fetch = fakeFetch(new Response('not found', { status: 404 }));
    const error = await createHttpClient({ fetch, sleep: noSleep, ...offline })
      .getJson(URL_)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ httpStatus: 404, url: URL_ });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails with the cause after the last attempt', async () => {
    const fetch = fakeFetch(...Array.from({ length: 3 }, () => new TypeError('fetch failed')));
    const error = await createHttpClient({ fetch, sleep: noSleep, ...offline })
      .getJson(URL_)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ httpStatus: null, cause: new TypeError('fetch failed') });
  });
});
