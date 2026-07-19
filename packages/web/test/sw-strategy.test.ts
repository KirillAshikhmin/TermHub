import { describe, expect, it } from 'vitest';

import { pickStrategy } from '../src/sw-strategy';

const u = (path: string): URL => new URL(`https://host${path}`);

describe('pickStrategy', () => {
  it('навигация (mode=navigate) → network-first', () => {
    expect(pickStrategy(u('/'), 'navigate')).toBe('network-first');
    expect(pickStrategy(u('/some/deep/route'), 'navigate')).toBe('network-first');
  });

  it('корень и index.html при прямом GET → network-first', () => {
    expect(pickStrategy(u('/'), 'cors')).toBe('network-first');
    expect(pickStrategy(u('/index.html'), 'no-cors')).toBe('network-first');
  });

  it('хэш-ассеты /assets/* → cache-first', () => {
    expect(pickStrategy(u('/assets/main-DmXUF01w.js'), 'cors')).toBe('cache-first');
    expect(pickStrategy(u('/assets/main-CR_orOgF.css'), 'no-cors')).toBe('cache-first');
  });

  it('прочая статика того же origin → cache-first', () => {
    expect(pickStrategy(u('/manifest.webmanifest'), 'cors')).toBe('cache-first');
    expect(pickStrategy(u('/icon.svg'), 'no-cors')).toBe('cache-first');
  });

  it('/api/* → network-only (без кэша)', () => {
    expect(pickStrategy(u('/api/push/subscribe'), 'cors')).toBe('network-only');
  });

  it('/api/* остаётся network-only даже при mode=navigate (не HTML)', () => {
    expect(pickStrategy(u('/api/whatever'), 'navigate')).toBe('network-only');
  });

  it('/ws/* → passthrough (SW не проксирует сокеты), приоритетнее всего', () => {
    expect(pickStrategy(u('/ws/term'), 'websocket')).toBe('passthrough');
    expect(pickStrategy(u('/ws/term'), 'navigate')).toBe('passthrough');
  });
});
