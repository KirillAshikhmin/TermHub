// Notification API: показываем уведомление о звонке только при явном granted.
// Разрешение запрашивается кнопкой в шапке, никогда не автоматически.

import { t } from './i18n';

export type PermissionState = NotificationPermission | 'unsupported';

export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

export function permissionState(): PermissionState {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

/** Запрашивает разрешение (по кнопке). Возвращает итоговое состояние. */
export async function requestNotificationPermission(): Promise<PermissionState> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Показывает уведомление о звонке сессии (no-op без granted). */
export function notifyBell(sessionName: string): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    // Те же иконки, что и у push-уведомлений (badge — монохромный силуэт).
    new Notification(sessionName, {
      body: t('notify.bellBody'),
      icon: './icon-192.png',
      badge: './badge.png',
      tag: `termhub-bell-${sessionName}`,
    });
  } catch {
    // Некоторые окружения бросают на прямой конструктор — тихо игнорируем.
  }
}
