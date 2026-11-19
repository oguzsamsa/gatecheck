import { z } from 'zod';

/**
 * What the model returns for one posting. Every claim the draft makes about the applicant
 * must cite a verbatim quote from the profile; claims it considered and could not support
 * are listed instead of used — that list is the self-filter, and the quotes are what makes
 * it checkable (see grounding.ts).
 */
export const AnalysisResult = z.object({
  fit: z.enum(['strong', 'possible', 'weak']),
  fit_summary: z.string().describe('One or two sentences: why this fit rating.'),
  location_signals: z
    .array(
      z.object({
        quote: z.string().describe('Verbatim text from the posting.'),
        reading: z.enum(['open_to_applicant', 'restricts_applicant', 'unclear']),
      }),
    )
    .describe('Text in the posting that says who may apply from where. Empty if none.'),
  requirements: z.array(
    z.object({
      requirement: z.string(),
      status: z.enum(['met', 'partial', 'missing']),
      profile_quote: z
        .string()
        .nullable()
        .describe('Verbatim profile text supporting met/partial; null when missing.'),
    }),
  ),
  claims_used: z.array(
    z.object({
      claim: z.string().describe('A statement about the applicant that the draft makes.'),
      profile_quote: z.string().describe('Verbatim profile text that supports it.'),
    }),
  ),
  claims_rejected: z.array(
    z.object({
      claim: z.string().describe('A tempting statement the draft does NOT make.'),
      reason: z.string().describe('Why the profile does not support it.'),
    }),
  ),
  draft: z.string().describe('A short application note the applicant can edit and send.'),
});
export type AnalysisResult = z.infer<typeof AnalysisResult>;
