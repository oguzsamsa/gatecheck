import Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisError, claudeAnalyzer, type Analyzer } from '../../src/analysis/claude.ts';
import { checkGrounding } from '../../src/analysis/grounding.ts';
import { systemPrompt } from '../../src/analysis/prompt.ts';
import { analyzePending } from '../../src/analysis/run.ts';
import type { AnalysisResult } from '../../src/analysis/schema.ts';
import { openDb, type Db } from '../../src/db/client.ts';
import { analysis, company, eligibility, posting, postingVersion } from '../../src/db/schema.ts';
import { collectDigest } from '../../src/notify/digest.ts';
import { renderDigest } from '../../src/notify/render.ts';
import { SOURCES } from '../../src/sources/index.ts';

const PROFILE = `# Applicant
- Built the provider abstraction layer ("aiproviders") on my own: one interface for STT and TTS.
- Wrote Go and TypeScript in production for two years.
- Did NOT write the CI/CD pipelines; do not claim them.`;

const result = (over: Partial<AnalysisResult> = {}): AnalysisResult => ({
  fit: 'strong',
  fit_summary: 'Backend role centred on provider integrations.',
  location_signals: [
    { quote: 'We hire through Deel in your country', reading: 'open_to_applicant' },
  ],
  requirements: [
    {
      requirement: 'TypeScript in production',
      status: 'met',
      profile_quote: 'Wrote Go and TypeScript in production for two years.',
    },
    { requirement: 'Kubernetes', status: 'missing', profile_quote: null },
  ],
  claims_used: [
    {
      claim: 'Designed a provider abstraction',
      profile_quote: 'Built the provider abstraction layer ("aiproviders") on my own',
    },
  ],
  claims_rejected: [{ claim: 'Owned CI/CD', reason: 'Profile says not to claim it.' }],
  draft: 'Hello — I built a provider abstraction layer…',
  ...over,
});

describe('checkGrounding', () => {
  it('accepts verbatim quotes, tolerating whitespace and quote styles', () => {
    const r = result({
      claims_used: [
        { claim: 'a', profile_quote: 'Built the provider   abstraction layer (“aiproviders”)' },
      ],
    });
    expect(checkGrounding(r, PROFILE).ungrounded).toEqual([]);
  });

  it('flags paraphrases and invented claims', () => {
    const r = result({
      claims_used: [{ claim: 'Led the CI/CD migration', profile_quote: 'Led the CI/CD migration' }],
      requirements: [
        { requirement: 'Kubernetes', status: 'partial', profile_quote: 'used Kubernetes daily' },
      ],
    });
    expect(checkGrounding(r, PROFILE).ungrounded).toEqual([
      'Led the CI/CD migration',
      'requirement "Kubernetes"',
    ]);
  });
});

describe('systemPrompt', () => {
  it('names the applicant country and carries the profile after the instructions', () => {
    const prompt = systemPrompt('TR', PROFILE);
    expect(prompt).toContain('lives in Türkiye (TR)');
    expect(prompt.indexOf('<applicant_profile>')).toBeGreaterThan(prompt.indexOf('Draft:'));
    expect(prompt).toContain('Did NOT write the CI/CD pipelines');
  });
});

describe('claudeAnalyzer', () => {
  const message = (over: object) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(result()) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...over,
  });

  function client(body: object) {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json(body)));
    return { fetch, client: new Anthropic({ apiKey: 'test', fetch, maxRetries: 0 }) };
  }

  it('sends one cached, schema-constrained request with server-side fallback', async () => {
    const { fetch, client: c } = client(message({}));
    const analyzer = claudeAnalyzer({ model: 'claude-opus-5-5', effort: 'medium', client: c });

    const out = await analyzer({ system: 'SYSTEM', user: 'POSTING' });

    expect(out).toEqual({ result: result(), model: 'claude-opus-5-5' });
    const init = fetch.mock.calls[0]?.[1];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'POSTING' }],
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    expect(new Headers(init?.headers).get('anthropic-beta')).toContain(
      'server-side-fallback-2026-07-01',
    );
  });

  it('reports a refusal instead of reading content', async () => {
    const { client: c } = client(
      message({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      }),
    );
    const analyzer = claudeAnalyzer({ model: 'claude-opus-5-5', effort: 'medium', client: c });
    await expect(analyzer({ system: 's', user: 'u' })).rejects.toThrow(AnalysisError);
  });
});

