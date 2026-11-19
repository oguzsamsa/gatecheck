import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/client.ts';
import {
  company,
  compensation,
  eligibility,
  notification,
  posting,
  run,
  runSource,
  type Verdict,
} from '../../src/db/schema.ts';
import { collectDigest, matchesKeywords, type DigestItem } from '../../src/notify/digest.ts';
import { renderDigest } from '../../src/notify/render.ts';
import { deliver, TelegramError } from '../../src/notify/telegram.ts';

let db: Db;
let runId: number;
let companyId: number;
const t0 = new Date(Date.UTC(2026, 10, 1));
const profile = { titleKeywords: [] as string[] };

function addPosting(title: string, verdict: Verdict, opts: { closed?: boolean } = {}): number {
  const p = db
    .insert(posting)
    .values({
      companyId,
      atsPostingId: title,
      title,
      url: `https://example.test/${encodeURIComponent(title)}`,
      firstSeenAt: t0,
      lastSeenAt: t0,
      closedAt: opts.closed ? t0 : null,
    })
    .returning()
    .get();
  db.insert(eligibility)
    .values({ postingId: p.id, verdict, reason: `reason for ${title}`, evaluatedAt: t0 })
    .run();
  return p.id;
}

beforeEach(() => {
  db = openDb(':memory:');
  companyId = db
    .insert(company)
    .values({ name: 'Acme', ats: 'ashby', orgSlug: 'acme', addedAt: t0 })
    .returning()
    .get().id;
  runId = db.insert(run).values({ startedAt: t0, status: 'partial' }).returning().get().id;
});

describe('collectDigest', () => {
  it('collects open and unknown postings not yet notified', () => {
    const open = addPosting('Backend Engineer', 'open');
    const unknown = addPosting('Data Engineer', 'unknown');
    addPosting('Account Executive', 'closed');
    addPosting('Old Engineer', 'open', { closed: true });
    const sent = addPosting('Sent Engineer', 'open');
    db.insert(notification).values({ postingId: sent, channel: 'telegram', sentAt: t0 }).run();

    const digest = collectDigest(db, runId, profile);

    expect(digest.open.map((i) => i.postingId)).toEqual([open]);
    expect(digest.unknown.map((i) => i.postingId)).toEqual([unknown]);
  });

  it('narrows to title keywords when the profile sets them', () => {
    addPosting('Senior Backend Engineer', 'open');
    addPosting('HR Operations Specialist', 'open');
    const digest = collectDigest(db, runId, { titleKeywords: ['engineer'] });
    expect(digest.open.map((i) => i.title)).toEqual(['Senior Backend Engineer']);
  });

  it('formats salary and flags bands below a comparable floor only', () => {
    const low = addPosting('Low', 'open');
    const otherCurrency = addPosting('Other', 'open');
    db.insert(compensation)
      .values([
        { postingId: low, min: 40_000, max: 50_000, currency: 'EUR', period: 'year', source: 't' },
        {
          postingId: otherCurrency,
          min: 10,
          max: 20,
          currency: 'USD',
          period: 'year',
          source: 't',
        },
      ])
      .run();
    const floor = { amount: 60_000, currency: 'EUR', period: 'year' as const };

    const digest = collectDigest(db, runId, { titleKeywords: [], salaryFloor: floor });

    expect(digest.open).toMatchObject([
      { title: 'Low', salary: 'EUR 40K–50K / year', belowFloor: true },
      { title: 'Other', salary: 'USD 10–20 / year', belowFloor: false },
    ]);
  });

  it("lists this run's failing sources", () => {
    db.insert(runSource)
      .values({
        runId,
        companyId,
        status: 'error',
        httpStatus: 404,
        error: 'HTTP 404',
        startedAt: t0,
        durationMs: 1,
      })
      .run();
    expect(collectDigest(db, runId, profile).errors).toEqual([
      { company: 'Acme', source: 'ashby/acme', error: 'HTTP 404' },
    ]);
  });
});

