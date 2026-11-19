/**
 * The one place gatecheck calls a model: a single structured-output request per posting.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AnalysisResult } from './schema.ts';

export interface AnalyzerRequest {
  system: string;
  user: string;
}

export interface AnalyzerResponse {
  result: AnalysisResult;
  /** The model that produced the answer (differs from the requested one after a fallback). */
  model: string;
}

export type Analyzer = (request: AnalyzerRequest) => Promise<AnalyzerResponse>;

export class AnalysisError extends Error {
  override name = 'AnalysisError';
}

export interface ClaudeAnalyzerOptions {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  client?: Anthropic;
}

export function claudeAnalyzer({
  model,
  effort,
  client = new Anthropic(),
}: ClaudeAnalyzerOptions): Analyzer {
  return async ({ system, user }) => {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      // If a safety classifier declines, the API retries on Anthropic's recommended model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // The instructions and profile are identical for every posting: cache them.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: { effort, format: betaZodOutputFormat(AnalysisResult) },
    });

    if (response.stop_reason === 'refusal') {
      throw new AnalysisError(`declined (${response.stop_details?.category ?? 'no category'})`);
    }
    if (response.stop_reason === 'max_tokens') throw new AnalysisError('answer was cut off');
    if (!response.parsed_output) throw new AnalysisError('answer did not match the schema');
    return { result: response.parsed_output, model: response.model };
  };
}