describe('analyzePending', () => {
  let db: Db;
  let draftsDir: string;
  const t0 = new Date(Date.UTC(2026, 10, 19));

  function addPosting(title: string, verdict: 'open' | 'unknown' | 'closed', hash = 'h1') {
    const companyId =
      db.select().from(company).get()?.id ??
      db
        .insert(company)
        .values({ name: 'Acme', ats: 'ashby', orgSlug: 'acme', addedAt: t0 })
        .returning()
        .get().id;
    const p = db
      .insert(posting)
      .values({
        companyId,
        atsPostingId: title,
        title,
        url: `https://example.test/${title}`,
        firstSeenAt: t0,
        lastSeenAt: t0,
      })
      .returning()
      .get();
    db.insert(postingVersion)
      .values({
        postingId: p.id,
        fetchedAt: t0,
        contentHash: hash,
        payloadJson: {
          descriptionPlain: `About the ${title} role. We hire through Deel in your country.`,
        },
      })
      .run();
    db.insert(eligibility).values({ postingId: p.id, verdict, reason: 'r', evaluatedAt: t0 }).run();
    return p.id;
  }

  beforeEach(() => {
    db = openDb(':memory:');
    draftsDir = mkdtempSync(join(tmpdir(), 'gatecheck-drafts-'));
  });

  const deps = (analyzer: Analyzer) => ({
    db,
    analyzer,
    sources: SOURCES,
    applicant: 'TR' as const,
    profile: PROFILE,
    titleKeywords: [],
    draftsDir,
    now: () => t0,
  });

  it('reads open postings before unknown ones, never closed ones, within the limit', async () => {
    const unknown = addPosting('Data Engineer', 'unknown');
    const open = addPosting('Backend Engineer', 'open');
    addPosting('Sales', 'closed');
    const analyzer = vi.fn<Analyzer>(() =>
      Promise.resolve({ result: result(), model: 'claude-opus-5-5' }),
    );

    const report = await analyzePending(deps(analyzer), { limit: 1 });

    expect(report.analyzed.map((a) => a.postingId)).toEqual([open]);
    expect(report.pending).toBe(2);
    expect(analyzer.mock.calls[0]?.[0].user).toContain('We hire through Deel in your country.');
    await analyzePending(deps(analyzer), { limit: 5 });
    expect(analyzer.mock.calls.map((c) => c[0].user.includes('Data Engineer'))).toEqual([
      false,
      true,
    ]);
    expect(
      db
        .select()
        .from(analysis)
        .all()
        .map((a) => a.postingId)
        .sort(),
    ).toEqual([unknown, open].sort());
  });

  it('skips postings already analysed at their latest version, and redoes changed ones', async () => {
    const id = addPosting('Backend Engineer', 'open');
    const analyzer = vi.fn<Analyzer>(() => Promise.resolve({ result: result(), model: 'm' }));
    await analyzePending(deps(analyzer), { limit: 5 });
    await analyzePending(deps(analyzer), { limit: 5 });
    expect(analyzer).toHaveBeenCalledTimes(1);

    db.insert(postingVersion)
      .values({ postingId: id, fetchedAt: t0, contentHash: 'h2', payloadJson: {} })
      .run();
    await analyzePending(deps(analyzer), { limit: 5 });
    expect(analyzer).toHaveBeenCalledTimes(2);
  });

  it('writes a reviewable draft and flags unbacked claims', async () => {
    addPosting('Backend Engineer', 'open');
    const unbacked = result({
      claims_used: [{ claim: 'Owned CI/CD', profile_quote: 'I owned CI/CD' }],
    });
    const report = await analyzePending(
      deps(() => Promise.resolve({ result: unbacked, model: 'claude-opus-5-5' })),
      { limit: 5 },
    );

    expect(report.analyzed).toMatchObject([{ fit: 'strong', ungrounded: 1 }]);
    const row = db.select().from(analysis).get();
    const draft = readFileSync(row?.draftPath ?? '', 'utf8');
    expect(draft).toContain('⚠️ Some claims are not backed');
    expect(draft).toContain('Owned CI/CD — Profile says not to claim it.');
    expect(draft).toContain('Never sent automatically.');
  });

  it('isolates a failing posting', async () => {
    addPosting('A Engineer', 'open');
    addPosting('B Engineer', 'open');
    let calls = 0;
    const report = await analyzePending(
      deps(() =>
        calls++ === 0
          ? Promise.reject(new AnalysisError('declined (cyber)'))
          : Promise.resolve({ result: result(), model: 'm' }),
      ),
      { limit: 5 },
    );
    expect(report.failed).toMatchObject([{ error: 'declined (cyber)' }]);
    expect(report.analyzed).toHaveLength(1);
  });

  it('shows the fit in the digest', async () => {
    addPosting('Backend Engineer', 'open');
    await analyzePending(
      deps(() => Promise.resolve({ result: result(), model: 'm' })),
      { limit: 5 },
    );
    const [message] = renderDigest(collectDigest(db, 0, { titleKeywords: [] }));
    expect(message?.text).toContain(
      '🧭 fit: strong — Backend role centred on provider integrations. · draft ready',
    );
  });
});
