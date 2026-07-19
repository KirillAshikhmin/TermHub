// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { setLang, t } from '../src/i18n';
import { keyBytes, mountQuickKeys, SEND_KEYS } from '../src/quickkeys';

/** Эталон id → байты, которые кнопка обязана отправить в pty. */
const EXPECTED: Record<string, number[]> = {
  esc: [0x1b],
  tab: [0x09],
  shiftTab: [0x1b, 0x5b, 0x5a],
  left: [0x1b, 0x5b, 0x44],
  up: [0x1b, 0x5b, 0x41],
  down: [0x1b, 0x5b, 0x42],
  right: [0x1b, 0x5b, 0x43],
  enter: [0x0d],
  ctrlC: [0x03],
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

describe('quickkeys — чекбокс клавиатуры', () => {
  const handlers = (over: Partial<Parameters<typeof mountQuickKeys>[0]> = {}) => ({
    onKey: () => {},
    onFontStep: () => {},
    onKeyboardToggle: () => {},
    keyboardEnabled: true,
    onSelectToggle: () => {},
    onComposeToggle: () => {},
    composeEnabled: false,
    onSearch: () => {},
    selectEnabled: false,
    onEnterSendsToggle: () => {},
    enterSendsEnabled: true,
    t,
    ...over,
  });

  // Клавиатурный тумблер — не выделение (th-qk__select) и не «Отправлять по Enter» (th-qk__enter).
  const keyboardToggle = (panel: HTMLElement) =>
    panel.querySelector<HTMLButtonElement>(
      '.th-qk__toggle:not(.th-qk__select):not(.th-qk__enter):not(.th-qk__compose)',
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
    onFontStep: () => {},
    onKeyboardToggle: () => {},
    keyboardEnabled: true,
    onSelectToggle: () => {},
    onComposeToggle: () => {},
    composeEnabled: false,
    onSearch: () => {},
    selectEnabled: false,
    onEnterSendsToggle: () => {},
    enterSendsEnabled: true,
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

  it('тумблер «Отправлять по Enter» зовёт onEnterSendsToggle с инвертированным состоянием', () => {
    setLang('ru');
    const onEnterSendsToggle = vi.fn();
    const panel = mountQuickKeys(handlers({ enterSendsEnabled: true, onEnterSendsToggle }));
    const toggle = panel.querySelector<HTMLButtonElement>('.th-qk__enter')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(onEnterSendsToggle).toHaveBeenCalledWith(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });
});
