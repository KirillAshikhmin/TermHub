// Обёртка над REST агента: cookie-сессия (same-origin), единый разбор ошибок,
// 401 на защищённых маршрутах → редирект на экран входа.

import type { FileContent, FileEntry, SessionInfo } from '@termhub/protocol';

export interface DirGroup {
  root: string;
  dirs: string[];
}

export interface ModeInfo {
  mode: 'lan' | 'relay';
  host: string;
}

export interface CreateSessionInput {
  name: string;
  root: string;
  dir: string;
  preset: 'zsh' | 'claude';
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
  createSession: (input: CreateSessionInput) => request<void>('POST', '/api/sessions', { body: input }),
  killSession: (name: string) => request<void>('DELETE', `/api/sessions/${encodeURIComponent(name)}`),
  dirs: () => request<DirGroup[]>('GET', '/api/dirs'),
  diag: () => request<DiagInfo>('GET', '/api/diag'),
  mode: () => request<ModeInfo>('GET', '/api/mode'),
  vapidKey: async () => (await request<{ key: string }>('GET', '/api/push/vapid-key', { redirectOnAuth: false })).key,
  subscribePush: (subscription: unknown) => request<void>('POST', '/api/push/subscribe', { body: { subscription } }),
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
  share: (scope?: DeviceScope) => request<ShareInfo>('POST', '/api/share', { body: { scope } }),
  devices: () => request<DeviceInfo[]>('GET', '/api/devices'),
  revoke: (fingerprint: string) => request<void>('DELETE', `/api/devices/${encodeURIComponent(fingerprint)}`),
};
