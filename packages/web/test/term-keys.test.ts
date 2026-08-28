// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountTerminal } from '../src/term';
import { enterAction } from '../src/term-keys';
import { FakeTerminal, stubResizeObserver, termTransport } from './term-harness';

// xterm подменён: проверяем обвязку обработчика клавиш, а не рендер (см. term-harness).
vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./term-harness')).FakeTerminal }));

const key = (type: string, k: string, shiftKey = false): { type: string; key: string; shiftKey: boolean } => ({
  type,
  key: k,
  shiftKey,
});

describe('enterAction: таблица истинности', () => {
  // Тумблер «Отправлять по Enter» меняет только чистый Enter; Shift+Enter — всегда перенос.
  it.each([
    ['keydown', false, true, 'send'],
    ['keydown', true, true, 'newline'],
    ['keydown', false, false, 'newline'],
    ['keydown', true, false, 'newline'],
  ] as const)('%s Enter, shift=%s, enterSends=%s → %s', (type, shift, enterSends, expected) => {
    expect(enterAction(key(type, 'Enter', shift), enterSends)).toBe(expected);
  });

  // keypress Enter — страховка от второго \r: xterm на keypress шлёт \r сам, если
  // keydown не был погашен.
  it('keypress Enter подавляется в любом положении тумблера и с Shift', () => {
    expect(enterAction(key('keypress', 'Enter'), true)).toBe('suppress');
    expect(enterAction(key('keypress', 'Enter'), false)).toBe('suppress');
    expect(enterAction(key('keypress', 'Enter', true), true)).toBe('suppress');
  });

  it('keyup Enter и любые не-Enter клавиши — pass (xterm обрабатывает сам)', () => {
    expect(enterAction(key('keyup', 'Enter'), true)).toBe('pass');
    expect(enterAction(key('keyup', 'Enter', true), false)).toBe('pass');
    expect(enterAction(key('keydown', 'a'), true)).toBe('pass');
    expect(enterAction(key('keypress', 'a'), false)).toBe('pass');
    expect(enterAction(key('keydown', 'ArrowLeft', true), false)).toBe('pass');
  });
});

// Причина бага: ветка «перенос» возвращала false без preventDefault → браузер порождал
// keypress → xterm слал второй \r. Проверяем через custom-обработчик, который term.ts
// вешает на xterm, — так же его дёргает и сам xterm.
describe('обвязка в term.ts: Enter — ровно одно действие', () => {
  let root: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    FakeTerminal.instances.length = 0;
    stubResizeObserver();
    root = document.createElement('div');
    document.body.append(root);
  });

  const enterEvent = (type: string, shiftKey = false): KeyboardEvent =>
    new KeyboardEvent(type, { key: 'Enter', shiftKey, cancelable: true, bubbles: true });

  /** Экран с уже установленным соединением: журнал кадров чист, ввод идёт напрямую. */
  function connectedScreen(): { xt: FakeTerminal; frames: { kind: string; text: string }[]; teardown: () => void } {
    const { transport, frames, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus('connected');
    frames.length = 0;
    return { xt: FakeTerminal.instances[0]!, frames, teardown: handle.teardown };
  }

  // Контракт для keypress Enter — обработчик отдаёт false и гасит событие: это и есть то,
  // что в живом xterm не даёт второго \r. Поддельный xterm свой \r на keypress не
  // эмулирует, поэтому «ни байта» здесь утверждать нельзя — проверяется только, что
  // НАШ обработчик на keypress ничего не дописал в журнал.
  it('Shift+Enter: keydown погашен, ровно один \\x1b\\r; последующий keypress подавлен (false + defaultPrevented)', () => {
    const { xt, frames, teardown } = connectedScreen();
    const down = enterEvent('keydown', true);
    expect(xt.key(down)).toBe(false);
    expect(down.defaultPrevented).toBe(true);
    expect(frames).toEqual([{ kind: 'data', text: '\x1b\r' }]);

    const press = enterEvent('keypress', true);
    expect(xt.key(press)).toBe(false);
    expect(press.defaultPrevented).toBe(true);
    expect(frames).toHaveLength(1); // наш обработчик на keypress байтов не шлёт
    teardown();
  });

  it('тумблер выключен: чистый Enter — тоже один перенос, keypress подавлен (false + defaultPrevented)', () => {
    localStorage.setItem('termhub.enterSends', '0');
    const { xt, frames, teardown } = connectedScreen();
    const down = enterEvent('keydown');
    expect(xt.key(down)).toBe(false);
    expect(down.defaultPrevented).toBe(true);
    expect(frames).toEqual([{ kind: 'data', text: '\x1b\r' }]);

    const press = enterEvent('keypress');
    expect(xt.key(press)).toBe(false);
    expect(press.defaultPrevented).toBe(true);
    expect(frames).toHaveLength(1); // наш обработчик на keypress байтов не шлёт
    teardown();
  });

  it('тумблер включён: чистый Enter отдаётся xterm (он сам шлёт \\r), мы байтов не шлём', () => {
    const { xt, frames, teardown } = connectedScreen();
    expect(xt.key(enterEvent('keydown'))).toBe(true);
    expect(frames).toEqual([]);
    teardown();
  });
});
