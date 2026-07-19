import { beforeEach, describe, expect, it } from 'vitest';

import { setLang, t } from '../src/i18n';
import { formatRelativeTime } from '../src/time';

const NOW = 1_700_000_000_000;

describe('formatRelativeTime (ru)', () => {
  beforeEach(() => setLang('ru'));

  it('только что для разницы < 60 с', () => {
    expect(formatRelativeTime(NOW - 10_000, t, NOW)).toBe('только что');
    expect(formatRelativeTime(NOW, t, NOW)).toBe('только что');
    expect(formatRelativeTime(NOW - 59_000, t, NOW)).toBe('только что');
  });

  it('минуты для разницы < 60 мин', () => {
    expect(formatRelativeTime(NOW - 60_000, t, NOW)).toBe('1 мин назад');
    expect(formatRelativeTime(NOW - 5 * 60_000, t, NOW)).toBe('5 мин назад');
    expect(formatRelativeTime(NOW - 59 * 60_000, t, NOW)).toBe('59 мин назад');
  });

  it('часы для разницы < 24 ч', () => {
    expect(formatRelativeTime(NOW - 60 * 60_000, t, NOW)).toBe('1 ч назад');
    expect(formatRelativeTime(NOW - 2 * 3_600_000, t, NOW)).toBe('2 ч назад');
  });

  it('дни для разницы ≥ 24 ч', () => {
    expect(formatRelativeTime(NOW - 24 * 3_600_000, t, NOW)).toBe('1 дн назад');
    expect(formatRelativeTime(NOW - 3 * 86_400_000, t, NOW)).toBe('3 дн назад');
  });

  it('будущее время трактуется как «только что»', () => {
    expect(formatRelativeTime(NOW + 5_000, t, NOW)).toBe('только что');
  });
});

describe('formatRelativeTime (en)', () => {
  beforeEach(() => setLang('en'));

  it('локализует единицы', () => {
    expect(formatRelativeTime(NOW - 10_000, t, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 5 * 60_000, t, NOW)).toBe('5 min ago');
    expect(formatRelativeTime(NOW - 2 * 3_600_000, t, NOW)).toBe('2 h ago');
  });
});
