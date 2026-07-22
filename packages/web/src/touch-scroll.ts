// Мобильный скролл терминала. xterm форвардит в приложение (tmux) только
// mouse/wheel-события, но НЕ touch (см. bindMouse в @xterm/xterm) — поэтому на
// телефоне драг пальцем не доходит до tmux, а нативный скролл вьюпорта (пустого
// под alt-screen tmux) уводит жест в документ: прокрутка страницы и pull-to-
// refresh. Транслируем вертикальный драг в синтетические wheel-события на корне
// xterm — его штатный обработчик пробрасывает их в pane как скролл истории.
// После отпускания — инерция (momentum): продолжаем слать wheel с затухающей
// скоростью, как нативный тач-скролл.

const FRICTION = 0.95; // множитель скорости за кадр ~16мс (деселерация инерции)
const MIN_VELOCITY = 0.05; // px/мс — ниже инерцию не запускаем и останавливаем
const IDLE_STOP_MS = 90; // пауза перед отпусканием дольше этого → без инерции (не флик)

/** Вешает трансляцию вертикального тач-драга в wheel + инерцию после отпускания.
 *  surface — где ловим касания (host терминала), target — куда шлём wheel (корень
 *  .xterm). Возвращает функцию снятия слушателей. */
export function enableTouchScroll(surface: HTMLElement, target: HTMLElement): () => void {
  let active = false;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0; // время последнего move (для скорости)
  let velocity = 0; // px/мс, знак = направление wheel
  let raf = 0;

  const sendWheel = (dy: number): void => {
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

  const stopMomentum = (): void => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  // Инерция: каждый кадр шлём wheel на velocity*dt и гасим velocity трением.
  const startMomentum = (): void => {
    let prev = 0;
    const step = (ts: number): void => {
      const dt = prev ? Math.min(ts - prev, 32) : 16; // клип на случай долгих кадров
      prev = ts;
      if (Math.abs(velocity) < MIN_VELOCITY) {
        raf = 0;
        return;
      }
      sendWheel(velocity * dt);
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
    lastX = e.touches[0]!.clientX;
    lastY = e.touches[0]!.clientY;
    lastT = e.timeStamp;
    velocity = 0;
  };

  const onMove = (e: TouchEvent): void => {
    if (!active || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    // Палец вниз (clientY растёт) → dy<0 → wheel вверх → tmux листает к истории
    // (совпадает с нативным тач-скроллом: тянешь вниз — уезжаешь назад).
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
    sendWheel(dy);
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
