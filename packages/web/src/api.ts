// Обёртка над REST агента: cookie-сессия (same-origin), единый разбор ошибок,
// 401 на защищённых маршрутах → редирект на экран входа.

import type { ActResult, ChatAction, CommandsResult, LiveResult, ToolDetail } from '@termhub/protocol/chat';
import { parseCaps } from '@termhub/protocol/capabilities';
import type { FileContent, FileEntry, SessionInfo } from '@termhub/protocol';

export interface DirGroup {
  root: string;
  dirs: string[];
}

export interface ModeInfo {
  mode: 'lan' | 'relay';
  host: string;
  /** Только relay: каким сокетом ходить — 'ws' или 'poll' (короткими запросами). */
  transport?: string;
}

/** Пресет создаваемой сессии. «zsh» — оболочка, остальные запускают одноимённую
 *  команду поверх неё. Зеркалит SESSION_PRESETS агента (packages/agent/src/sessions.ts):
 *  добавляешь пресет — правь обе стороны и словари i18n. */
export type SessionPreset = 'zsh' | 'claude' | 'codex' | 'opencode';

export interface CreateSessionInput {
  name: string;
  root: string;
  dir: string;
  preset: SessionPreset;
  /** Имя не вводили — взято из каталога. Занято → агент подбирает свободное с числовым
   *  суффиксом (MyProject → MyProject1). Без признака дубль — ошибка, как раньше. */
  autoName?: boolean;
  /** Создать новый подкаталог перед запуском сессии. */
  createDir?: boolean;
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
  /** Режим «не спать при закрытой крышке» (хост на macOS): платформа умеет, разрешение на
   *  хосте выдано (`termhub lid-awake`), режим включён. У другого хоста полей нет. */
  lidSupported?: boolean;
  lidReady?: boolean;
  lid?: boolean;
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
  note?: 'compacted' | 'interrupted' | 'error' | 'chain' | 'agent-start' | 'agent-done' | 'agent-message';
  /** Описание действия словами агента — только у `tool`, когда агент его дал. */
  desc?: string;
  /** Кто прислал сообщение — только у `agent-message`, когда отправитель назван. */
  from?: string;
  /** Сколько работал фоновый агент, секунды — только у `agent-done`. */
  elapsed?: number;
  /** Чем кончил фоновый агент, если не успехом, — только у `agent-done`. */
  outcome?: 'failed' | 'stopped';
  /** Ветка подагента. На сегодняшних данных пуста всегда — рисовать её нечем. */
  branch?: string;
  /** Текст обрезан агентом по пределу записи. */
  truncated?: true;
  /** Место записи `<inode>:<offset>` — им же прыгают к ней через `around`. */
  cursor?: string;
  /** У действия есть подробности (команда и вывод, diff): их тянут отдельным запросом
   *  `feed` с `detail=<cursor>`. Только у `kind: 'tool'`; у старого агента поля нет. */
  detail?: true;
  /** Чем кончилось действие — только у `tool`; поля нет у старого агента и когда результат
   *  остался за краем окна страницы. */
  result?: ToolResult;
}

/** Исход действия (форма провода агента). `exit` — код выхода, только ненулевой и только
 *  когда транскрипт его называет; `stopped` — прервано человеком. */
