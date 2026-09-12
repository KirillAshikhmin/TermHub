// Мобильный скролл терминала. Режим выбирается по активному буферу xterm:
//  • обычный экран (normal buffer) — ЭТО ОСНОВНОЙ ПУТЬ: в control mode tmux не держит
//    терминал в alt-screen, вывод ложится в обычный буфер, и история листается локально —
//    прокручиваем официальным API xterm (term.scrollLines), без relay;
//  • alt-screen — откат на `tmux attach` (он держит терминал в alt-screen всю сессию) и
//    приложения, ушедшие туда сами: форвардим вертикальный драг в синтетические wheel на
//    корень xterm; его обработчик (при tmux mouse on) шлёт их в приложение, и tmux уходит
//    в copy-mode, листая свою историю (history-limit 50000) — этот скролл идёт через relay.
// xterm форвардит в приложение только mouse/wheel (не touch), а нативный скролл вьюпорта
// увёл бы жест в документ (прокрутка страницы / pull-to-refresh) — поэтому перехватываем.
// После отпускания — инерция (momentum) с затуханием, как нативный тач-скролл.
//
// Почему не .xterm-viewport.scrollTop: в xterm 6 вьюпорт больше не нативный скролл-контейнер.
// Прокрутку рисует вендоренный из vscode ScrollableElement (.xterm-scrollable-element со
// своим ползунком), высокой .xterm-scroll-area внутри вьюпорта больше нет — scrollTop у него
// всегда 0, и присваивание ему не двигает ничего. Официальный путь один: scrollLines/
// scrollToBottom/scrollToLine у самого терминала.

/** Минимум от xterm-терминала, нужный для скролла (для лёгкости и тестируемости). */
interface ScrollTerm {
  element?: HTMLElement;
  readonly rows: number;
  buffer: { active: { readonly type: 'normal' | 'alternate' } };
  scrollLines(amount: number): void;
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
  let restPx = 0; // пиксели жеста, не набравшие целой строки — копятся до следующего события

  /** Высота строки в CSS-пикселях. Константы тут быть не может: она зависит от шрифта,
   *  lineHeight и зума. Считаем из того, что задаёт сама библиотека: .xterm-screen xterm
   *  растягивает ровно на rows × высоту строки (dimensions.css.canvas.height), значит
   *  высота этого элемента, делённая на rows, и есть строка. 0 — измерить нечего. */
  const lineHeightPx = (): number => {
    const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen || term.rows <= 0) return 0;
    // Фактическая геометрия — в тех же CSS-px, что и clientY касания. Пока вкладка скрыта,
    // размера нет: тогда берём inline-высоту, которую xterm пишет этому элементу сам.
    const measured = screen.getBoundingClientRect().height;
    const inline = Number.parseFloat(screen.style.height);
    const height = measured > 0 ? measured : Number.isFinite(inline) ? inline : 0;
    return height > 0 ? height / term.rows : 0;
  };

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
      return;
    }
    // Обычный экран: официальный API xterm считает строками, поэтому переводим пиксели
    // жеста в строки по измеренной высоте строки. Остаток обязан копиться между
    // событиями: медленный драг даёт по несколько пикселей за move, и без накопления
    // каждый шаг округлялся бы в ноль — палец ехал бы, а история стояла.
    const lineHeight = lineHeightPx();
    if (lineHeight <= 0) return; // терминал ещё не отрисован — и прокручивать нечего
    restPx += dy;
    const lines = Math.trunc(restPx / lineHeight);
    if (lines === 0) return;
    restPx -= lines * lineHeight;
    term.scrollLines(lines);
  };

  const stopMomentum = (): void => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  // Инерция: каждый кадр скроллим на velocity*dt и гасим velocity трением. Путь тот же,
  // что и у драга (scrollBy), включая накопление остатка — затухающая инерция как раз и
  // доезжает на долях строки.
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
    // Ползунок скроллбара xterm 6 тащится на POINTER-событиях, а их наш preventDefault на
    // touchmove не отменяет (pointerdown уходит раньше touchstart и не отменяем из touch).
    // Значит драг по полосе прокрутил бы вьюпорт дважды — ползунком и нами. Такой жест
    // отдаём библиотеке целиком. Невидимая полоса получает pointer-events:none, поэтому
    // касания по тексту она не перехватывает; страницу в это время держит touch-action:none
    // на хосте терминала.
    const target = e.target;
    if (target instanceof Element && target.closest('.xterm-scrollable-element > .scrollbar')) {
      active = false;
      return;
    }
    active = true;
    altAtStart = term.buffer.active.type === 'alternate';
    lastX = e.touches[0]!.clientX;
    lastY = e.touches[0]!.clientY;
    lastT = e.timeStamp;
    velocity = 0;
    restPx = 0; // новый жест считает строки с нуля
  };

  const onMove = (e: TouchEvent): void => {
    if (!active || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    // Палец вниз (clientY растёт) → dy<0 → scrollLines(<0) → к истории (как нативный скролл).
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

  // Собственных тач-слушателей у xterm 6 в игре нет: вендоренный из vscode Gesture
  // (touchstart/touchmove на документе с passive:false + touchend) поднимается лениво из
  // Gesture.addTarget()/Gesture.ignoreTarget(), а их в собранном пакете не зовёт никто —
  // синглтон не создаётся, слушателей на документе не появляется, спорить с нашим
  // preventDefault некому. Живое тач-поведение у библиотеки одно — ползунок скроллбара
  // на pointer-событиях, он разведён в onStart.
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
