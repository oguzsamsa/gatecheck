/**
 * The v1 eligibility rules: deterministic, explainable, and biased against false
 * negatives — a wrongly hidden posting costs far more than one extra to glance at.
 *
 *   1. Collect the posting's location claims. If any are explicit applicant requirements,
 *      only those count: they are the strongest statement a posting makes.
 *   2. Any claim that names the applicant's country, or a region that certainly covers
 *      it → open.
 *   3. Otherwise, any claim we can't fully judge (a contested region, unresolved text,
 *      or no claims at all) → unknown. Unknown is never auto-dismissed.
 *   4. Otherwise every claim is a place that excludes the applicant → closed.
 */
import type { Verdict } from '../db/schema.ts';
import type { LocationClaim } from '../domain/types.ts';
import { countryName, type CountryCode } from '../geo/countries.ts';
import { regionCovers } from './regions.ts';

export interface Decision {
  verdict: Verdict;
  reason: string;
}

type Judgement = 'yes' | 'no' | 'contested' | 'unresolved';

function judge(claim: LocationClaim, applicant: CountryCode): Judgement {
  if (claim.countryCode) return claim.countryCode === applicant ? 'yes' : 'no';
  if (claim.region) {
    const coverage = regionCovers(claim.region, applicant);
    return coverage === 'contested' ? 'contested' : coverage;
  }
  return 'unresolved';
}

const KIND_LABEL: Record<LocationClaim['kind'], string> = {
  office: 'office',
  remote_region: 'remote',
  applicant_requirement: 'applicant requirement',
};

function place(claim: LocationClaim): string {
  return claim.countryCode ?? claim.region ?? `"${claim.raw}"`;
}

export function decide(claims: readonly LocationClaim[], applicant: CountryCode): Decision {
  const requirements = claims.filter((c) => c.kind === 'applicant_requirement');
  const considered = requirements.length > 0 ? requirements : claims;
  const name = countryName(applicant);

  if (considered.length === 0) {
    return { verdict: 'unknown', reason: 'the posting states no location' };
  }

  const judged = considered.map((claim) => ({ claim, judgement: judge(claim, applicant) }));

  const match = judged.find((j) => j.judgement === 'yes');
  if (match) {
    const { claim } = match;
    const how = claim.countryCode ? `${name} listed` : `${claim.region} covers ${name}`;
    const where = claim.city ? ` (${claim.city})` : '';
    return {
      verdict: 'open',
      reason: `${how}${where} — ${KIND_LABEL[claim.kind]}, from "${claim.raw}"`,
    };
  }

  const contested = judged.filter((j) => j.judgement === 'contested');
  const unresolved = judged.filter((j) => j.judgement === 'unresolved');
  if (contested.length > 0 || unresolved.length > 0) {
    const parts = [
      ...contested.map((j) => `${j.claim.region} may or may not include ${name}`),
      ...unresolved.map((j) => `"${j.claim.raw}" names no place we recognise`),
    ];
    return { verdict: 'unknown', reason: unique(parts).join('; ') };
  }

  const places = unique(judged.map((j) => place(j.claim)));
  const kinds = unique(judged.map((j) => KIND_LABEL[j.claim.kind]));
  return {
    verdict: 'closed',
    reason: `limited to ${places.join(', ')} (${kinds.join(', ')})`,
  };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