describe('matchesKeywords', () => {
  it('matches case-insensitively and passes everything without keywords', () => {
    expect(matchesKeywords('Senior ENGINEER', ['engineer'])).toBe(true);
    expect(matchesKeywords('Designer', ['engineer', 'developer'])).toBe(false);
    expect(matchesKeywords('Designer', [])).toBe(true);
  });
});

const item = (postingId: number, over: Partial<DigestItem> = {}): DigestItem => ({
  postingId,
  company: 'Acme',
  title: `Engineer ${postingId}`,
  url: `https://example.test/${postingId}`,
  reason: 'Türkiye listed — remote',
  salary: null,
  belowFloor: false,
  ...over,
});

describe('renderDigest', () => {
  it('says nothing when there is nothing new', () => {
    expect(renderDigest({ open: [], unknown: [], changes: [], errors: [] })).toEqual([]);
  });

  it('renders sections, escapes HTML and tracks the postings it carries', () => {
    const [message, ...rest] = renderDigest({
      open: [item(1, { title: 'C++ <Engine> & Tools' })],
      unknown: [item(2, { company: 'Globex', reason: 'EUROPE may or may not include Türkiye' })],
      changes: [],
      errors: [{ company: 'Initech', source: 'ashby/initech', error: 'HTTP 404' }],
    });

    expect(rest).toEqual([]);
    expect(message?.postingIds).toEqual([1, 2]);
    expect(message?.text).toMatchInlineSnapshot(`
      "<b>gatecheck</b> · 1 open · 1 to check · 1 source error

      <b>Open to you</b>
      <u>Acme</u>
      • <a href="https://example.test/1">C++ &lt;Engine&gt; &amp; Tools</a>
         <i>Türkiye listed — remote</i>

      <b>Worth a look — eligibility unclear</b>
      <u>Globex</u>
      • <a href="https://example.test/2">Engineer 2</a>
         <i>EUROPE may or may not include Türkiye</i>

      <b>Sources with errors</b>
      • Initech (ashby/initech): HTTP 404"
    `);
  });

  it('splits long digests between postings, never inside one', () => {
    const open = Array.from({ length: 60 }, (_, i) => item(i + 1));
    const messages = renderDigest({ open, unknown: [], changes: [], errors: [] }, 500);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((m) => m.text.length <= 500)).toBe(true);
    expect(messages.flatMap((m) => m.postingIds)).toEqual(open.map((i) => i.postingId));
    for (const m of messages) {
      for (const id of m.postingIds) expect(m.text).toContain(`Engineer ${id}<`);
    }
  });
});

describe('deliver', () => {
  const target = { botToken: 'TOKEN', chatId: '42' };

  it('posts HTML to the bot API and marks delivered postings as notified', async () => {
    const id = addPosting('Engineer', 'open');
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('{"ok":true}')),
    );

    await deliver(db, target, [{ text: 'hello', postingIds: [id], changeIds: [] }], t0, fetch);

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(init?.body as string)).toMatchObject({
      chat_id: '42',
      text: 'hello',
      parse_mode: 'HTML',
    });
    expect(db.select().from(notification).all()).toMatchObject([{ postingId: id }]);
    expect(collectDigest(db, runId, profile).open).toEqual([]);
  });

  it('keeps what was delivered and leaves the rest for the next run on failure', async () => {
    const first = addPosting('First', 'open');
    const second = addPosting('Second', 'open');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{"ok":true}'))
      .mockResolvedValueOnce(
        new Response('{"ok":false,"description":"Bad Request: chat not found"}', { status: 400 }),
      );

    const error = await deliver(
      db,
      target,
      [
        { text: 'a', postingIds: [first], changeIds: [] },
        { text: 'b', postingIds: [second], changeIds: [] },
      ],
      t0,
      fetch,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TelegramError);
    expect(String(error)).toContain('chat not found');
    expect(String(error)).not.toContain('TOKEN');
    expect(
      db
        .select()
        .from(notification)
        .all()
        .map((n) => n.postingId),
    ).toEqual([first]);
  });
});
