// Обёртка над REST агента: cookie-сессия (same-origin), единый разбор ошибок,
// 401 на защищённых маршрутах → редирект на экран входа.

import { parseCaps } from '@termhub/protocol/capabilities';
import type { FileContent, FileEntry, SessionInfo } from '@termhub/protocol';

export interface DirGroup {
  root: string;
  dirs: string[];
}

export interface ModeInfo {
  mode: 'lan' | 'relay';
  host: string;
}

/** Пресет создаваемой сессии. «zsh» — оболочка, остальные запускают одноимённую
 *  команду поверх неё. Зеркалит SESSION_PRESETS агента (packages/agent/src/sessions.ts):
 *  добавляешь пресет — правь обе стороны и словари i18n. */
export type SessionPreset = 'zsh' | 'claude' | 'codex';

export interface CreateSessionInput {
  name: string;
  root: string;
  dir: string;
  preset: SessionPreset;
  /** Имя не вводили — взято из каталога. Занято → агент подбирает свободное с числовым
   *  суффиксом (MyProject → MyProject1). Без признака дубль — ошибка, как раньше. */
  autoName?: boolean;
}

/** Ответ POST /api/sessions: `session` — фактическое имя созданной сессии (при `autoName`
 *  может отличаться от запрошенного); старый агент поля не отдаёт. */
export interface CreateSessionResult {
  ok: true;
  session?: string;
}

/** Состояние удержания сна (caffeinate): активно и поддерживается ли платформой. */
export interface CaffeinateState {
  active: boolean;
  supported: boolean;
}

/** Ограничение доступа гостя (шаринг одной сессии). */
export interface DeviceScope {
  session: string;
  write: boolean;
  files: boolean;
}

/** Устройство в списке (для управления). */
export interface DeviceInfo {
  name: string;
  fingerprint: string;
  addedAt: number;
  scope?: DeviceScope;
}

/** Код пейринга. */
export interface ShareInfo {
  code: string;
  expiresAt: number;
}

/** Метаданные файла для стриминга (плеер/скачивание). */
export interface FileStat {
  size: number;
  mime: string;
  kind: 'text' | 'image' | 'video' | 'audio' | 'binary';
}

/** Одна запись ленты. Форма объявлена здесь, а не импортирована из пакета агента:
 *  типы ленты живут на его стороне вместе с чтением файлов беседы, а веб знает только
 *  то, что доезжает по проводу. */
export interface FeedEntry {
  id: string;
  /** Момент, epoch ms. Ноль — метки не было. */
  at: number;
  kind: 'human' | 'agent' | 'thinking' | 'tool' | 'note';
  text: string;
  /** Имя инструмента — только у `kind: 'tool'`. */
  tool?: string;
  /** Веха кодом, а не фразой: слова подбирает экран. Только у `kind: 'note'`. */
  note?: 'compacted' | 'interrupted' | 'error' | 'chain';
  /** Ветка подагента. На сегодняшних данных пуста всегда — рисовать её нечем. */
  branch?: string;
  /** Текст обрезан агентом по пределу записи. */
  truncated?: true;
  /** Место записи `<inode>:<offset>` — им же прыгают к ней через `around`. */
  cursor?: string;
}

/** Почему ленты нет. Первые пять — слова самой ленты; `forbidden` приходит не от неё,
 *  а от моста relay, когда гость спросил чужую сессию (LAN гостей не знает). Разница
 *  транспортов на экран не выходит: причина — всегда значение, а не исключение. */
export type FeedFailureReason =
  | 'no-agent'
  | 'unknown-format'
  | 'no-transcript'
  | 'lookup-failed'
  | 'cursor-stale'
  | 'forbidden';

/** Страница ленты. Край беседы — `bof`/`eof`, а НЕ пустой список: страница бывает
 *  пустой на шаге через строку, не влезшую в окно ответа. */
export interface FeedPage {
  ok: true;
  agent: 'claude' | 'codex';
  entries: FeedEntry[];
  /** Курсоры краёв отданного куска: `head` — для запроса назад, `tail` — вперёд. */
  head: string;
  tail: string;
  bof: boolean;
  eof: boolean;
  /** Начало беседы лежит в этом же файле. */
  complete: boolean;
  /** Агент ещё работает — только тогда есть смысл спрашивать продолжение. */
  live: boolean;
  /** Сколько строк агент не разобрал. */
  skipped: number;
}

export interface FeedFailure {
  ok: false;
  reason: FeedFailureReason;
  detail: string;
}

/** Ответ на запрос страницы: отказ — такое же значение, как страница. */
export type FeedResult = FeedPage | FeedFailure;

/** Курсоры взаимоисключающие; при нескольких сразу агент берёт `around`, затем
 *  `before`, затем `after`. Лимит по умолчанию 200, максимум 1000. */
export interface FeedOptions {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
}

/** Запрос страницы на проводе: один перечень опций на оба транспорта — LAN раскладывает
 *  его в строку запроса, relay шлёт тем же набором в теле кадра. Новый параметр
 *  `FeedOptions` добавляется здесь и доезжает обоими путями, а не теряется молча на
 *  одном из них. Пустое значение не отправляется вовсе — агент читает его как
 *  отсутствующее, и слать его значит только путать. */
