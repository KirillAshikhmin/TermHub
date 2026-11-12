// Запросы чата — один разбор на оба транспорта (образец — feed-request.ts): LAN приносит
// query-строку или тело POST, relay — payload кадра, а превращаются они в вызов здесь.
// Тело ответа у LAN и relay поэтому одно — и на отказе, и на сорванном вызове.

import type { ActResult, ChatAction, LiveResult } from '@termhub/protocol/chat';

/** Экран агента в сессии. */
export type LiveReader = (session: string) => Promise<LiveResult>;
/** Действие чата в сессии. */
export type ActRunner = (session: string, action: ChatAction) => Promise<ActResult>;

/** Имя сессии из запроса. Не строка — пустое имя: отказ выдаст сам вызов. Гостю это имя
 *  сверяют с расшаренной сессией — до всякого чтения экрана. */
export function chatSession(raw: Record<string, unknown>): string {
  return typeof raw.session === 'string' ? raw.session : '';
}

/** Состояние экрана по запросу любого транспорта. Не бросает. */
export async function livePage(read: LiveReader, raw: Record<string, unknown>): Promise<LiveResult> {
  try {
    return await read(chatSession(raw));
  } catch (err) {
    return { ok: false, reason: 'lookup-failed', detail: (err as Error).message };
  }
}

/** Действие по запросу любого транспорта. Не бросает; тело, в котором действия не
 *  разобрать, до панели не доходит вовсе. */
export async function actPage(act: ActRunner, raw: Record<string, unknown>): Promise<ActResult> {
  const action = parseAction(raw.action);
  if (!action) return { ok: false, reason: 'unsupported', detail: 'not a chat action' };
  try {
    return await act(chatSession(raw), action);
  } catch (err) {
    return { ok: false, reason: 'lookup-failed', detail: (err as Error).message };
  }
}

/** Действие из чужого JSON: только известные виды и только поля своего вида, каждое —
 *  своего типа. Лишние поля отбрасываются, битое действие — `null`. */
export function parseAction(value: unknown): ChatAction | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  switch (raw.kind) {
    case 'prompt':
      if (typeof raw.text !== 'string') return null;
      return { kind: 'prompt', text: raw.text, ...(raw.over === true ? { over: true } : {}) };
    case 'answer': {
      if (typeof raw.stamp !== 'string') return null;
      if (raw.option !== undefined && typeof raw.option !== 'string') return null;
      if (raw.text !== undefined && typeof raw.text !== 'string') return null;
      if (raw.options !== undefined && !(Array.isArray(raw.options) && raw.options.every((k) => typeof k === 'string'))) {
        return null;
      }
      return {
        kind: 'answer',
        stamp: raw.stamp,
        ...(raw.option === undefined ? {} : { option: raw.option }),
        ...(raw.options === undefined ? {} : { options: raw.options as string[] }),
        ...(raw.text === undefined ? {} : { text: raw.text }),
      };
    }
    case 'mode':
      return typeof raw.to === 'string' ? { kind: 'mode', to: raw.to } : null;
    case 'model':
      // Модель выбирают в меню самого агента: имя здесь ничего не решает.
      return { kind: 'model', to: typeof raw.to === 'string' ? raw.to : '' };
    case 'interrupt':
    case 'compact':
    case 'take-input':
      return { kind: raw.kind };
    default:
      return null;
  }
}
