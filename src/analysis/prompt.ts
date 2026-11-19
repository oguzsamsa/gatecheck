import { countryName, type CountryCode } from '../geo/countries.ts';

/**
 * The system prompt: stable instructions first, then the applicant's profile, so the whole
 * block is one cacheable prefix shared by every posting in a run.
 */
export function systemPrompt(applicant: CountryCode, profile: string): string {
  return `You help one job seeker decide which postings are worth applying to, and draft a first note for those that are.

The applicant lives in ${countryName(applicant)} (${applicant}). A deterministic filter has already read the posting's structured location data; you see postings it judged open or unclear. Your job is the part structure can't answer: what the posting text says.

Work from two sources only: the posting, and the applicant profile below. The profile is the complete record of what the applicant can claim. It may also say what the applicant must not claim (work done by others, skills only touched lightly); treat that as binding.

- Location: quote any posting text about where applicants may live or be employed. Phrases like hiring through an employer of record (Deel, Remote.com) in the applicant's country of residence, or pay "reflecting market standards in your region", mean the role is open across countries; "must be based in", a list of countries, or a time-zone overlap the applicant can't meet restricts it.
- Requirements: list the posting's real requirements and match each against the profile, quoting the profile text that supports it. Missing is a fine answer.
- Claims: every statement the draft makes about the applicant needs a verbatim profile quote. If a claim would strengthen the note but the profile doesn't support it, or the profile excludes it, put it in claims_rejected and leave it out of the draft.
- Draft: 120-200 words, plain and specific, in English unless the posting is written in another language. No flattery, no invented enthusiasm, nothing the profile can't back. Years-of-experience requirements are context, not a reason to discourage applying.

Quotes must be copied exactly, character for character, so they can be checked mechanically.

<applicant_profile>
${profile.trim()}
</applicant_profile>`;
}

export interface PostingForAnalysis {
  company: string;
  title: string;
  url: string;
  verdict: string;
  verdictReason: string;
  locations: string[];
  text: string;
}

export function userPrompt(p: PostingForAnalysis): string {
  return `<posting>
Company: ${p.company}
Title: ${p.title}
URL: ${p.url}
Structured locations: ${p.locations.join('; ') || 'none'}
Deterministic verdict: ${p.verdict} (${p.verdictReason})

${p.text.trim() || '(The posting has no description text.)'}
</posting>`;
}
