import { describe, expect, it } from 'vitest';
import { sessionManaged, sessionTitleText, sessionWorking } from '../src/session-status';

describe('sessionWorking', () => {
  it('брайлевый спиннер в начале = работает', () => {
    expect(sessionWorking('⠂ Сборка')).toBe(true);
    expect(sessionWorking('⠐ Думаю')).toBe(true);
    expect(sessionWorking('  ⣿ отступ')).toBe(true);
  });

  it('✳ и обычный текст = не работает', () => {
    expect(sessionWorking('✳ Готово, жду')).toBe(false);
    expect(sessionWorking('bash')).toBe(false);
    expect(sessionWorking('')).toBe(false);
  });
});

describe('sessionManaged', () => {
  it('брайль или ✳ в начале = сессией управляет Claude Code', () => {
    expect(sessionManaged('⠂ работает')).toBe(true);
    expect(sessionManaged('✳ ждёт')).toBe(true);
  });

  it('обычный заголовок = не managed (индикатор по fallback-activity)', () => {
    expect(sessionManaged('vim file.txt')).toBe(false);
    expect(sessionManaged('bash')).toBe(false);
    expect(sessionManaged('')).toBe(false);
  });
});

describe('sessionTitleText', () => {
  it('срезает ведущий индикатор (брайль/✳) и пробелы', () => {
    expect(sessionTitleText('⠂ Сборка проекта')).toBe('Сборка проекта');
    expect(sessionTitleText('✳ Жду ответа')).toBe('Жду ответа');
    expect(sessionTitleText('  ⣿  задача')).toBe('задача');
  });

  it('обычный заголовок — как есть; только индикатор или пусто → пустая строка', () => {
    expect(sessionTitleText('vim file.txt')).toBe('vim file.txt');
    expect(sessionTitleText('⠂')).toBe('');
    expect(sessionTitleText('')).toBe('');
  });
});
