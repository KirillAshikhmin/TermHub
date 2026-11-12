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

describe('живая часть чата', () => {
  it('кнопка варианта вопроса — не ниже 44 px; окошко терминала без hidden виден, с hidden — нет', () => {
    const opt = el('button', 'th-live-q__opt', chat);
    expect(getComputedStyle(opt).minHeight).toBe('44px');
    const win = el('div', 'th-chat-term', chat);
    expect(getComputedStyle(win).display).toBe('flex');
    win.hidden = true;
    expect(getComputedStyle(win).display).toBe('none');
  });
});

describe('окно терминала — в границах области чата', () => {
  const shell = (): { area: HTMLElement; win: HTMLElement; term: HTMLElement } => {
    const area = el('main', 'th-chat');
    document.body.append(area);
    const slot = el('div', 'th-chat__slot th-chat__slot--terminal', area);
    const win = el('div', 'th-chat-term', slot);
    el('div', 'th-chat-term__head', win);
    const body = el('div', 'th-chat-term__body', win);
    const term = el('div', 'th-term', body);
    return { area, win, term };
  };

  it('окно привязано к области чата, а не к окну браузера; терминал внутри не fixed и не во весь экран', () => {
    const { area, win, term } = shell();
    expect(getComputedStyle(area).position).toBe('relative');
    expect(getComputedStyle(win).position).toBe('absolute');
    expect(getComputedStyle(win.parentElement!).position).not.toMatch(/relative|absolute|fixed/);
    expect(getComputedStyle(term).position).toBe('relative');
    expect(getComputedStyle(term).height).not.toBe('100dvh');
    expect(getComputedStyle(term).width).not.toBe('100%');
  });

  it('кнопка закрытия — не меньше 44 px', () => {
    const { win } = shell();
    const close = el('button', 'th-chat-term__close', win.querySelector<HTMLElement>('.th-chat-term__head')!);
    expect(getComputedStyle(close).minWidth).toBe('44px');
    expect(getComputedStyle(close).minHeight).toBe('44px');
  });
});

describe('переписка по ширине и параметры вида', () => {
  const area = (): HTMLElement => {
    const root = el('main', 'th-chat');
    document.body.append(root);
    root.append(chat);
    return root;
  };

  it('колонка переписки не ограничена по ширине и не центрируется; плашка человека остаётся справа', () => {
    area();
    for (const cls of ['th-feed__items', 'th-feed__local-list']) {
      const col = el('div', cls, chat);
      expect(getComputedStyle(col).maxWidth, cls).toMatch(/^(none|)$/);
      expect(getComputedStyle(col).marginLeft, cls).not.toBe('auto');
      expect(getComputedStyle(col).marginRight, cls).not.toBe('auto');
    }
    const human = el('div', 'th-feed__entry th-feed__entry--human', chat);
    expect(getComputedStyle(human).alignSelf).toBe('flex-end');
  });

  it('размер, семейство и интервал берутся из переменных области чата', () => {
    const root = area();
    root.style.setProperty('--chat-fs', '18px');
    root.style.setProperty('--chat-input-fs', '19px');
    root.style.setProperty('--chat-mono', 'Menlo, monospace');
    root.style.setProperty('--chat-font', 'Menlo, sans-serif');
    const text = el('div', 'th-feed__text', el('div', 'th-feed__entry th-feed__entry--agent', chat));
    const code = el('code', 'th-md__code', text);
    const q = el('div', 'th-live-q', root);
    const qBody = el('pre', 'th-live-q__body', q);
    const out = el('pre', 'th-tool__output', chat);
    const field = el('textarea', 'th-composer__field', el('div', 'th-composer', root));
    expect(getComputedStyle(text).fontSize).toBe('18px');
    expect(getComputedStyle(code).fontSize).toBe('18px');
    expect(getComputedStyle(q).fontSize).toBe('18px');
    expect(getComputedStyle(out).fontSize).toBe('18px');
    expect(getComputedStyle(field).fontSize).toBe('19px');
    expect(getComputedStyle(root).fontFamily).toBe('Menlo, sans-serif');
    for (const node of [code, qBody, out]) expect(getComputedStyle(node).fontFamily).toBe('Menlo, monospace');
    expect(css).toMatch(/\.th-feed--chat \.th-feed__text \{[^}]*line-height: calc\(1\.5 \* var\(--chat-lh, 1\)\)/);
  });

  it('фон области чата — фон терминала: контрастный выбор его меняет', () => {
    const root = area();
    const soft = getComputedStyle(root).backgroundColor;
    document.documentElement.dataset.termBg = 'contrast';
    const contrast = getComputedStyle(root).backgroundColor;
    delete document.documentElement.dataset.termBg;
    // светлая палитра (happy-dom): --term-bg и --term-bg-contrast
    expect(soft).toBe('#f0f2f5');
    expect(contrast).toBe('#ffffff');
  });

  it('лента без чата переменных вида не слушает', () => {
    const plain = el('main', 'th-feed');
    document.body.append(plain);
    plain.style.setProperty('--chat-fs', '18px');
    const text = el('div', 'th-feed__text', plain);
    expect(getComputedStyle(text).fontSize).toBe('14.4px'); // 0.9rem ленты
  });
});
