// Мобильный скролл терминала. xterm форвардит в приложение (tmux) только
// mouse/wheel-события, но НЕ touch (см. bindMouse в @xterm/xterm) — поэтому на
// телефоне драг пальцем не доходит до tmux, а нативный скролл вьюпорта (пустого
// под alt-screen tmux) уводит жест в документ: прокрутка страницы и pull-to-
// refresh. Транслируем вертикальный драг в синтетические wheel-события на корне
// xterm — его штатный обработчик пробрасывает их в pane как скролл истории.

/** Вешает трансляцию вертикального тач-драга в wheel. surface — где ловим
 *  касания (host терминала), target — куда шлём wheel (корень .xterm).
 *  Возвращает функцию снятия слушателей. */
export function enableTouchScroll(surface: HTMLElement, target: HTMLElement): () => void {
  let active = false;
  let lastX = 0;
  let lastY = 0;

  const onStart = (e: TouchEvent): void => {
    // Только одиночный драг: мультитач (пинч) не наш случай.
    if (e.touches.length !== 1) {
      active = false;
      return;
    }
    active = true;
    lastX = e.touches[0]!.clientX;
    lastY = e.touches[0]!.clientY;
  };

  const onMove = (e: TouchEvent): void => {
    if (!active || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    // Палец вниз (clientY растёт) → dy<0 → wheel вверх → tmux листает к истории
    // (совпадает с нативным тач-скроллом: тянешь вниз — уезжаешь назад).
    const dy = lastY - t.clientY;
    lastX = t.clientX;
    lastY = t.clientY;
    // Нативный овербаунс/скролл страницы гасим всегда, даже при dy===0.
    if (e.cancelable) e.preventDefault();
    if (dy === 0) return;
    target.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: dy,
        deltaMode: 0,
        clientX: lastX,
        clientY: lastY,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  const onEnd = (): void => {
    active = false;
  };

  surface.addEventListener('touchstart', onStart, { passive: true });
  surface.addEventListener('touchmove', onMove, { passive: false });
  surface.addEventListener('touchend', onEnd, { passive: true });
  surface.addEventListener('touchcancel', onEnd, { passive: true });

  return () => {
    surface.removeEventListener('touchstart', onStart);
    surface.removeEventListener('touchmove', onMove);
    surface.removeEventListener('touchend', onEnd);
    surface.removeEventListener('touchcancel', onEnd);
  };
}
