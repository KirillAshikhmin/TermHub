// Мобильное выделение текста в терминале. xterm выделяет мышью (SelectionService
// слушает mousedown/mousemove/mouseup), но НЕ touch — поэтому пальцем текст не
// выделить. В режиме выделения (тумблер в панели) транслируем одиночный тач-драг
// в синтетические mouse-события на .xterm-screen: xterm выделяет диапазон, который
// затем копируется через term.getSelection(). Зеркало touch-scroll.ts, но целевое
// событие — mouse, а не wheel, и tap без движения выделения не даёт (нужен драг).

/** Вешает трансляцию тач-драга в mouse-выделение. surface — где ловим касания
 *  (host терминала), screen — куда шлём mouse (.xterm-screen). Возвращает функцию
 *  снятия слушателей. */
export function enableTouchSelect(surface: HTMLElement, screen: HTMLElement): () => void {
  let active = false;

  const fire = (type: 'mousedown' | 'mousemove' | 'mouseup', t: Touch): void => {
    screen.dispatchEvent(
      new MouseEvent(type, {
        clientX: t.clientX,
        clientY: t.clientY,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  };

  const onStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1) {
      active = false;
      return;
    }
    active = true;
    fire('mousedown', e.touches[0]!);
  };

  const onMove = (e: TouchEvent): void => {
    if (!active || e.touches.length !== 1) return;
    // Гасим нативный скролл/овербаунс страницы — жест целиком уходит в выделение.
    if (e.cancelable) e.preventDefault();
    fire('mousemove', e.touches[0]!);
  };

  const onEnd = (e: TouchEvent): void => {
    if (!active) return;
    active = false;
    const t = e.changedTouches[0];
    if (t) fire('mouseup', t);
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
