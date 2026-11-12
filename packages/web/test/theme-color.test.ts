// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initTheme, setThemeChoice } from '../src/theme';

function withOverlay(on: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: on && query.includes('window-controls-overlay'),
    addEventListener: () => undefined,
  }));
  window.matchMedia = globalThis.matchMedia;
}

function color(): string | null {
  return document.querySelector('meta[name="theme-color"]')!.getAttribute('content');
}

describe('theme-color', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('в обычном окне — цвет фона, в окне без заголовка браузера — цвет шапки', () => {
    document.head.innerHTML = '<meta name="theme-color" content="">';
    withOverlay(false);
    initTheme();
    setThemeChoice('dark');
    expect(color()).toBe('#0d1117');
    withOverlay(true);
    setThemeChoice('dark');
    expect(color()).toBe('#161b22');
    setThemeChoice('light');
    expect(color()).toBe('#ffffff');
  });
});
