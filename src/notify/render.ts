import type { Digest, DigestItem } from './digest.ts';

/** Telegram rejects messages above 4096 characters. */
export const TELEGRAM_LIMIT = 4096;

export interface Message {
  text: string;
  /** Postings announced in this message — marked as notified once it is delivered. */
  postingIds: number[];
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Block {
  lines: string[];
  postingIds: number[];
}

function itemBlock(item: DigestItem): Block {
  const extras = [
    item.salary && `💰 ${escape(item.salary)}${item.belowFloor ? ' ⚠️ below your floor' : ''}`,
    `<i>${escape(item.reason)}</i>`,
  ].filter(Boolean);
  return {
    lines: [
      `• <a href="${escape(item.url)}">${escape(item.title)}</a>`,
      ...extras.map((e) => `   ${e}`),
    ],
    postingIds: [item.postingId],
  };
}

function section(title: string, items: DigestItem[]): Block[] {
  if (items.length === 0) return [];
  const blocks: Block[] = [{ lines: ['', `<b>${title}</b>`], postingIds: [] }];
  let current: string | null = null;
  for (const item of items) {
    const block = itemBlock(item);
    // The company heading travels with its first posting, so a split never orphans it.
    if (item.company !== current) {
      current = item.company;
      block.lines.unshift(`<u>${escape(current)}</u>`);
    }
    blocks.push(block);
  }
  return blocks;
}

/**
 * Renders the digest as one or more Telegram HTML messages. Splits only between blocks,
 * so a posting is never cut in half and each message knows exactly which postings it
 * carries. Returns no messages when there is nothing to say.
 */
export function renderDigest(digest: Digest, limit = TELEGRAM_LIMIT): Message[] {
  const { open, unknown, errors } = digest;
  if (open.length + unknown.length + errors.length === 0) return [];

  const summary = [
    `${open.length} open`,
    unknown.length > 0 && `${unknown.length} to check`,
    errors.length > 0 && `${errors.length} source error${errors.length > 1 ? 's' : ''}`,
  ].filter(Boolean);

  const blocks: Block[] = [
    { lines: [`<b>gatecheck</b> · ${summary.join(' · ')}`], postingIds: [] },
    ...section('Open to you', open),
    ...section('Worth a look — eligibility unclear', unknown),
  ];
  if (errors.length > 0) {
    blocks.push({ lines: ['', '<b>Sources with errors</b>'], postingIds: [] });
    for (const e of errors) {
      blocks.push({
        lines: [`• ${escape(e.company)} (${escape(e.source)}): ${escape(e.error)}`],
        postingIds: [],
      });
    }
  }

  const messages: Message[] = [];
  let lines: string[] = [];
  let ids: number[] = [];
  const flush = () => {
    if (lines.length > 0) messages.push({ text: lines.join('\n').trim(), postingIds: ids });
    lines = [];
    ids = [];
  };
  for (const block of blocks) {
    const text = block.lines.join('\n');
    if (lines.length > 0 && [...lines, text].join('\n').length > limit) flush();
    lines.push(text);
    ids.push(...block.postingIds);
  }
  flush();
  return messages;
}
