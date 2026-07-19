// Маршрутизация fetch-стратегий service worker'а. Вынесено чистой функцией
// (без обращений к self/caches/fetch), чтобы покрыть юнит-тестом: sw.ts целиком
// в тестах не импортируется — он на верхнем уровне вешает слушатели на self.

/**
 * Стратегия обработки same-origin GET-запроса (не-GET и кросс-origin
 * отсеиваются в самом хендлере до вызова):
 * - `network-first` — HTML/навигация: сеть, при успехе обновляем кэш, офлайн →
 *   закэшированный app-shell. Свежий index со ссылками на новые хэш-ассеты
 *   доезжает при онлайне без бампа версии кэша (снимает залипание PWA).
 * - `cache-first` — иммутабельные ассеты (`/assets/*`, хэш-имена vite) и прочая
 *   статика: версионируются именем файла, залипания нет.
 * - `network-only` — `/api/*`: динамика, всегда сеть, кэш не задействуем.
 * - `passthrough` — `/ws/`: WebSocket-апгрейд, SW не проксирует сокеты.
 */
export type FetchStrategy = 'network-first' | 'cache-first' | 'network-only' | 'passthrough';

export function pickStrategy(url: URL, mode: string): FetchStrategy {
  if (url.pathname.startsWith('/ws/')) return 'passthrough';
  if (url.pathname.startsWith('/api/')) return 'network-only';
  if (mode === 'navigate') return 'network-first';
  if (url.pathname === '/' || url.pathname.endsWith('/index.html')) return 'network-first';
  return 'cache-first';
}
