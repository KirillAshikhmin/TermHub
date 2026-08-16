// Правило разбора pane_title. Ключевое здесь — что оно НЕ привязано к конкретным
// глифам: Claude Code уже менял спиннер (брайль → половинки круга), и следующая
// смена не должна снова ломать индикатор активности.

import { describe, expect, it } from 'vitest';

import {
  sessionManaged,
  sessionTitleText,
  sessionWaiting,
  sessionWorking,
  titleIndicator,
} from '../src/session-title.js';

const BRAILLE = '⠂'; // ⠂ — прежний спиннер
const HALF_LEFT = '◐'; // ◐ — нынешний
const HALF_RIGHT = '◑'; // ◑
const WAITING = '✳'; // ✳

describe('session-title — прежний брайлевый спиннер', () => {
  it('распознаётся как работа, текст очищается', () => {
    const title = `${BRAILLE} Рефакторинг`;
    expect(sessionWorking(title)).toBe(true);
    expect(sessionManaged(title)).toBe(true);
    expect(sessionTitleText(title)).toBe('Рефакторинг');
  });
});

describe('session-title — новые половинки круга', () => {
  it('◐ и ◑ считаются работой', () => {
    for (const g of [HALF_LEFT, HALF_RIGHT, '◒', '◓']) {
      const title = `${g} Сборка`;
      expect(sessionWorking(title)).toBe(true);
      expect(sessionTitleText(title)).toBe('Сборка');
    }
  });
});

describe('session-title — ожидание', () => {
  it('✳ — управляется Claude, но не работа', () => {
    const title = `${WAITING} Жду ответа`;
    expect(sessionManaged(title)).toBe(true);
    expect(sessionWorking(title)).toBe(false);
    expect(sessionWaiting(title)).toBe(true);
    expect(sessionTitleText(title)).toBe('Жду ответа');
  });
});

describe('session-title — устойчивость к смене глифа', () => {
  // Ради этого правило и обобщено: любой символ-индикатор, кроме ✳, = работа.
  it('незнакомые символы-спиннеры тоже считаются работой', () => {
    for (const g of ['░', '◢', '✦', '⧖', '⭘']) {
      expect(sessionWorking(`${g} Задача`)).toBe(true);
      expect(sessionTitleText(`${g} Задача`)).toBe('Задача');
    }
  });

  it('серия из нескольких символов срезается целиком', () => {
    expect(sessionTitleText(`${HALF_LEFT}${HALF_RIGHT} Двойной`)).toBe('Двойной');
  });
});

describe('session-title — что индикатором НЕ считается', () => {
  it('обычный заголовок не трогаем', () => {
    expect(sessionWorking('Integrator')).toBe(false);
    expect(sessionManaged('Integrator')).toBe(false);
    expect(sessionTitleText('Integrator')).toBe('Integrator');
    expect(titleIndicator('Integrator')).toBe('');
  });

  it('эмодзи в начале — это заголовок человека, а не статус', () => {
    // Иначе «🚀 Deploy» потерял бы первый символ и вечно горел бы «в работе».
    expect(sessionWorking('\u{1F680} Deploy')).toBe(false);
    expect(sessionTitleText('\u{1F680} Deploy')).toBe('\u{1F680} Deploy');
  });

  it('заголовок из одного индикатора даёт пустой текст', () => {
    expect(sessionTitleText(HALF_LEFT)).toBe('');
    expect(sessionWorking(HALF_LEFT)).toBe(true);
  });

  it('пустой заголовок ничего не ломает', () => {
    expect(sessionWorking('')).toBe(false);
    expect(sessionManaged('')).toBe(false);
    expect(sessionTitleText('')).toBe('');
  });
});
