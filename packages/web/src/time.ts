// Относительное время активности сессии — чистая функция (детерминированная
// при заданном now), локализуется через переданный переводчик.

import type { TFn } from './i18n';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** «только что» / «N мин назад» / «N ч назад» / «N дн назад». */
export function formatRelativeTime(activityTs: number, t: TFn, now: number = Date.now()): string {
  const diff = Math.max(0, now - activityTs);
  if (diff < MINUTE) return t('time.justNow');
  if (diff < HOUR) return t('time.minutes', { n: Math.floor(diff / MINUTE) });
  if (diff < DAY) return t('time.hours', { n: Math.floor(diff / HOUR) });
  return t('time.days', { n: Math.floor(diff / DAY) });
}
