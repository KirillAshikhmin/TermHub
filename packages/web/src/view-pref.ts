// Вид сессии — чат или терминал. Выбор человека помнится по сессии на устройстве
// (localStorage: через relay у агента нет места для привычек устройства); пока выбора
// нет, решает умолчание — чат там, где агент опознан и чат возможен.

import type { SessionInfo } from '@termhub/protocol/frames';

import { sessionAgent } from './session-status';

export type SessionView = 'chat' | 'term';

const KEY = 'termhub.sessionView';
/** Карта растёт по сессиям и сама не чистится — потолок, чтобы не копить мёртвые имена. */
const MAX_ENTRIES = 200;

function readMap(): Record<string, SessionView> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, SessionView> = {};
    for (const [name, view] of Object.entries(raw)) if (view === 'chat' || view === 'term') out[name] = view;
    return out;
  } catch {
    return {};
  }
}

/** Выбор человека для сессии; null — не выбирал. */
export function sessionViewPref(session: string): SessionView | null {
  return readMap()[session] ?? null;
}

export function setSessionViewPref(session: string, view: SessionView): void {
  const map = readMap();
  delete map[session]; // свежий выбор — в конец порядка вставки
  map[session] = view;
  const names = Object.keys(map);
  for (const name of names.slice(0, Math.max(0, names.length - MAX_ENTRIES))) delete map[name];
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Персист необязателен — выбор проживёт хотя бы это открытие (держится в экране).
  }
}

/** Чат возможен: в панели Claude или Codex, и обе стороны объявили `chat`.
 *  opencode, обычная оболочка и агент старше чата — переключателя нет. */
export function chatCapable(info: { command?: string }, caps: readonly string[]): boolean {
  const agent = sessionAgent(info.command ?? '');
  return (agent === 'claude' || agent === 'codex') && caps.includes('chat');
}

/** Вид по умолчанию: чат, если агент опознан, иначе терминал. */
export function defaultView(info: { command?: string }, caps: readonly string[]): SessionView {
  return chatCapable(info, caps) ? 'chat' : 'term';
}

/** Вид, в котором сессию открывают: выбор человека, а без него — умолчание. Чат без
 *  возможности не навязывается даже по старому выбору. */
export function effectiveView(session: string, info: { command?: string }, caps: readonly string[]): SessionView {
  if (!chatCapable(info, caps)) return 'term';
  return sessionViewPref(session) ?? 'chat';
}

// ── Какая сессия что запустила ──────────────────────────────────────────────
// Полоса разделов у каждого экрана сессии своя, и каждая спрашивает «что в панели»:
// общий короткий кэш не даёт пяти экранам гонять список сессий пять раз.

interface ListLike {
  list(): Promise<SessionInfo[]>;
}

const INFO_TTL_MS = 4000;
const listCache = new WeakMap<object, { at: number; req: Promise<SessionInfo[] | null> }>();

/** Сведения о сессии (команда панели и пр.); null — не удалось спросить или сессии нет. */
export function sessionInfo(transport: ListLike, session: string): Promise<SessionInfo | null> {
  const cached = listCache.get(transport);
  let req: Promise<SessionInfo[] | null>;
  if (cached && Date.now() - cached.at < INFO_TTL_MS) req = cached.req;
  else {
    req = Promise.resolve()
      .then(() => transport.list())
      .catch(() => null);
    const entry = { at: Date.now(), req };
    listCache.set(transport, entry);
    // Неудачу не держим: следующий экран спросит заново.
    void req.then((r) => {
      if (r === null && listCache.get(transport) === entry) listCache.delete(transport);
    });
  }
  return req.then((all) => all?.find((s) => s.name === session) ?? null);
}

/** Какой экран ленты монтировать: чат или прежнюю ленту. Чат — где агент опознан и чат
 *  возможен; сессия, в которой агента уже нет, но человек выбирал чат, тоже открывается
 *  чатом — он скажет «агент не запущен» и даст дорогу в терминал, а не тупик ленты. */
export function wantsChat(session: string, info: { command?: string } | null, caps: readonly string[]): boolean {
  if (!caps.includes('chat')) return false;
  const agent = sessionAgent(info?.command ?? '');
  if (agent === 'opencode') return false;
  if (agent === 'claude' || agent === 'codex') return true;
  return sessionViewPref(session) === 'chat';
}
