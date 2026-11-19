import type { AnalysisResult } from './schema.ts';

/**
 * The deterministic half of the self-filter: a claim counts as grounded only if its quote
 * really appears in the profile. Whitespace and quote styles are normalised; nothing else
 * is — a paraphrase is not a quote.
 */
const normalise = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export interface Grounding {
  /** Claims whose quote is not in the profile. */
  ungrounded: string[];
}

export function checkGrounding(result: AnalysisResult, profile: string): Grounding {
  const haystack = normalise(profile);
  const found = (quote: string) => quote.trim() !== '' && haystack.includes(normalise(quote));
  return {
    ungrounded: [
      ...result.claims_used.filter((c) => !found(c.profile_quote)).map((c) => c.claim),
      ...result.requirements
        .filter(
          (r) => r.status !== 'missing' && r.profile_quote !== null && !found(r.profile_quote),
        )
        .map((r) => `requirement "${r.requirement}"`),
    ],
  };
}
