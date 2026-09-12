// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { enableTouchScroll } from '../src/touch-scroll';

/** Высота строки и число строк тестового терминала: .xterm-screen xterm растягивает ровно
 *  на rows × высоту строки, поэтому высота элемента = ROWS * LINE_HEIGHT — оттуда же, откуда
 *  её берёт код (никаких «магических» договорённостей о высоте строки между кодом и тестом). */
const LINE_HEIGHT = 16;
const ROWS = 25;

/** Синтетическое touch-событие с массивом touches (happy-dom не строит TouchEvent).
 *  timeStamp задаём явно — от него зависят скорость и решение об инерции. */
function touchEvent(
  type: string,
  points: Array<{ clientX: number; clientY: number }>,
  timeStamp = 0,
): Event {
  const ev = new Event(type, { cancelable: true, bubbles: true }) as Event & {
    touches: unknown;
    changedTouches: unknown;
  };
  ev.touches = points;
  ev.changedTouches = points;
  Object.defineProperty(ev, 'timeStamp', { value: timeStamp });
  return ev;
}

interface Harness {
  surface: HTMLElement;
  root: HTMLElement;
  screen: HTMLElement;
  slider: HTMLElement;
  deltas: number[];
  lines: number[];
  off: () => void;
}

/** term-мок: element с .xterm-screen (по нему меряется высота строки) и скроллбаром
 *  xterm 6, rows, тип активного буфера и запись вызовов scrollLines. */
function setup(bufferType: 'normal' | 'alternate' = 'alternate'): Harness {
  const surface = document.createElement('div');
  const root = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  screen.style.height = `${ROWS * LINE_HEIGHT}px`;
  // Скроллбар xterm 6 (vscode-овский ScrollableElement) — часть того же поддерева.
  const scrollable = document.createElement('div');
  scrollable.className = 'xterm-scrollable-element';
  const bar = document.createElement('div');
  bar.className = 'visible scrollbar vertical';
  const slider = document.createElement('div');
  slider.className = 'slider';
  bar.append(slider);
  scrollable.append(bar);
  root.append(screen, scrollable);
  surface.append(root); // host содержит .xterm — как в живом DOM, чтобы событие всплывало
  const deltas: number[] = [];
  root.addEventListener('wheel', (e) => deltas.push((e as WheelEvent).deltaY));
  const lines: number[] = [];
  const term = {
    element: root,
    rows: ROWS,
    buffer: { active: { type: bufferType } },
    scrollLines: (amount: number) => lines.push(amount),
  };
  const off = enableTouchScroll(surface, term);
  return { surface, root, screen, slider, deltas, lines, off };
}

describe('enableTouchScroll — alt-screen (форвард wheel в приложение через relay)', () => {
  it('драг ВНИЗ → wheel вверх (deltaY<0), скролл к истории', () => {
    const { surface, deltas } = setup('alternate');
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 140 }])); // палец вниз 40px
    expect(deltas).toEqual([-40]);
  });

  it('драг ВВЕРХ → wheel вниз (deltaY>0)', () => {
    const { surface, deltas } = setup('alternate');
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 70 }])); // палец вверх 30px
    expect(deltas).toEqual([30]);
  });

  it('несколько move аккумулируют относительно предыдущей точки', () => {
    const { surface, deltas } = setup('alternate');
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 120 }])); // -20
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 150 }])); // -30
    expect(deltas).toEqual([-20, -30]);
  });

  it('alt-screen не трогает scrollLines — история у приложения, не у xterm', () => {
    const { surface, lines } = setup('alternate');
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 140 }]));
    expect(lines).toEqual([]);
  });
});

