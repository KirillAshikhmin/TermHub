// @vitest-environment happy-dom
// Правила theme.css чата, которые проверяются каскадом: плашка человека справа, ответ
// агента без плашки, подсветка находки заметна и в чате, diff цветом, пустые места
// оболочки не занимают высоты, переписка не растягивает страницу вширь.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/theme.css'), 'utf8');

function el(tag: string, cls: string, parent?: HTMLElement): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  parent?.append(node);
  return node;
}

let chat: HTMLElement;
beforeEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  chat = el('main', 'th-feed th-feed--chat');
  document.body.append(chat);
});

describe('переписка в чате', () => {
  it('реплика человека прижата вправо и не шире 85%, ответ агента — без фона и рамки', () => {
    const human = el('div', 'th-feed__entry th-feed__entry--human', chat);
    const agent = el('div', 'th-feed__entry th-feed__entry--agent', chat);
    expect(getComputedStyle(human).alignSelf).toBe('flex-end');
    expect(getComputedStyle(human).maxWidth).toBe('85%');
    expect(getComputedStyle(agent).backgroundColor).toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
    expect(getComputedStyle(agent).borderTopStyle).toBe('none');
  });

  it('подсветка находки в чате остаётся видимой — фон не прозрачный', () => {
    const hit = el('div', 'th-feed__entry th-feed__entry--agent is-hit', chat);
    expect(getComputedStyle(hit).backgroundColor).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
  });
});

describe('оболочка и действия', () => {
  it('пустое место оболочки не занимает высоты', () => {
    const slot = el('div', 'th-chat__slot th-chat__slot--composer');
    document.body.append(slot);
    expect(getComputedStyle(slot).display).toBe('none');
  });

  it('строки diff: добавленные и убранные различаются фоном', () => {
    const add = el('div', 'th-diff__line is-add');
    const del = el('div', 'th-diff__line is-del');
    const ctx = el('div', 'th-diff__line is-ctx');
    document.body.append(add, del, ctx);
    const bg = [add, del, ctx].map((n) => getComputedStyle(n).backgroundColor);
    expect(new Set(bg).size).toBe(3);
  });

  it('вывод действия прокручивается сам и не переносит строки', () => {
    const out = el('pre', 'th-tool__output');
    document.body.append(out);
    expect(getComputedStyle(out).overflow).toBe('auto');
    expect(getComputedStyle(out).whiteSpace).toBe('pre');
  });
});
