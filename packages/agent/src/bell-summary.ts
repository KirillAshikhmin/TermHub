// Что сказать в уведомлении о звонке сессии: что это за беседа, спросил ли агент что-то и
// чем закончил. Берётся там же, где берёт чат: экран панели (вопрос) и транскрипт
// (последний ответ). Чистый модуль поверх двух читателей — подменяются в тестах.

import type { LiveResult } from '@termhub/protocol/chat';

import { sessionLive } from './agent-live.js';
import { sessionFeed } from './session-feed.js';
import type { FeedResult } from './session-feed.js';

export interface BellSummary {
  /** Агент ждёт ответа на вопрос или разрешение; иначе он закончил ход. */
  kind: 'question' | 'done';
  /** Название агента («Claude», «Codex»). */
  agent?: string;
  /** Текст вопроса либо последний ответ агента, одной строкой. */
  text?: string;
  /** Подписи вариантов вопроса. */
  options?: string[];
}

export interface BellSummarySources {
  socketName?: string;
  live(session: string): Promise<LiveResult>;
  feed(session: string): Promise<FeedResult>;
}

/** Сколько знаков текста едет в уведомлении: пуш ограничен четырьмя килобайтами. */
const TEXT_LIMIT = 300;
const OPTIONS_LIMIT = 4;
const OPTION_LIMIT = 60;
/** Сколько записей с хвоста беседы просматривается в поисках последнего ответа. */
const TAIL = 30;
/** Дольше этого уведомление не ждёт: уйдёт без подробностей. */
const SUMMARY_TIMEOUT_MS = 4000;

/** Сводка для уведомления. Не бросает; не удалось — `null`, уведомление уйдёт как раньше. */
export async function bellSummary(session: string, sources: Partial<BellSummarySources> = {}): Promise<BellSummary | null> {
  const socketName = sources.socketName;
  const live = sources.live ?? ((name: string) => sessionLive(name, { socketName }));
  const feed = sources.feed ?? ((name: string) => sessionFeed(name, { limit: TAIL }, { socketName }));
  const work = async (): Promise<BellSummary | null> => {
    const state = await live(session);
    if (!state.ok) return null;
    const agent = state.agent === 'claude' ? 'Claude' : state.agent === 'codex' ? 'Codex' : undefined;
    const base = agent ? { agent } : {};
    const screen = state.screen;
    if ((screen.kind === 'question' || screen.kind === 'permission') && screen.question) {
      const options = screen.question.options
        .filter((option) => !option.free)
        .slice(0, OPTIONS_LIMIT)
        .map((option) => clip(option.label, OPTION_LIMIT));
      return {
        kind: 'question',
        ...base,
        text: clip(screen.question.title, TEXT_LIMIT),
        ...(options.length > 0 ? { options } : {}),
      };
    }
    const page = await feed(session);
    const entries = page.ok ? page.entries : [];
    // Вопрос ждёт в очереди агента: его текст — в последней записи вопроса без ответа.
    if (screen.pending === true) {
      const asked = [...entries].reverse().find((entry) => entry.questions?.some((q) => q.answer === undefined));
      const question = asked?.questions?.find((q) => q.answer === undefined);
      return {
        kind: 'question',
        ...base,
        ...(question ? { text: clip(question.text, TEXT_LIMIT) } : {}),
        ...(question?.options?.length
          ? { options: question.options.slice(0, OPTIONS_LIMIT).map((o) => clip(o.label, OPTION_LIMIT)) }
          : {}),
      };
    }
    const last = [...entries].reverse().find((entry) => entry.kind === 'agent' && entry.text.trim() !== '');
    return { kind: 'done', ...base, ...(last ? { text: clip(last.text, TEXT_LIMIT) } : {}) };
  };
  try {
    return await Promise.race([
      work(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS).unref()),
    ]);
  } catch {
    return null;
  }
}

/** Одна строка без разметки markdown, не длиннее `limit` знаков. */
function clip(text: string, limit: number): string {
  const flat = text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/[`*_#>]+/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
  const chars = [...flat];
  return chars.length <= limit ? flat : `${chars.slice(0, limit - 1).join('').trimEnd()}…`;
}