describe('enableTouchScroll — обычный экран (локальный буфер xterm, без relay)', () => {
  it('драг листает историю через term.scrollLines, wheel НЕ шлём', () => {
    const { surface, lines, deltas } = setup('normal');
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 140 }])); // палец вниз 40 → dy=-40
    expect(lines).toEqual([-2]); // 40px / 16px = 2 строки, знак — к истории
    expect(deltas).toEqual([]); // ничего через relay
  });

  it('направление совпадает с нативным: палец вниз → в историю, палец вверх → к концу', () => {
    const down = setup('normal');
    down.surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    down.surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 132 }])); // палец вниз 32
    expect(down.lines).toEqual([-2]); // scrollLines<0 = вверх по буферу = в историю
    const up = setup('normal');
    up.surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    up.surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 68 }])); // палец вверх 32
    expect(up.lines).toEqual([2]); // scrollLines>0 = вниз по буферу = к свежему выводу
  });

  it('медленный драг долями строки прокручивает после накопления остатка', () => {
    const { surface, lines } = setup('normal');
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    // По 5px за событие — меньше строки (16px): поодиночке каждое даёт 0 строк.
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 105 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 110 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 115 }]));
    expect(lines).toEqual([]); // 15px накоплено — строки ещё нет
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 120 }]));
    expect(lines).toEqual([-1]); // 20px ≥ строки → одна строка, 4px остаются в остатке
  });

  it('высота строки берётся из измеренного .xterm-screen, а не из константы', () => {
    const { surface, screen, lines } = setup('normal');
    // Реальная геометрия крупнее inline-высоты (400px): 600/25 = 24px на строку.
    (screen as unknown as { getBoundingClientRect: () => { height: number } }).getBoundingClientRect =
      () => ({ height: 600 });
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 148 }])); // палец вниз 48
    expect(lines).toEqual([-2]); // 48/24 = 2 строки (по inline-высоте было бы 3)
  });

  it('инерция после отпускания листает тем же scrollLines', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    try {
      const { surface, lines, deltas } = setup('normal');
      surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }], 0));
      surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 200 }], 10)); // 100px за 10мс
      surface.dispatchEvent(touchEvent('touchend', [], 12));
      expect(lines).toEqual([-6]); // сам драг: 100px → 6 строк, 4px в остатке
      expect(frames.length).toBe(1); // флик запустил инерцию
      frames[0]!(0);
      // velocity -7.5px/мс × 16мс = 120px, плюс 4px остатка драга → 7 строк.
      expect(lines).toEqual([-6, -7]);
      expect(deltas).toEqual([]); // инерция обычного экрана тоже без relay
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('enableTouchScroll — общее', () => {
  it('touchmove гасит дефолт (нет скролла страницы / pull-to-refresh)', () => {
    const { surface } = setup('normal');
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    const move = touchEvent('touchmove', [{ clientX: 10, clientY: 120 }]);
    surface.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
  });

  it('мультитач (пинч) игнорируется — ни wheel, ни scrollLines', () => {
    const alt = setup('alternate');
    const pinch = (): Array<{ clientX: number; clientY: number }> => [
      { clientX: 10, clientY: 140 },
      { clientX: 20, clientY: 140 },
    ];
    alt.surface.dispatchEvent(
      touchEvent('touchstart', [
        { clientX: 10, clientY: 100 },
        { clientX: 20, clientY: 100 },
      ]),
    );
    alt.surface.dispatchEvent(touchEvent('touchmove', pinch()));
    expect(alt.deltas).toEqual([]);
    const normal = setup('normal');
    normal.surface.dispatchEvent(
      touchEvent('touchstart', [
        { clientX: 10, clientY: 100 },
        { clientX: 20, clientY: 100 },
      ]),
    );
    normal.surface.dispatchEvent(touchEvent('touchmove', pinch()));
    expect(normal.lines).toEqual([]);
  });

  it('жест с ползунка скроллбара xterm отдаём библиотеке — двойного скролла нет', () => {
    const { slider, lines } = setup('normal');
    // Ползунок тащится на pointer-событиях (их наш preventDefault не отменяет): если бы
    // мы ещё и скроллили сами, вьюпорт уехал бы вдвое.
    slider.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    slider.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 140 }]));
    expect(lines).toEqual([]);
  });

  it('teardown снимает слушатели', () => {
    const { surface, deltas, lines, off } = setup('alternate');
    off();
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 140 }]));
    expect(deltas).toEqual([]);
    expect(lines).toEqual([]);
  });
});
