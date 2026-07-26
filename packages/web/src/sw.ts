// Service worker TermHub: precache app-shell, показ push-уведомлений о звонке
// терминала и фокус/открытие вкладки по клику. Собирается отдельным rollup-входом
// (vite.config) в корневой /sw.js, чтобы scope был '/'. Типы SW-окружения заданы
// локально: подмешивать webworker-lib к DOM-конфигурации проекта нельзя (конфликты).

import { pickStrategy } from './sw-strategy';

const CACHE = 'termhub-shell-v1';
const SHELL = ['./', './index.html'];

interface WaitUntilEvent {
  waitUntil(promise: Promise<unknown>): void;
}
interface PushEventLike extends WaitUntilEvent {
  data: { text(): string } | null;
}
interface NotificationEventLike extends WaitUntilEvent {
  notification: { data: unknown; close(): void };
}
interface FetchEventLike {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}
interface WindowClientLike {
  url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
  postMessage(message: unknown): void;
}
interface SwScope {
  addEventListener(type: 'install', listener: (e: WaitUntilEvent) => void): void;
  addEventListener(type: 'activate', listener: (e: WaitUntilEvent) => void): void;
  addEventListener(type: 'push', listener: (e: PushEventLike) => void): void;
  addEventListener(type: 'notificationclick', listener: (e: NotificationEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (e: FetchEventLike) => void): void;
  location: { origin: string };
  registration: {
    scope: string;
    showNotification(title: string, options: Record<string, unknown>): Promise<void>;
  };
  clients: {
    matchAll(options: { type: string; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<WindowClientLike | null>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
}

const sw = self as unknown as SwScope;

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  // Перехватываем только GET того же origin; POST/PUT и кросс-origin (CDN и пр.)
  // отдаём браузеру напрямую — не наша зона ответственности.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  const strategy = pickStrategy(url, request.mode);
  // /ws/ — WebSocket-апгрейд, SW не проксирует сокеты: отдаём браузеру напрямую.
  if (strategy === 'passthrough') return;
  // /api/* — динамика: всегда в сеть, кэш не задействуем.
  if (strategy === 'network-only') {
    event.respondWith(fetch(request));
    return;
  }
  // HTML/навигация — network-first (свежий index с новыми хэш-ассетами);
  // иммутабельные ассеты — cache-first.
  event.respondWith(strategy === 'network-first' ? networkFirst(request) : cacheFirst(request));
});

sw.addEventListener('push', (event) => {
  const { session, task } = readPush(event.data);
  event.waitUntil(
    (async () => {
      await sw.registration.showNotification('TermHub', {
        body: task ? `${session}: ${task}` : session,
        // icon — цветная иконка в теле уведомления; badge — МОНОХРОМНЫЙ силуэт в
        // статус-баре (Android рисует его по альфа-каналу, цвет игнорирует).
        // Только растр: SVG в уведомлениях Chrome не поддерживает.
        icon: './icon-192.png',
        badge: './badge.png',
        tag: session,
        renotify: true,
        data: { session },
      });
      // Звук уведомления задаёт система (канал уведомлений), веб его выбрать не может.
      // Поэтому, если страница ещё жива, просим её проиграть наш «звонок» — тот же,
      // что и при звонке в открытом приложении.
      const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) client.postMessage({ t: 'termhub-bell', session });
    })(),
  );
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { session?: unknown } | null;
  const session = data && typeof data.session === 'string' ? data.session : '';
  const target = new URL(session ? `#/term/${encodeURIComponent(session)}` : '#/', sw.registration.scope).href;
  event.waitUntil(focusOrOpen(target));
});

/**
 * Network-first: идём в сеть, при успехе обновляем кэш свежим ответом и отдаём
 * его — так HTML/навигация всегда получают актуальный index со ссылками на новые
 * хэш-ассеты (обновление PWA без бампа версии кэша). При офлайн-ошибке — фолбэк
 * на кэш: сам ответ, иначе закэшированный app-shell (`./index.html`), чтобы SPA
 * поднялось без сети.
 */
async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(request)) ?? (await cache.match('./index.html'));
    if (cached) return cached;
    throw error;
  }
}

/**
 * Cache-first: отдаём из precache/runtime-кэша, иначе идём в сеть и кэшируем
 * успешный ответ. Для иммутабельных ассетов (хэш-имена vite) залипания нет:
 * новый ассет = новое имя файла = новый ключ кэша.
 */
async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

/** Достаёт имя сессии из JSON-пейлоада `{session}`. */
function readPush(data: { text(): string } | null): { session: string; task: string } {
  if (!data) return { session: 'TermHub', task: '' };
  try {
    const parsed = JSON.parse(data.text()) as { session?: unknown; task?: unknown };
    const session =
      typeof parsed.session === 'string' && parsed.session.length > 0 ? parsed.session : 'TermHub';
    const task = typeof parsed.task === 'string' ? parsed.task : '';
    return { session, task };
  } catch {
    return { session: 'TermHub', task: '' };
  }
}

/** Фокусирует уже открытую вкладку TermHub и ведёт её на нужный терминал; иначе открывает новую. */
async function focusOrOpen(url: string): Promise<void> {
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = clients[0];
  if (client) {
    await client.focus();
    await client.navigate(url).catch(() => undefined);
    return;
  }
  await sw.clients.openWindow(url);
}
