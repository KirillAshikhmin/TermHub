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

function setup(): { surface: HTMLElement; target: HTMLElement; deltas: number[]; off: () => void } {
  const surface = document.createElement('div');
  const target = document.createElement('div');
  const deltas: number[] = [];
  target.addEventListener('wheel', (e) => deltas.push((e as WheelEvent).deltaY));
  const off = enableTouchScroll(surface, target);
  return { surface, target, deltas, off };
}

describe('enableTouchScroll', () => {
  it('драг пальцем ВНИЗ → wheel вверх (deltaY<0), скролл к истории', () => {
    const { surface, deltas } = setup();
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 140 }])); // палец вниз 40px
    expect(deltas).toEqual([-40]);
  });

  it('драг пальцем ВВЕРХ → wheel вниз (deltaY>0)', () => {
    const { surface, deltas } = setup();
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 70 }])); // палец вверх 30px
    expect(deltas).toEqual([30]);
  });

  it('несколько последовательных move аккумулируют относительно предыдущей точки', () => {
    const { surface, deltas } = setup();
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 120 }])); // -20
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 150 }])); // -30
    expect(deltas).toEqual([-20, -30]);
  });

  it('touchmove гасит дефолт (нет скролла страницы / pull-to-refresh)', () => {
    const { surface } = setup();
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    const move = touchEvent('touchmove', [{ clientX: 10, clientY: 120 }]);
    surface.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
  });

  it('мультитач (пинч) игнорируется — wheel не шлём', () => {
    const { surface, deltas } = setup();
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
  });

  it('teardown снимает слушатели', () => {
    const { surface, deltas, off } = setup();
    off();
    surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]));
    surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 140 }]));
    expect(deltas).toEqual([]);
  });
});
