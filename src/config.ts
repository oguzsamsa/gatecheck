/**
 * Personal configuration. The real file (config.json) is gitignored; config.example.json
 * documents the shape. Secrets can also come from the environment so the file never has to
 * hold them.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ATS_VALUES } from './domain/types.ts';
import { COUNTRY_NAMES } from './geo/countries.data.ts';
import type { CountryCode } from './geo/countries.ts';

const CountryCodeSchema = z
  .string()
  .refine((c): c is CountryCode => c in COUNTRY_NAMES, 'not an ISO 3166-1 alpha-2 code');

const WatchlistEntry = z.object({
  name: z.string().min(1),
  ats: z.enum(ATS_VALUES),
  /** The board identifier the ATS API takes. */
  org: z.string().min(1),
  careersUrl: z.url().optional(),
});
export type WatchlistEntry = z.infer<typeof WatchlistEntry>;

const ConfigSchema = z.object({
  applicant: z.object({
    /** Where the applicant lives and can legally work from. */
    country: CountryCodeSchema,
  }),
  /** Relative paths resolve against the working directory. */
  database: z.string().default('data/gatecheck.sqlite'),
  userAgent: z.string().optional(),
  watchlist: z.array(WatchlistEntry).default([]),
  profile: z
    .object({
      /**
       * Case-insensitive words; when set, only postings whose title contains one of them
       * are announced. Everything is still stored and evaluated.
       */
      titleKeywords: z.array(z.string().min(1)).default([]),
      /** Labelled in the digest when a posting's band tops out below it. Never a filter. */
      salaryFloor: z
        .object({
          amount: z.number().positive(),
          currency: z.string().length(3),
          period: z.enum(['year', 'month', 'hour']),
        })
        .optional(),
    })
    .default({ titleKeywords: [] }),
  /** Phase 3: model-assisted reading of postings that passed the filter. Off unless set. */
  analysis: z
    .object({
      /** Markdown/text describing the applicant — gitignored, never committed. */
      profileFile: z.string().min(1),
      model: z.string().default('claude-opus-5-5'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
      /** Most postings analysed per run; each one is a paid API call. */
      maxPerRun: z.number().int().min(1).default(5),
      /** Also analyse during `pnpm poll` (before the digest), not only via `pnpm analyze`. */
      onPoll: z.boolean().default(false),
      draftsDir: z.string().default('data/drafts'),
    })
    .optional(),
  telegram: z
    .object({
      botToken: z.string().min(1),
      chatId: z.union([z.string(), z.number()]).transform(String),
    })
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function parseConfig(input: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError(`invalid config:\n${z.prettifyError(parsed.error)}`);
  const config = parsed.data;

  const token = env.GATECHECK_TELEGRAM_BOT_TOKEN;
  const chatId = env.GATECHECK_TELEGRAM_CHAT_ID;
  if (token && chatId) config.telegram = { botToken: token, chatId };

  const keys = config.watchlist.map((w) => `${w.ats}:${w.org}`);
  const duplicate = keys.find((k, i) => keys.indexOf(k) !== i);
  if (duplicate) throw new ConfigError(`watchlist lists ${duplicate} twice`);
  return config;
}

export function loadConfig(path = process.env.GATECHECK_CONFIG ?? 'config.json'): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`no config at ${path} — copy config.example.json to config.json`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`${path} is not valid JSON`, { cause });
  }
  return parseConfig(json);
}
