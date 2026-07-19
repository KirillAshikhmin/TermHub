// Решение «регистрировать ли service worker». Вынесено из main.ts чистой
// функцией — без обращений к navigator/window, чтобы покрыть юнит-тестом.

/**
 * SW/PWA/web-push работают только в secure context (https, а также
 * localhost/127.0.0.1/::1 — это учитывает нативный `isSecureContext`) и при
 * наличии `navigator.serviceWorker`.
 */
export function shouldRegisterSw(env: { isSecureContext: boolean; hasServiceWorker: boolean }): boolean {
  return env.isSecureContext && env.hasServiceWorker;
}
