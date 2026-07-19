// Веб-push подписка: конвертация VAPID-ключа и оформление подписки через SW.
// enablePush вызывается после того, как пользователь разрешил уведомления.

import type { Transport } from './transport';

/** VAPID-ключ приходит как URL-safe base64; PushManager ждёт сырые байты
 *  (строго ArrayBuffer-backed — потому выделяем буфер явно). */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * Оформляет push-подписку: берёт VAPID-ключ у агента, подписывается через
 * pushManager и отправляет подписку агенту. Требует зарегистрированного SW и
 * granted-разрешения. Возвращает true при успехе, false — если push недоступен.
 */
export async function enablePush(transport: Transport): Promise<boolean> {
  if (!('serviceWorker' in navigator) || typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.pushManager) return false;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const key = await transport.vapidKey();
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    await transport.subscribePush(subscription.toJSON());
    return true;
  } catch {
    // Push мог быть недоступен (нет ключа, отказ pushManager, оффлайн) — не критично.
    return false;
  }
}
