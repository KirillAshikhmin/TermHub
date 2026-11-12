// Запрос ленты — один разбор на оба транспорта: LAN приносит query-строку, relay —
// payload кадра, а превращаются они в опции страницы здесь. Иначе «побайтово одинаковый
// JSON» держался бы только на happy path: два разбора расходятся молча, и первым
// расходится пустое значение — `?before=` из URL §9 это «курсора нет», а не курсор «»,
// который не разберётся и ответит cursor-stale вместо хвоста.

import type { FeedResult } from './session-feed.js';
import type { DetailResult, FeedOptions } from './transcript-feed.js';
import type { UsageReader, UsageResult } from './transcript-usage.js';

/** Лента сессии: имя сессии → страница беседы её агента. */
export type FeedReader = (session: string, opts: FeedOptions) => Promise<FeedResult>;

/** Подробности действия: сессия и курсор записи → команда с выводом либо diff. */
export type DetailReader = (session: string, cursor: string) => Promise<DetailResult>;

/** Имя сессии из запроса. Не строка — пустое имя: отказ выдаст сама лента, её же
 *  словами. Гостю это имя и сверяют с расшаренной сессией — до всякого чтения. */
export function feedSession(raw: Record<string, unknown>): string {
  return typeof raw.session === 'string' ? raw.session : '';
}

/** Страница по запросу любого транспорта. Не бросает: неожиданный сбой отвечает той же
 *  причиной, какой лента отвечает на свои, — тело отказа у LAN и relay одно. */
export async function feedPage(
  read: FeedReader,
  raw: Record<string, unknown>,
  usage?: UsageReader,
  detail?: DetailReader,
): Promise<FeedResult | UsageResult | DetailResult> {
  try {
    // Расход едет тем же запросом, что и лента (ADR 0033): флаг `usage` меняет тело
    // ответа, а адресация, права гостя и очередь на транспорте остаются лентовыми.
    if (usage && usageFlag(raw.usage)) return await usage(feedSession(raw));
    // Подробности действия — тоже тем же запросом: поле `detail` с курсором записи меняет
    // тело ответа, а адресация, права гостя и очередь остаются лентовыми.
    const wanted = cursorValue(raw.detail);
    if (detail && wanted !== undefined) return await detail(feedSession(raw), wanted);
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

/** Просит ли запрос подробности действия (вывод команды, содержимое правки), а не страницу
 *  ленты — тем же правилом, каким его читает `feedPage`. По нему мост relay решает, хватает
 *  ли гостю прав: подробности требуют права `files`. */
export function wantsDetail(raw: Record<string, unknown>): boolean {
  return !usageFlag(raw.usage) && cursorValue(raw.detail) !== undefined;
}

/** Флаг расхода: `true` из кадра, `1`/`true` из query-строки; пусто — флага нет. */
function usageFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
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
