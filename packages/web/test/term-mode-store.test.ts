// @vitest-environment happy-dom
// Хранилище просьбы о способе подключения: ключ localStorage открыт чужой записи и
// может быть недоступен целиком (приватный режим браузера). Обе ветки — единственная
// защита от того, чтобы просьба уехала агенту мусором.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lastTerminalMode, noteTerminalMode, setTerminalModeRequest, terminalModeRequest } from '../src/term-mode';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('просьба о способе подключения — хранилище', () => {
  it('чужое значение в ключе не становится просьбой: остаётся режим по умолчанию', () => {
    localStorage.setItem('termhub.terminalMode', 'turbo');
    expect(terminalModeRequest()).toBe('control');

    localStorage.setItem('termhub.terminalModeLast', 'turbo');
    expect(lastTerminalMode()).toBeUndefined();
  });

  it('недоступное хранилище не роняет экран: чтение даёт умолчание, запись молчит', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(terminalModeRequest()).toBe('control');
    expect(lastTerminalMode()).toBeUndefined();
    expect(() => setTerminalModeRequest('attach')).not.toThrow();
    expect(() => noteTerminalMode('attach')).not.toThrow();
  });
});
