import { z } from 'zod';
import { SourceError } from './http.ts';
import type { FetchContext, FetchOutcome } from './types.ts';

/**
 * The fetch half every JSON adapter shares: conditional GET, then schema validation at the
 * boundary. A payload that doesn't match fails the source loudly instead of normalizing
 * into quietly wrong postings.
 */
export async function fetchValidated<Schema extends z.ZodType, Raw>(
  ctx: FetchContext,
  url: string,
  schema: Schema,
  postingsOf: (data: z.output<Schema>) => Raw[],
): Promise<FetchOutcome<Raw>> {
  const response = await ctx.http.getJson(url, ctx.previous);
  if (response.status === 'not_modified') return response;

  const parsed = schema.safeParse(response.body);
  if (!parsed.success) {
    throw new SourceError(`unexpected payload shape: ${z.prettifyError(parsed.error)}`, {
      url,
      httpStatus: response.httpStatus,
    });
  }
  return {
    status: 'ok',
    httpStatus: response.httpStatus,
    postings: postingsOf(parsed.data),
    validators: response.validators,
  };
}

/** Drops keys whose churn is not a content change (e.g. `updated_at` bumps). */
export function omitKeys<T extends object>(value: T, keys: readonly string[]): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as Partial<T>;
}