export interface ToolResult {
  state: 'done' | 'running' | 'failed' | 'stopped';
  exit?: number;
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
  agent: 'claude' | 'codex' | 'opencode';
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

/** Подробности действия (`feed` с `detail`): тело `ToolDetail` с `ok:true` либо отказ
 *  ленты. Форма провода — `@termhub/protocol/chat`. */
/** Исход в подробностях называется только у ошибки и прерывания; успех — отсутствие
 *  поля и `pending`. */
export type DetailResult = ({ ok: true } & ToolDetail & { result?: ToolResult }) | FeedFailure;

/** Курсоры взаимоисключающие; при нескольких сразу агент берёт `around`, затем
 *  `before`, затем `after`. Лимит по умолчанию 200, максимум 1000. */
export interface FeedOptions {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
  /** Вместо страницы ленты вернуть расход сессии (usage.ts; возможность `usage`). */
  usage?: true;
  /** Вместо страницы вернуть подробности действия по курсору его записи (чат). */
  detail?: string;
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
  if (opts.usage) query.usage = 1;
  if (opts.detail) query.detail = opts.detail;
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
  /** Свой relay на машине агента; поля нет — он не включён (или агент старше). */
  localRelay?: { port: number; tls: boolean; running: boolean; connected: boolean; clients: number };
  relay:
    | { configured: false }
    | { configured: true; url: string; connected: boolean; agentId: string; clients: number; dial?: string };
}

/** Файл на хост: тело — сам файл, ответ — путь. Тип и (необязательно) имя едут параметрами:
 *  имя агент использует только для расширения. */
async function pasteBlob(blob: Blob, name?: string): Promise<string> {
  let res: Response;
  const q = `type=${encodeURIComponent(blob.type)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
  try {
    res = await fetch(`/api/paste-image?${q}`, { method: 'POST', credentials: 'same-origin', body: blob });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : 'network error');
  }
  const body = (await res.json().catch(() => ({}))) as { path?: unknown; error?: unknown };
  if (!res.ok || typeof body.path !== 'string') {
    throw new ApiError(res.status, typeof body.error === 'string' ? body.error : res.statusText);
  }
  return body.path;
}

/** Картинка по абсолютному пути из сообщения чата. Что отдавать, решает агент (каталоги,
 *  растр по содержимому, 20 МиБ); любой отказ — исключение. */
async function imageBlob(session: string, path: string): Promise<Blob> {
  let res: Response;
  const q = `session=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}`;
  try {
    res = await fetch(`/api/files/image?${q}`, { credentials: 'same-origin' });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : 'network error');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new ApiError(res.status, typeof body.error === 'string' ? body.error : res.statusText);
  }
  return res.blob();
}

export const api = {
  login: (password: string) => request<void>('POST', '/api/login', { body: { password }, redirectOnAuth: false }),
  sessions: () => request<SessionInfo[]>('GET', '/api/sessions'),
  createSession: (input: CreateSessionInput) =>
    request<CreateSessionResult | undefined>('POST', '/api/sessions', { body: input }),
  killSession: (name: string) => request<void>('DELETE', `/api/sessions?name=${encodeURIComponent(name)}`),
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
  /** Подробности действия: тот же маршрут ленты с `detail` (ADR чата). */
  feedDetail: (session: string, cursor: string) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(feedQuery(session, { detail: cursor }))) q.set(key, String(value));
    return request<DetailResult>('GET', `/api/feed?${q}`);
  },
  /** Экран агента в панели. Отказ — телом `ok:false` при HTTP 200, как у ленты. */
  live: (session: string) => request<LiveResult>('GET', `/api/live?session=${encodeURIComponent(session)}`),
  act: (session: string, action: ChatAction) => request<ActResult>('POST', '/api/act', { body: { session, action } }),
  commands: (session: string) =>
    request<CommandsResult>('GET', `/api/commands?session=${encodeURIComponent(session)}`),
  caffeinate: () => request<CaffeinateState>('GET', '/api/caffeinate'),
  setCaffeinate: (active: boolean) => request<CaffeinateState>('POST', '/api/caffeinate', { body: { active } }),
  setLidAwake: (lid: boolean) => request<CaffeinateState>('POST', '/api/caffeinate', { body: { lid } }),
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
  /** Картинка из буфера: тело — сам файл, ответ — путь на хосте (см. term-paste.ts). */
  pasteImage: (blob: Blob): Promise<string> => pasteBlob(blob),
  /** Любой файл на хост (вложение чата): тот же маршрут, имя — подсказка для расширения. */
  pasteFile: (blob: Blob, name: string): Promise<string> => pasteBlob(blob, name),
  image: (session: string, path: string): Promise<Blob> => imageBlob(session, path),
  share: (scope?: DeviceScope) => request<ShareInfo>('POST', '/api/share', { body: { scope } }),
  devices: () => request<DeviceInfo[]>('GET', '/api/devices'),
  revoke: (fingerprint: string) => request<void>('DELETE', `/api/devices/${encodeURIComponent(fingerprint)}`),
};
