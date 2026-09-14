// Запрос ленты — один разбор на оба транспорта: LAN приносит query-строку, relay —
// payload кадра, а превращаются они в опции страницы здесь. Иначе «побайтово одинаковый
// JSON» держался бы только на happy path: два разбора расходятся молча, и первым
// расходится пустое значение — `?before=` из URL §9 это «курсора нет», а не курсор «»,
// который не разберётся и ответит cursor-stale вместо хвоста.

import type { FeedResult } from './session-feed.js';
import type { FeedOptions } from './transcript-feed.js';

/** Лента сессии: имя сессии → страница беседы её агента. */
export type FeedReader = (session: string, opts: FeedOptions) => Promise<FeedResult>;

/** Имя сессии из запроса. Не строка — пустое имя: отказ выдаст сама лента, её же
 *  словами. Гостю это имя и сверяют с расшаренной сессией — до всякого чтения. */
export function feedSession(raw: Record<string, unknown>): string {
  return typeof raw.session === 'string' ? raw.session : '';
}

/** Страница по запросу любого транспорта. Не бросает: неожиданный сбой отвечает той же
 *  причиной, какой лента отвечает на свои, — тело отказа у LAN и relay одно. */
export async function feedPage(read: FeedReader, raw: Record<string, unknown>): Promise<FeedResult> {
  try {
    return await read(feedSession(raw), {
      limit: limitValue(raw.limit),
      before: cursorValue(raw.before),
      after: cursorValue(raw.after),
      around: cursorValue(raw.around),
    });
  } catch (err) {
    return { ok: false, reason: 'lookup-failed', detail: (err as Error).message };
  }
}

/** Курсор: пустое значение равносильно отсутствующему. */
function cursorValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Лимит: число кадра или число из query-строки; пусто и мусор — предел по умолчанию. */
function limitValue(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
