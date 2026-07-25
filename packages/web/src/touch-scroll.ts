// Мобильный скролл терминала. Режим выбирается по активному буферу xterm:
//  • alt-screen — форвардим вертикальный драг в синтетические wheel на корень xterm;
//    его обработчик (при tmux mouse on) шлёт их в приложение, и tmux уходит в copy-mode,
//    listая свою историю (history-limit 50000). ЭТО ОСНОВНОЙ ПУТЬ: `tmux attach` держит
//    терминал в alt-screen всю сессию, поэтому скролл истории идёт через relay;
//  • обычный экран (normal buffer) — до attach и после detach: двигаем .xterm-viewport
//    напрямую, локально и без relay.
// xterm форвардит в приложение только mouse/wheel (не touch), а нативный скролл вьюпорта
// увёл бы жест в документ (прокрутка страницы / pull-to-refresh) — поэтому перехватываем.
// После отпускания — инерция (momentum) с затуханием, как нативный тач-скролл.

/** Минимум от xterm-терминала, нужный для скролла (для лёгкости и тестируемости). */
interface ScrollTerm {
  element?: HTMLElement;
  buffer: { active: { readonly type: 'normal' | 'alternate' } };
}

const FRICTION = 0.95; // множитель скорости за кадр ~16мс (деселерация инерции)
const MIN_VELOCITY = 0.05; // px/мс — ниже инерцию не запускаем и останавливаем
const IDLE_STOP_MS = 90; // пауза перед отпусканием дольше этого → без инерции (не флик)

/** Вешает тач-скролл терминала (гибрид локальный/relay) + инерцию. surface — где ловим
 *  касания (host терминала), term — экземпляр xterm. Возвращает функцию снятия. */
export function enableTouchScroll(surface: HTMLElement, term: ScrollTerm): () => void {
  let active = false;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0; // время последнего move (для скорости)
  let velocity = 0; // px/мс, знак = направление скролла
  let raf = 0;
  let altAtStart = false; // режим фиксируем на старте жеста (весь драг + инерция единообразны)

  const scrollBy = (dy: number): void => {
    if (altAtStart) {
      // alt-screen: форвардим wheel в приложение (tmux/TUI) — локальной истории нет.
      (term.element ?? surface).dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: dy,
          deltaMode: 0,
          clientX: lastX,
          clientY: lastY,
          bubbles: true,
          cancelable: true,
        }),
      );
    } else {
      // обычный экран: двигаем локальный scrollback xterm напрямую (без relay).
      const vp = term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
      if (vp) vp.scrollTop += dy;
    }
  };

  const stopMomentum = (): void => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  // Инерция: каждый кадр скроллим на velocity*dt и гасим velocity трением.
  const startMomentum = (): void => {
    let prev = 0;
    const step = (ts: number): void => {
      const dt = prev ? Math.min(ts - prev, 32) : 16; // клип на случай долгих кадров
      prev = ts;
      if (Math.abs(velocity) < MIN_VELOCITY) {
        raf = 0;
        return;
      }
      scrollBy(velocity * dt);
      velocity *= Math.pow(FRICTION, dt / 16);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const onStart = (e: TouchEvent): void => {
    stopMomentum(); // новое касание гасит инерцию
    // Только одиночный драг: мультитач (пинч) не наш случай.
    if (e.touches.length !== 1) {
      active = false;
      return;
    }
    active = true;
    altAtStart = term.buffer.active.type === 'alternate';
    lastX = e.touches[0]!.clientX;
    lastY = e.touches[0]!.clientY;
    lastT = e.timeStamp;
    velocity = 0;
  };

  const onMove = (e: TouchEvent): void => {
    if (!active || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    // Палец вниз (clientY растёт) → dy<0 → скролл к истории (совпадает с нативным).
    const dy = lastY - t.clientY;
    const dt = e.timeStamp - lastT;
    lastX = t.clientX;
    lastY = t.clientY;
    lastT = e.timeStamp;
    // Сглаженная скорость (px/мс) — включая dy===0, чтобы пауза перед отпусканием её гасила.
    if (dt > 0) velocity = (dy / dt) * 0.75 + velocity * 0.25;
    // Нативный овербаунс/скролл страницы гасим всегда, даже при dy===0.
    if (e.cancelable) e.preventDefault();
    if (dy === 0) return;
    scrollBy(dy);
  };

  const onEnd = (e: TouchEvent): void => {
    // Флик (есть скорость и отпустили сразу после движения) → инерция.
    if (active && Math.abs(velocity) >= MIN_VELOCITY && e.timeStamp - lastT < IDLE_STOP_MS) startMomentum();
    active = false;
  };

  const onCancel = (): void => {
    active = false; // системный перехват жеста — без инерции
  };

  surface.addEventListener('touchstart', onStart, { passive: true });
  surface.addEventListener('touchmove', onMove, { passive: false });
  surface.addEventListener('touchend', onEnd, { passive: true });
  surface.addEventListener('touchcancel', onCancel, { passive: true });

  return () => {
    stopMomentum();
    surface.removeEventListener('touchstart', onStart);
    surface.removeEventListener('touchmove', onMove);
    surface.removeEventListener('touchend', onEnd);
    surface.removeEventListener('touchcancel', onCancel);
  };
}
