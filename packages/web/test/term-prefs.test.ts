// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { sessionAgent } from '../src/session-status';
import {
  initTermPrefs,
  onTermPrefsChange,
  readTermPrefs,
  setTermPrefs,
  termFontFamily,
  termIsLight,
} from '../src/term-prefs';
import { openTermSettings } from '../src/term-settings';

describe('term prefs', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const key of ['termBg', 'holoAuto']) delete document.documentElement.dataset[key];
    document.body.replaceChildren();
  });

  it('defaults to the soft background and tight spacing', () => {
    const prefs = readTermPrefs();
    expect(prefs.bg).toBe('soft');
    expect(prefs.lineHeight).toBe(1);
    expect(prefs.fontSize).toBeGreaterThanOrEqual(10);
  });

  it('clamps the font size and rejects unknown line heights', () => {
    expect(setTermPrefs({ fontSize: 99 }).fontSize).toBe(22);
    expect(readTermPrefs().fontSize).toBe(22);
    localStorage.setItem('termhub.lineHeight', '7');
    expect(readTermPrefs().lineHeight).toBe(1);
  });

  it('notifies subscribers until they unsubscribe', () => {
    const seen: number[] = [];
    const off = onTermPrefsChange((p) => seen.push(p.lineHeight));
    setTermPrefs({ lineHeight: 1.3 });
    off();
    setTermPrefs({ lineHeight: 1.15 });
    expect(seen).toEqual([1.3]);
  });

  it('marks the dark background on the root and restores it at start', () => {
    setTermPrefs({ bg: 'contrast' });
    expect(document.documentElement.dataset.termBg).toBe('contrast');
    delete document.documentElement.dataset.termBg;
    initTermPrefs();
    expect(document.documentElement.dataset.termBg).toBe('contrast');
    // Прежнее имя выбора, сохранённое до переименования, читается как контрастный.
    localStorage.setItem('termhub.termBg', 'dark');
    expect(readTermPrefs().bg).toBe('contrast');
    setTermPrefs({ bg: 'soft' });
    expect(document.documentElement.dataset.termBg).toBeUndefined();
  });

  it('settings window changes prefs on the spot', () => {
    setTermPrefs({ fontSize: 12 });
    openTermSettings();
    const steps = document.querySelectorAll<HTMLButtonElement>('.th-termview__step');
    steps[1]!.click();
    expect(readTermPrefs().fontSize).toBe(13);
    expect(document.querySelector('.th-termview__value')!.textContent).toBe('13 px');
    const segments = document.querySelectorAll('.th-termview .th-segment');
    // Порядок сегментов: интервал, тема, фон, полоса разделов.
    segments[2]!.querySelectorAll<HTMLButtonElement>('.th-segment__btn')[1]!.click();
    expect(readTermPrefs().bg).toBe('contrast');
    const font = document.querySelector<HTMLSelectElement>('.th-termview__select')!;
    font.value = 'jetbrains';
    font.dispatchEvent(new Event('change'));
    expect(readTermPrefs().font).toBe('jetbrains');
  });

  it('theme choice in the window switches the whole app, not just the terminal', () => {
    openTermSettings();
    const theme = document.querySelectorAll('.th-termview .th-segment')[1]!;
    theme.querySelectorAll<HTMLButtonElement>('.th-segment__btn')[2]!.click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(termIsLight()).toBe(true);
    theme.querySelectorAll<HTMLButtonElement>('.th-segment__btn')[1]!.click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(termIsLight()).toBe(false);
  });

  it('puts the chosen font ahead of the base stack and ignores unknown ones', () => {
    expect(termFontFamily('system', 'monospace')).toBe('monospace');
    expect(termFontFamily('jetbrains', 'monospace')).toBe("'JetBrains Mono', monospace");
    localStorage.setItem('termhub.termFont', 'comic');
    expect(readTermPrefs().font).toBe('system');
  });

  it('auto-hide of the section bar is a root attribute', () => {
    setTermPrefs({ holoAuto: true });
    expect('holoAuto' in document.documentElement.dataset).toBe(true);
    setTermPrefs({ holoAuto: false });
    expect('holoAuto' in document.documentElement.dataset).toBe(false);
  });

  it('recognises the agent by the pane command', () => {
    expect(sessionAgent('2.1.317')).toBe('claude');
    expect(sessionAgent('claude')).toBe('claude');
    expect(sessionAgent('codex')).toBe('codex');
    expect(sessionAgent('opencode')).toBe('opencode');
    expect(sessionAgent('zsh')).toBeNull();
    expect(sessionAgent('node')).toBeNull();
  });
});
