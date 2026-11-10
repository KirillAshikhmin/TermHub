// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { initTermPrefs, onTermPrefsChange, readTermPrefs, setTermPrefs } from '../src/term-prefs';
import { openTermSettings } from '../src/term-settings';

describe('term prefs', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.termBg;
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
    setTermPrefs({ bg: 'dark' });
    expect(document.documentElement.dataset.termBg).toBe('dark');
    delete document.documentElement.dataset.termBg;
    initTermPrefs();
    expect(document.documentElement.dataset.termBg).toBe('dark');
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
    segments[1]!.querySelectorAll<HTMLButtonElement>('.th-segment__btn')[1]!.click();
    expect(readTermPrefs().bg).toBe('dark');
  });
});
