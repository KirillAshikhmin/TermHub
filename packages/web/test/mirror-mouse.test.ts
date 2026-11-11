// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { correctMirrorMouse, unscale } from '../src/mirror-mouse';

let screen: HTMLElement;
let cell: HTMLElement;
let scale = 0.5;
let off: () => void;
let seen: Array<{ type: string; x: number; y: number }>;

beforeEach(() => {
  document.body.replaceChildren();
  screen = document.createElement('div');
  cell = document.createElement('span');
  screen.append(cell);
  document.body.append(screen);
  // Экран зеркала стоит в (100, 50) — уже с масштабом, как его видит браузер.
  screen.getBoundingClientRect = () => ({ left: 100, top: 50, right: 500, bottom: 250, width: 400, height: 200, x: 100, y: 50, toJSON: () => ({}) });
  scale = 0.5;
  seen = [];
  for (const type of WATCHED) document.addEventListener(type, note);
  off = correctMirrorMouse(() => screen, () => scale);
});

afterEach(() => {
  off();
  for (const type of WATCHED) document.removeEventListener(type, note);
});

const WATCHED = ['mousedown', 'mousemove', 'mouseup', 'click'];
function note(e: Event): void {
  const m = e as MouseEvent;
  seen.push({ type: m.type, x: m.clientX, y: m.clientY });
}

const fire = (target: EventTarget, type: string, x: number, y: number): boolean =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));

describe('мышь в зеркале', () => {
  it('расстояние от края экрана делится на масштаб', () => {
    expect(unscale(150, 100, 0.5)).toBe(200);
    expect(unscale(100, 100, 0.5)).toBe(100);
    expect(unscale(130, 100, 1)).toBe(130);
  });

  it('событие над зеркалом доходит до слушателей один раз и с пересчитанными координатами', () => {
    fire(cell, 'mousedown', 150, 100);
    expect(seen).toEqual([{ type: 'mousedown', x: 200, y: 150 }]);
  });

  it('без масштаба события не трогаются', () => {
    scale = 1;
    fire(cell, 'click', 150, 100);
    expect(seen).toEqual([{ type: 'click', x: 150, y: 100 }]);
  });

  it('мимо зеркала события идут как есть', () => {
    fire(document.body, 'click', 30, 30);
    expect(seen).toEqual([{ type: 'click', x: 30, y: 30 }]);
  });

  it('протяжка, начатая над зеркалом, пересчитывается и за его пределами — до отпускания', () => {
    fire(cell, 'mousedown', 120, 60);
    fire(document.body, 'mousemove', 300, 400);
    fire(document.body, 'mouseup', 300, 400);
    fire(document.body, 'mousemove', 300, 400);
    expect(seen).toEqual([
      { type: 'mousedown', x: 140, y: 70 },
      { type: 'mousemove', x: 500, y: 750 },
      { type: 'mouseup', x: 500, y: 750 },
      { type: 'mousemove', x: 300, y: 400 },
    ]);
  });

  it('отмена действия по умолчанию обработчиком остаётся у настоящего события', () => {
    cell.addEventListener('mousedown', (e) => e.preventDefault());
    expect(fire(cell, 'mousedown', 150, 100)).toBe(false);
  });

  it('после выключения события не пересчитываются', () => {
    off();
    fire(cell, 'click', 150, 100);
    expect(seen).toEqual([{ type: 'click', x: 150, y: 100 }]);
  });
});
