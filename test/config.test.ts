import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.ts';

const example: unknown = JSON.parse(readFileSync('config.example.json', 'utf8'));
const minimal = { applicant: { country: 'TR' } };

describe('parseConfig', () => {
  it('accepts config.example.json', () => {
    expect(parseConfig(example, {})).toMatchObject({
      applicant: { country: 'TR' },
      telegram: { chatId: '123456789' },
    });
  });

  it('fills defaults', () => {
    expect(parseConfig(minimal, {})).toEqual({
      applicant: { country: 'TR' },
      database: 'data/gatecheck.sqlite',
      watchlist: [],
      profile: { titleKeywords: [] },
    });
  });

  it('rejects an unknown country code', () => {
    expect(() => parseConfig({ applicant: { country: 'TK1' } }, {})).toThrow(ConfigError);
    expect(() => parseConfig({ applicant: { country: 'UK' } }, {})).toThrow(/ISO 3166/);
  });

  it('rejects an unsupported ATS and duplicate watchlist entries', () => {
    const entry = { name: 'Acme', ats: 'ashby', org: 'acme' };
    expect(() => parseConfig({ ...minimal, watchlist: [{ ...entry, ats: 'taleo' }] }, {})).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ ...minimal, watchlist: [entry, entry] }, {})).toThrow(
      /ashby:acme twice/,
    );
  });

  it('takes Telegram credentials from the environment', () => {
    const config = parseConfig(minimal, {
      GATECHECK_TELEGRAM_BOT_TOKEN: 'secret',
      GATECHECK_TELEGRAM_CHAT_ID: '42',
    });
    expect(config.telegram).toEqual({ botToken: 'secret', chatId: '42' });
  });
});
