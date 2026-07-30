// Бейдж на иконке установленного приложения (Badging API).
//
// Зачем: установленный PWA живёт как обычное приложение, и на вкладку никто не
// смотрит. Уведомление показывается один раз и уходит; бейдж держится, пока звонок
// не просмотрен, — это то, что видно на иконке в доке/на домашнем экране.
//
// Ограничение платформы: «подпрыгивание» иконки в доке macOS странице недоступно —
// это AppKit (requestUserAttention), веб-API для него нет. Максимум, что может
// страница, — бейдж на иконке плюс системное уведомление (см. notify.ts, push.ts).
// Бейдж поддержан установленными PWA в Chrome/Edge и в Safari 17+ на macOS; в
// обычной вкладке метод есть не везде, поэтому всё под проверкой и try/catch.

interface BadgeNavigator {
  setAppBadge?: (contents?: number) => Promise<unknown>;
  clearAppBadge?: () => Promise<unknown>;
}

function badgeNav(): BadgeNavigator | null {
  if (typeof navigator === 'undefined') return null;
  return navigator as unknown as BadgeNavigator;
}

/** Поддерживает ли окружение бейдж (для скрытия связанных подсказок в UI). */
export function appBadgeSupported(): boolean {
  const nav = badgeNav();
  return !!nav && typeof nav.setAppBadge === 'function';
}

/**
 * Ставит бейдж с числом непросмотренных звонков; 0 и меньше — снимает.
 * Промис намеренно не возвращаем: это косметика, вызывающему нечего с ним делать,
 * а отказ (нет разрешения, не установлено как приложение) не должен всплывать.
 */
export function updateAppBadge(count: number): void {
  const nav = badgeNav();
  if (!nav) return;
  try {
    if (count > 0) void nav.setAppBadge?.(count)?.catch(() => {});
    else void nav.clearAppBadge?.()?.catch(() => {});
  } catch {
    // Safari бросает синхронно, если документ не в установленном приложении.
  }
}