export function feedQuery(session: string, opts: FeedOptions): Record<string, string | number> {
  const query: Record<string, string | number> = { session };
  if (opts.limit !== undefined) query.limit = opts.limit;
  if (opts.before) query.before = opts.before;
  if (opts.after) query.after = opts.after;
  if (opts.around) query.around = opts.around;
  return query;
}

/** Ошибка REST с HTTP-статусом (для локализованной реакции UI). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOpts {
  body?: unknown;
  /** false — не редиректить на #/login при 401 (для самого логина). */
  redirectOnAuth?: boolean;
}

async function request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : 'network error');
  }

  if (res.status === 401 && opts.redirectOnAuth !== false) {
    if (location.hash !== '#/login') location.hash = '#/login';
    throw new ApiError(401, 'unauthorized');
  }

  if (!res.ok) {
    let message = res.statusText;
    try {
      const parsed = (await res.json()) as { error?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // тело не JSON — оставляем statusText
    }
    throw new ApiError(res.status, message);
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Диагностика агента (/api/diag). */
export interface DiagInfo {
  version: string;
  host: string;
  uptimeMs: number;
  port: number;
  tls: boolean;
  roots: string[];
  sessions: number;
  relay:
    | { configured: false }
    | { configured: true; url: string; connected: boolean; agentId: string; clients: number };
}

export const api = {
  login: (password: string) => request<void>('POST', '/api/login', { body: { password }, redirectOnAuth: false }),
  sessions: () => request<SessionInfo[]>('GET', '/api/sessions'),
  createSession: (input: CreateSessionInput) =>
    request<CreateSessionResult | undefined>('POST', '/api/sessions', { body: input }),
  killSession: (name: string) => request<void>('DELETE', `/api/sessions/${encodeURIComponent(name)}`),
  renameSession: (from: string, to: string) => request<void>('POST', '/api/sessions/rename', { body: { from, to } }),
  dirs: () => request<DirGroup[]>('GET', '/api/dirs'),
  diag: () => request<DiagInfo>('GET', '/api/diag'),
  mode: () => request<ModeInfo>('GET', '/api/mode'),
  /** Объявление возможностей (ADR 0018): свой список в обмен на список агента.
   *  Старый агент маршрута не знает и отвечает 404 — вызывающая сторона читает
   *  отказ как «возможностей нет». */
  capabilities: async (caps: string[]) =>
    parseCaps((await request<{ caps?: unknown }>('POST', '/api/capabilities', { body: { caps } })).caps),
  vapidKey: async () => (await request<{ key: string }>('GET', '/api/push/vapid-key', { redirectOnAuth: false })).key,
  subscribePush: (subscription: unknown) => request<void>('POST', '/api/push/subscribe', { body: { subscription } }),
  /** Страница ленты беседы. Отказ агента едет телом (`ok:false`) при HTTP 200, поэтому
   *  исключением остаётся только сбой связи. Пустое значение параметра агент читает как
   *  отсутствующее, но мы их и не шлём: в строку идёт только заданное. */
  feed: (session: string, opts: FeedOptions = {}) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(feedQuery(session, opts))) q.set(key, String(value));
    return request<FeedResult>('GET', `/api/feed?${q}`);
  },
  caffeinate: () => request<CaffeinateState>('GET', '/api/caffeinate'),
  setCaffeinate: (active: boolean) => request<CaffeinateState>('POST', '/api/caffeinate', { body: { active } }),
  filesList: (root: string, path: string) =>
    request<{ entries: FileEntry[] }>(
      'GET',
      `/api/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    ),
  fileRead: (root: string, path: string) =>
    request<{ content: FileContent }>(
      'GET',
      `/api/files/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    ),
  fileStat: (root: string, path: string) =>
    request<{ stat: FileStat }>(
      'GET',
      `/api/files/stat?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    ),
  fileDownloadUrl: (root: string, path: string) =>
    `/api/files/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
  repo: <T = unknown>(action: string, params: Record<string, unknown>) =>
    request<{ result: T }>('POST', '/api/repo', { body: { action, ...params } }).then((r) => r.result),
  fileOp: <T = unknown>(action: string, params: Record<string, unknown>) =>
    request<{ result: T }>('POST', '/api/files/op', { body: { action, ...params } }).then((r) => r.result),
  gradle: <T = unknown>(action: string, params: Record<string, unknown>) =>
    request<{ result: T }>('POST', '/api/gradle', { body: { action, ...params } }).then((r) => r.result),
  /** Загрузка файла: тело уходит потоком на /api/files/upload. XHR, а не fetch, —
   *  ради событий прогресса (у fetch нет upload-progress). */
  uploadFile: (root: string, path: string, file: File, onProgress?: (frac: number) => void) =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/files/upload?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      xhr.withCredentials = true;
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let message = `upload ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // не JSON — оставляем код статуса
        }
        reject(new ApiError(xhr.status, message));
      });
      xhr.addEventListener('error', () => reject(new Error('upload failed')));
      xhr.addEventListener('abort', () => reject(new Error('upload aborted')));
      xhr.send(file);
    }),
  share: (scope?: DeviceScope) => request<ShareInfo>('POST', '/api/share', { body: { scope } }),
  devices: () => request<DeviceInfo[]>('GET', '/api/devices'),
  revoke: (fingerprint: string) => request<void>('DELETE', `/api/devices/${encodeURIComponent(fingerprint)}`),
};
