import { describe, expect, it } from 'vitest';

import { dictionaries } from '../src/i18n';

/** Рекурсивно собирает все пути-ключи словаря вида "a.b.c". */
function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') out.push(...flatKeys(value as Record<string, unknown>, path));
    else out.push(path);
  }
  return out;
}

describe('i18n словари', () => {
  it('ru и en имеют идентичный набор ключей', () => {
    const ru = flatKeys(dictionaries.ru).sort();
    const en = flatKeys(dictionaries.en).sort();
    expect(ru).toEqual(en);
  });

  it('все значения — непустые строки', () => {
    for (const lang of ['ru', 'en'] as const) {
      for (const key of flatKeys(dictionaries[lang])) {
        const value = key
          .split('.')
          .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], dictionaries[lang]);
        expect(typeof value, `${lang}.${key}`).toBe('string');
        expect((value as string).length, `${lang}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
