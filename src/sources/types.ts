import type { Ats, NormalizedPosting } from '../domain/types.ts';
import type { HttpClient, Validators } from './http.ts';

export interface FetchContext {
  http: HttpClient;
  /** Validators from this source's last successful fetch, for a conditional request. */
  previous?: Validators;
}

export type FetchOutcome<Raw> =
  | { status: 'ok'; httpStatus: number; postings: Raw[]; validators: Validators }
  /** Nothing changed since `previous`: every posting seen last time is still open. */
  | { status: 'not_modified'; httpStatus: 304; validators: Validators };

/**
 * One ATS. Adding an ATS means implementing this and registering it — nothing else in the
 * pipeline knows ATS-specific shapes.
 *
 * `fetch` validates the payload at the boundary and throws `SourceError` on anything it
 * can't trust (HTTP failure, unexpected shape), so a broken or changed API fails that one
 * source loudly instead of producing quietly wrong postings. `normalize` is pure.
 */
export interface BoardSource<Raw = unknown> {
  readonly ats: Ats;
  fetch(org: string, ctx: FetchContext): Promise<FetchOutcome<Raw>>;
  normalize(raw: Raw): NormalizedPosting;
}
