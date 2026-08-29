// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Transport } from '../src/transport';
import { mountWorkspace } from '../src/workspace';

// Экран терминала подменён хэндлом-шпионом: focus запоминает, был ли вид терминала
// уже показан (фокус на скрытом элементе браузер игнорирует).
const term = vi.hoisted(() => {
  const state = { el: null as HTMLElement | null, activeAtFocus: [] as boolean[] };
  return {
    state,
    handle: {
      focus: vi.fn(() => {
        state.activeAtFocus.push(state.el?.classList.contains('is-active') ?? false);
      }),
      teardown: vi.fn(),
    },
  };
});
vi.mock('../src/term', () => ({
  mountTerminal: vi.fn((el: HTMLElement) => {
    term.state.el = el;
    return term.handle;
  }),
  openTerminal: vi.fn(() => term.handle.teardown),
}));
// Проводник в этом тесте не нужен — его монтаж потянул бы транспорт файлов.
vi.mock('../src/files', () => ({ mountFiles: vi.fn(() => () => {}) }));

describe("workspace.show('term')", () => {
  beforeEach(() => {
    localStorage.clear();
    term.handle.focus.mockClear();
    term.state.el = null;
    term.state.activeAtFocus.length = 0;
    document.title = 'TermHub';
  });

  it('ставит fallback tmux-id в browser title и возвращает базовый title при teardown', () => {
    const root = document.createElement('div');
    const ws = mountWorkspace(root, 'work', { mode: 'lan', clientScope: null } as unknown as Transport);

    expect(document.title).toBe('work · TermHub');
    ws.teardown();
    expect(document.title).toBe('TermHub');
  });

  it('показ вкладки сессии фокусирует терминал — после показа и независимо от тумблера ⌨', () => {
    // Тумблер ⌨ выключен: это режим поля ввода (inputmode=none в term.ts), а не условие
    // фокуса — workspace на него не смотрит.
    localStorage.setItem('termhub.keyboard', '0');
    const root = document.createElement('div');
    const ws = mountWorkspace(root, 'work', { mode: 'lan', clientScope: null } as unknown as Transport);

    ws.show('term');
    expect(term.handle.focus).toHaveBeenCalledTimes(1);

    ws.show('files');
    ws.show('term');
    expect(term.handle.focus).toHaveBeenCalledTimes(2);
    // Оба раза вид терминала уже был активен в момент фокуса.
    expect(term.state.activeAtFocus).toEqual([true, true]);
    ws.teardown();
  });

  it("повторный show('term') на уже активной вкладке фокус не трогает — повтор события маршрута не крадёт его у compose-бара", () => {
    const root = document.createElement('div');
    const ws = mountWorkspace(root, 'work', { mode: 'lan', clientScope: null } as unknown as Transport);
    ws.show('term');
    ws.show('term');
    expect(term.handle.focus).toHaveBeenCalledTimes(1);
    // Ушли на другую вкладку и вернулись — фокус снова: до этого show вид не был активен.
    ws.show('files');
    ws.show('term');
    expect(term.handle.focus).toHaveBeenCalledTimes(2);
    ws.teardown();
  });

  it('показ других вкладок терминал не фокусирует', () => {
    const root = document.createElement('div');
    const ws = mountWorkspace(root, 'work', { mode: 'lan', clientScope: null } as unknown as Transport);
    ws.show('term');
    ws.show('files');
    expect(term.handle.focus).toHaveBeenCalledTimes(1);
    ws.teardown();
  });
});
