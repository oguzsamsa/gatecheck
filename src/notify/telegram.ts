import type { Db } from '../db/client.ts';
import { notification } from '../db/schema.ts';
import type { Message } from './render.ts';

export interface TelegramTarget {
  botToken: string;
  chatId: string;
}

export class TelegramError extends Error {
  override name = 'TelegramError';
}

export async function sendTelegram(
  target: TelegramTarget,
  text: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: target.chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    // Telegram explains failures in `description`; never echo the URL, it holds the token.
    const body = (await response.json().catch(() => null)) as { description?: string } | null;
    throw new TelegramError(
      `Telegram ${response.status}: ${body?.description ?? 'request failed'}`,
    );
  }
}

/**
 * Sends messages in order and records each one's postings as notified right after it is
 * delivered. A failure stops the batch: what was delivered stays recorded, the rest is
 * retried on the next run.
 */
export async function deliver(
  db: Db,
  target: TelegramTarget,
  messages: Message[],
  now: Date,
  fetch?: typeof globalThis.fetch,
): Promise<number> {
  let delivered = 0;
  for (const message of messages) {
    await sendTelegram(target, message.text, fetch);
    if (message.postingIds.length > 0) {
      db.insert(notification)
        .values(
          message.postingIds.map((postingId) => ({
            postingId,
            channel: 'telegram' as const,
            sentAt: now,
          })),
        )
        .onConflictDoNothing()
        .run();
    }
    delivered += message.postingIds.length;
  }
  return delivered;
}
