// @vitest-environment happy-dom
// Правила CSS ленты, которые проверяются каскадом, а не структурой DOM: механику
// разметки проверяют feed-screen.test.ts и feed-search.test.ts, здесь — сами
// правила theme.css. Приём тот же, что и в term-touch-css.test.ts: реальный текст
// таблицы стилей грузится в <style>, дальше решает браузер (в happy-dom — его
// движок каскада), а не наши ожидания о том, что должно быть написано в файле.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const themeCss = fs.readFileSync(path.join(here, '../src/theme.css'), 'utf8');

function loadTheme(): void {
  const style = document.createElement('style');
  style.textContent = themeCss;
  document.head.append(style);
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

beforeEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  loadTheme();
});

describe('строка вызова инструмента', () => {
  it('не переносится: длинное обрезается многоточием, а не растягивает ленту', () => {
    const row = el('div', 'th-feed__entry th-feed__entry--tool');
    const text = el('span', 'th-feed__tooltext');
    text.textContent = 'cd apps && git add -A && git commit -q -F - <<EOF';
    row.append(text);
    document.body.append(row);

    const style = getComputedStyle(text);
    expect(style.whiteSpace).toBe('nowrap');
    expect(style.overflow).toBe('hidden');
    expect(style.textOverflow).toBe('ellipsis');
  });
});

describe('отметка записи, к которой перенесли ленту', () => {
  it('меняет фон агента, а не только тонкую рамку — иначе вспышку не отличить от соседей', () => {
    const plain = el('div', 'th-feed__entry th-feed__entry--agent');
    const hit = el('div', 'th-feed__entry th-feed__entry--agent is-hit');
    document.body.append(plain, hit);

    const plainBg = getComputedStyle(plain).backgroundColor;
    const hitBg = getComputedStyle(hit).backgroundColor;
    expect(hitBg).not.toBe(plainBg);
  });

  it('на реплике человека отличается от её же акцентного фона — тем же фоном подсветку не заметить', () => {
    // Живьём терялась именно здесь: у .th-feed__entry--human свой фон
    // var(--accent-tint), той же бирюзы, что и у отметки — сравнение с агентом
    // (фон которого — нейтральный --bg-elev) этот случай не проверяет вовсе.
    const plain = el('div', 'th-feed__entry th-feed__entry--human');
    const hit = el('div', 'th-feed__entry th-feed__entry--human is-hit');
    document.body.append(plain, hit);

    const plainBg = getComputedStyle(plain).backgroundColor;
    const hitBg = getComputedStyle(hit).backgroundColor;
    expect(hitBg).not.toBe(plainBg);
  });
});

describe('разметка ответа агента', () => {
  it('перевод строки внутри абзаца сохраняется, хотя у самой разметки его нет', () => {
    // Запись держит pre-wrap ради сырого текста; у нарисованной разметки он снят,
    // иначе отступы markdown превратились бы в пустоты. Абзацу он возвращается.
    const text = el('div', 'th-feed__text th-feed__md');
    const p = document.createElement('p');
    text.append(p);
    document.body.append(text);

    expect(getComputedStyle(text).whiteSpace).toBe('normal');
    expect(getComputedStyle(p).whiteSpace).toBe('pre-wrap');
  });

  it('блок кода прокручивается сам и не переносит строку', () => {
    const pre = el('pre', 'th-md__pre');
    const code = el('code', 'th-md__code');
    pre.append(code);
    document.body.append(pre);

    expect(getComputedStyle(pre).overflowX).toBe('auto');
    expect(getComputedStyle(code).whiteSpace).toBe('pre');
  });

  it('широкая таблица едет в своей обёртке, а не растягивает ленту', () => {
    const wrap = el('div', 'th-md__tablewrap');
    document.body.append(wrap);

    const style = getComputedStyle(wrap);
    expect(style.overflowX).toBe('auto');
    expect(style.maxWidth).toBe('100%');
  });
});
