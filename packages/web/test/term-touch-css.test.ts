// @vitest-environment happy-dom
// Правила жеста и прокрутки терминала. Механику драга проверяет touch-scroll.test.ts —
// здесь проверяются САМИ CSS-правила: браузер решает судьбу касания по элементу под
// пальцем, а не по тому, кто слушает touchmove. Слой, у которого touch-action остался
// auto, отдаёт жест браузеру: тот панорамирует страницу, за visualViewport уезжает весь
// фиксированный экран (screen.style.transform в term.ts) — вместе с вкладками сессий и
// панелью клавиш, которым ехать нельзя.
//
// Поэтому перечислять классы библиотеки в CSS нельзя: xterm 6 уже завёл обёртку
// .xterm-scrollable-element, а под пальцем у WebGL-рендерера вообще <canvas> — любое
// обновление добавляет новый слой, и дыра открывается заново. Тест держит это условие:
// в поддереве есть слой с классом, которого тема не знает, и он обязан быть погашен.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

// Пути — через path: глобальный URL здесь happy-dom'овский, и fs его не принимает.
const here = path.dirname(fileURLToPath(import.meta.url));
const themeCss = fs.readFileSync(path.join(here, '../src/theme.css'), 'utf8');
const xtermCss = fs.readFileSync(createRequire(import.meta.url).resolve('@xterm/xterm/css/xterm.css'), 'utf8');

/** Значения overflow, которые делают элемент нативным скролл-контейнером. */
const SCROLLABLE = new Set(['auto', 'scroll', 'overlay']);

/** Обе таблицы в ТОМ ЖЕ порядке, что и в бандле: main.ts импортирует theme.css первым,
 *  xterm.css приезжает следом (из term.ts). Значит при равной специфичности выигрывают
 *  правила библиотеки — тест ловит это ровно так же, как браузер. */
function loadStyles(): void {
  for (const css of [themeCss, xtermCss]) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
  }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Поддерево терминала внутри хоста — как его строит xterm 6: .xterm-viewport остался
 *  пустым слоем от xterm 5, содержимое переехало в вендоренную из vscode обёртку
 *  .xterm-scrollable-element (там же ползунок), служебный textarea живёт в .xterm-helpers
 *  внутри .xterm-screen, а рисует WebGL-рендерер в <canvas>. Плюс слой с неизвестным
 *  классом — за следующую версию библиотеки. */
function mountTerminal(): HTMLElement {
  const screenRoot = el('div', 'th-term');
  const body = el('div', 'th-term__body');
  const host = el('div', 'th-term__host');

  const xterm = el('div', 'terminal xterm');
  const viewport = el('div', 'xterm-viewport');
  const scrollable = el('div', 'xterm-scrollable-element');
  const screen = el('div', 'xterm-screen');
  const helpers = el('div', 'xterm-helpers');
  helpers.append(el('textarea', 'xterm-helper-textarea'), el('div', 'xterm-char-measure-element'));
  screen.append(helpers, el('style', ''), el('canvas', ''), el('div', 'xterm-rows'));
  const bar = el('div', 'visible scrollbar vertical');
  bar.append(el('div', 'slider'));
  scrollable.append(screen, bar);
  xterm.append(
    el('canvas', 'xterm-decoration-overview-ruler'),
    viewport,
    scrollable,
    el('div', 'xterm-accessibility'),
    el('div', 'xterm-layer-from-a-future-version'),
  );

  host.append(xterm);
  body.append(host);
  screenRoot.append(body);
  document.body.append(screenRoot);
  return host;
}

/** Селекторы правил таблицы, объявляющих элемент нативным скролл-контейнером. */
function scrollContainerSelectors(css: string): string[] {
  const out: string[] = [];
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = rule[2] ?? '';
    if (/overflow(-x|-y)?\s*:\s*(auto|scroll|overlay)/.test(decls)) out.push((rule[1] ?? '').trim());
  }
  return out;
}

/** Имя слоя для внятного сообщения о падении. */
function name(node: Element): string {
  return node.className ? `.${node.className.split(' ').join('.')}` : node.tagName.toLowerCase();
}

describe('правила терминала: жест и прокрутка внутри хоста', () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    loadStyles();
    host = mountTerminal();
  });

  it('жест браузеру не отдаётся ни на одном слое внутри хоста, включая незнакомые теме', () => {
    const loose = [...host.querySelectorAll('*')]
      .filter((node) => getComputedStyle(node).touchAction !== 'none')
      .map(name);
    expect(loose).toEqual([]);
  });

  it('сам хост тоже гасит жест — касание мимо слоёв библиотеки не уводит страницу', () => {
    expect(getComputedStyle(host).touchAction).toBe('none');
  });

  it('внутри хоста нет нативного скролл-контейнера — двигается только буфер xterm', () => {
    const scrollers = [...host.querySelectorAll('*')]
      .filter((node) => {
        const style = getComputedStyle(node);
        return SCROLLABLE.has(style.overflowX) || SCROLLABLE.has(style.overflowY);
      })
      .map(name);
    expect(scrollers).toEqual([]);
  });

  it('ползунок библиотеки остаётся кликабельным — этот жест мы намеренно отдаём ей', () => {
    const slider = host.querySelector('.scrollbar > .slider');
    expect(slider).not.toBeNull();
    const style = getComputedStyle(slider as Element);
    expect(style.pointerEvents).not.toBe('none');
    expect(style.display).not.toBe('none');
  });

  it('библиотека объявляет нативную прокрутку только на вьюпорте (новый слой уронит тест)', () => {
    expect(scrollContainerSelectors(xtermCss)).toEqual(['.xterm .xterm-viewport']);
  });
});
