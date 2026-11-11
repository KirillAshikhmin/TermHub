// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { setLang, t } from '../src/i18n';
import { HOLD_MS, keyBytes, mountQuickKeys, SEND_KEYS } from '../src/quickkeys';

/** Эталон id → байты, которые кнопка обязана отправить в pty. */
const EXPECTED: Record<string, number[]> = {
  esc: [0x1b],
  tab: [0x09],
  shiftTab: [0x1b, 0x5b, 0x5a],
  shiftLeft: [0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x44],
  left: [0x1b, 0x5b, 0x44],
  up: [0x1b, 0x5b, 0x41],
  down: [0x1b, 0x5b, 0x42],
  right: [0x1b, 0x5b, 0x43],
  enter: [0x0d],
  ctrlC: [0x03],
  shiftEnter: [0x1b, 0x0d],
};

describe('quickkeys — байт-последовательности', () => {
  it('каждая кнопка отправляет ровно ожидаемые байты', () => {
    for (const key of SEND_KEYS) {
      const expected = EXPECTED[key.id];
      expect(expected, `нет эталона для ${key.id}`).toBeDefined();
      expect([...keyBytes(key)], key.id).toEqual(expected);
    }
  });

  it('набор кнопок совпадает с эталоном (без пропусков и лишних)', () => {
    expect(SEND_KEYS.map((k) => k.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('у каждой кнопки непустая моноширинная подпись', () => {
    for (const key of SEND_KEYS) expect(key.glyph.length, key.id).toBeGreaterThan(0);
  });
});

describe('quickkeys — раскладка и удержание', () => {
  const base = {
    onKeyboardToggle: () => {},
    keyboardEnabled: true,
    onSelectToggle: () => {},
    onComposeToggle: () => {},
    composeEnabled: false,
    onSearch: () => {},
    selectEnabled: false,
    t,
  };

  it('первый ряд — Esc, Tab, ⇧Tab, стрелки и Enter справа; шрифта и отдельной ^C нет', () => {
    setLang('ru');
    const panel = mountQuickKeys({ ...base, onKey: () => {} });
    const row = [...panel.querySelectorAll('.th-qk__row--keys .th-qk__key')].map((b) =>
      [...b.classList].find((c) => c.startsWith('th-qk__key--'))!.replace('th-qk__key--', ''),
    );
    expect(row).toEqual(['esc', 'tab', 'shiftTab', 'shiftLeft', 'left', 'up', 'down', 'right', 'enter']);
    expect(panel.textContent).not.toContain('A+');
    // Выбор «Enter отправляет / переносит» уехал в настройки: тумблеров четыре.
    expect(panel.querySelectorAll('.th-qk__row--tools .th-qk__key').length).toBe(4);
    expect(panel.querySelector('.th-qk__enter')).toBeNull();
    expect(panel.querySelector('.th-qk__key--enter .th-qk__hold')!.textContent).toBe('⇧');
    expect(panel.querySelector('.th-qk__key--esc .th-qk__hold')!.textContent).toBe('^C');
    expect(panel.querySelector('.th-qk__key--tab')!.getAttribute('aria-label')).toBe('Tab');
  });

  it('тап по Esc шлёт Esc, удержание — Ctrl+C, и клик после удержания Esc не добавляет', () => {
    vi.useFakeTimers();
    const sent: number[][] = [];
    const panel = mountQuickKeys({ ...base, onKey: (b) => sent.push([...b]) });
    const esc = panel.querySelector<HTMLButtonElement>('.th-qk__key--esc')!;
    esc.dispatchEvent(new Event('pointerdown'));
    esc.dispatchEvent(new Event('pointerup'));
    esc.click();
    expect(sent).toEqual([[0x1b]]);
    esc.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(HOLD_MS + 1);
    esc.dispatchEvent(new Event('pointerup'));
    esc.click();
    expect(sent).toEqual([[0x1b], [0x03]]);
    // Enter: тап — отправка, удержание — перенос строки (ESC+CR).
    const enter = panel.querySelector<HTMLButtonElement>('.th-qk__key--enter')!;
    enter.click();
    enter.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(HOLD_MS + 1);
    enter.click();
    expect(sent.slice(2)).toEqual([[0x0d], [0x1b, 0x0d]]);
    vi.useRealTimers();
  });
});

describe('quickkeys — чекбокс клавиатуры', () => {
  const handlers = (over: Partial<Parameters<typeof mountQuickKeys>[0]> = {}) => ({
    onKey: () => {},
    onKeyboardToggle: () => {},
    keyboardEnabled: true,
    onSelectToggle: () => {},
    onComposeToggle: () => {},
    composeEnabled: false,
    onSearch: () => {},
    selectEnabled: false,
    t,
    ...over,
  });

  // Клавиатурный тумблер — не выделение (th-qk__select) и не строка ввода (th-qk__compose).
  const keyboardToggle = (panel: HTMLElement) =>
    panel.querySelector<HTMLButtonElement>(
      '.th-qk__toggle:not(.th-qk__select):not(.th-qk__compose)',
    )!;

  it('рендерит переключатель клавиатуры с aria-pressed по начальному состоянию', () => {
    setLang('ru');
    const onEmpty = mountQuickKeys(handlers({ keyboardEnabled: false }));
    const toggle = keyboardToggle(onEmpty);
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.classList.contains('is-off')).toBe(true);
  });

  it('клик по переключателю зовёт onKeyboardToggle с инвертированным состоянием и обновляет aria', () => {
    setLang('ru');
    const onKeyboardToggle = vi.fn();
    const panel = mountQuickKeys(handlers({ keyboardEnabled: true, onKeyboardToggle }));
    const toggle = keyboardToggle(panel);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(onKeyboardToggle).toHaveBeenCalledWith(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    expect(onKeyboardToggle).toHaveBeenLastCalledWith(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('quickkeys — выделение и копирование', () => {
  const handlers = (over: Partial<Parameters<typeof mountQuickKeys>[0]> = {}) => ({
    onKey: () => {},
    onKeyboardToggle: () => {},
    keyboardEnabled: true,
    onSelectToggle: () => {},
    onComposeToggle: () => {},
    composeEnabled: false,
    onSearch: () => {},
    selectEnabled: false,
    t,
    ...over,
  });

  it('тумблер выделения зовёт onSelectToggle с инвертированным состоянием', () => {
    setLang('ru');
    const onSelectToggle = vi.fn();
    const panel = mountQuickKeys(handlers({ selectEnabled: false, onSelectToggle }));
    const toggle = panel.querySelector<HTMLButtonElement>('.th-qk__select')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    expect(onSelectToggle).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('тумблер compose-строки зовёт onComposeToggle', () => {
    setLang('ru');
    const onComposeToggle = vi.fn();
    const panel = mountQuickKeys(handlers({ onComposeToggle }));
    const toggle = panel.querySelector<HTMLButtonElement>('.th-qk__compose')!;
    expect(toggle).not.toBeNull();
    toggle.click();
    expect(onComposeToggle).toHaveBeenCalledWith(true);
  });
});
