// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { setLang } from '../src/i18n';
import { filterPalette, fuzzyScore, openPalette, type PaletteItem } from '../src/palette';

describe('palette', () => {
  beforeEach(() => {
    setLang('ru');
    document.body.replaceChildren();
  });

  it('fuzzy: буквы по порядку, цельное вхождение лучше разбросанного', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('xyz', 'router')).toBeNull();
    expect(fuzzyScore('rtr', 'router')).not.toBeNull();
    expect(fuzzyScore('rout', 'router')!).toBeLessThan(fuzzyScore('rtr', 'router')!);
    expect(fuzzyScore('app', 'sprut_app')!).toBeLessThan(fuzzyScore('app', 'snapper')!);
  });

  it('поиск идёт и по подписи: имя сессии находит её по заголовку', () => {
    const items: PaletteItem[] = [
      { label: 'Scenarios', hint: 'sprut_app2', hash: '#/term/sprut_app2' },
      { label: 'router', hint: 'sprut_app7', hash: '#/term/sprut_app7' },
      { label: 'Файлы', hint: 'TermHub', hash: '#/sfiles/TermHub/' },
    ];
    expect(filterPalette(items, 'app7').map((i) => i.label)).toEqual(['router']);
    expect(filterPalette(items, '').length).toBe(3);
    expect(filterPalette(items, 'файл').map((i) => i.label)).toEqual(['Файлы']);
  });

  it('окно: набор фильтрует список, стрелки двигают выбор, пусто — подсказка', () => {
    openPalette([
      { label: 'alpha', hash: '#/term/alpha' },
      { label: 'beta', hash: '#/term/beta' },
    ]);
    const input = document.querySelector<HTMLInputElement>('.th-palette__input')!;
    const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.th-palette__row')];
    expect(rows().length).toBe(2);
    expect(rows()[0]!.classList.contains('is-active')).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(rows()[1]!.classList.contains('is-active')).toBe(true);
    input.value = 'bet';
    input.dispatchEvent(new Event('input'));
    expect(rows().map((r) => r.textContent)).toEqual(['beta']);
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    expect(rows().length).toBe(0);
    expect(document.querySelector('.th-palette__empty')).not.toBeNull();
  });
});
