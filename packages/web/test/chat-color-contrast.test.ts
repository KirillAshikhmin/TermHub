// Контраст новых красок чата с фонами чата — расчётом по значениям переменных theme.css
// (тёмная тема, светлая по prefers и светлая по ручному переключателю). Порог 4.5.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/theme.css'), 'utf8');

/** Тело блока правил по его заголовку (первые фигурные скобки после него). */
function block(head: string): Record<string, string> {
  const from = css.indexOf(head);
  expect(from, head).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', from);
  const close = css.indexOf('\n  }', open) > 0 && head.startsWith('  ') ? css.indexOf('\n  }', open) : css.indexOf('\n}', open);
  const vars: Record<string, string> = {};
  for (const m of css.slice(open, close).matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) vars[m[1]!] = m[2]!;
  return vars;
}

const lum = (hex: string): number => {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
};
const ratio = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const NEW = [
  '--syn-cmd', '--syn-flag', '--syn-string', '--syn-op', '--syn-var',
  '--st-ok', '--st-run', '--st-fail', '--st-stop',
  '--md-strong', '--md-em', '--md-quote', '--md-code', '--md-link',
  ...Array.from({ length: 8 }, (_, i) => `--ansi-${i}`),
];
/** Фоны, на которых бывает текст чата: переписка, панель действия, код, наведение. */
const GROUNDS = ['--bg', '--bg-elev', '--bg-elev-2', '--bg-hover'];

const THEMES: Array<[string, Record<string, string>]> = [
  ['тёмная', block(':root {')],
  ['светлая по prefers', block('  :root:not([data-theme]) {')],
  ['светлая по переключателю', block(":root[data-theme='light'] {")],
];

describe('контраст красок чата ≥ 4.5', () => {
  for (const [name, vars] of THEMES) {
    it(`${name}: каждая новая краска на каждом фоне чата`, () => {
      for (const v of NEW) expect(vars[v], `${v} задана`).toBeDefined();
      const low: string[] = [];
      for (const v of NEW)
        for (const g of GROUNDS) {
          const r = ratio(vars[v]!, vars[g]!);
          if (r < 4.5) low.push(`${v} на ${g}: ${r.toFixed(2)}`);
        }
      expect(low).toEqual([]);
    });
  }

  it('светлые значения совпадают в обоих светлых блоках, а жёстких цветов у новых правил нет', () => {
    expect(THEMES[1]![1]).toMatchObject(Object.fromEntries(NEW.map((v) => [v, THEMES[2]![1][v]])));
    const rules = css.slice(css.indexOf('/* Цвет в чате (G30)'), css.indexOf('.th-diff__line.is-add {'));
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
