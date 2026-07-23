// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { enableTouchScroll } from '../src/touch-scroll';

/** Синтетическое touch-событие с массивом touches (happy-dom не строит TouchEvent). */
function touchEvent(type: string, points: Array<{ clientX: number; clientY: number }>): Event {
  const ev = new Event(type, { cancelable: true, bubbles: true }) as Event & {
    touches: unknown;
    changedTouches: unknown;
  };
  ev.touches = points;
  ev.changedTouches = points;
  return ev;
}

/** term-мок: element с .xterm-viewport + тип активного буфера (normal/alternate). */
function setup(bufferType: 'normal' | 'alternate' = 'alternate'): {
  surface: HTMLElement;
  viewport: HTMLElement;
  deltas: number[];
  off: () => void;
} {
  const surface = document.createElement('div');
  const root = document.createElement('div');
  const viewport = document.createElement('div');
  viewport.className = 'xterm-viewport';
  root.append(viewport);
  const deltas: number[] = [];
  root.addEventListener('wheel', (e) => deltas.push((e as WheelEvent).deltaY));
  const term = { element: root, buffer: { active: { type: bufferType } } };
  const off = enableTouchScroll(surface, term);
  return { surface, viewport, deltas, off };
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
});

describe('enableTouchScroll — обычный экран (локальный буфер xterm, без relay)', () => {
  it('драг листает viewport.scrollTop локально, wheel НЕ шлём', () => {
    const { surface, viewport, deltas } = setup('normal');
    viewport.scrollTop = 100;
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 140 }])); // палец вниз 40 → dy=-40
    expect(viewport.scrollTop).toBe(60); // 100 + (-40): к истории
    expect(deltas).toEqual([]); // ничего через relay
  });

  it('драг ВВЕРХ → viewport.scrollTop растёт (к концу)', () => {
    const { surface, viewport } = setup('normal');
    viewport.scrollTop = 100;
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 70 }])); // палец вверх 30 → dy=30
    expect(viewport.scrollTop).toBe(130);
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

  it('мультитач (пинч) игнорируется — ни wheel, ни локальный скролл', () => {
    const { surface, viewport, deltas } = setup('alternate');
    viewport.scrollTop = 100;
    surface.dispatchEvent(
      touchEvent('touchstart', [
        { clientX: 10, clientY: 100 },
        { clientX: 20, clientY: 100 },
      ]),
    );
    surface.dispatchEvent(
      touchEvent('touchmove', [
        { clientX: 10, clientY: 140 },
        { clientX: 20, clientY: 140 },
      ]),
    );
    expect(deltas).toEqual([]);
    expect(viewport.scrollTop).toBe(100);
  });

  it('teardown снимает слушатели', () => {
    const { surface, deltas, off } = setup('alternate');
    off();
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 140 }]));
    expect(deltas).toEqual([]);
  });
});
