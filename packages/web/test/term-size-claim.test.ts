// @vitest-environment happy-dom
// Кто задаёт размер окна сессии. В control mode его держит один клиент tmux, и заявка
// (`claim`) делает этим клиентом нас. Заявлять вправе только экран, на котором работают:
// пассивная вкладка, у которой пересчиталась раскладка, размер отбирать не должна.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountTerminal } from '../src/term';
import { sessionTerminalMode } from '../src/term-mode';
import { FakeTerminal, stubResizeObserver, termTransport } from './term-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./term-harness')).FakeTerminal }));

let root: HTMLElement;
let focused = true;

beforeEach(() => {
  localStorage.clear();
  FakeTerminal.instances.length = 0;
  stubResizeObserver();
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const host = (): HTMLElement => root.querySelector<HTMLElement>('.th-term__host')!;
const touch = (): boolean => host().dispatchEvent(new Event('pointerdown'));

describe('заявка размера окна', () => {
  it('терминал открыл человек (страница в фокусе) — первый размер идёт с заявкой', () => {
    const { transport, opened, claims } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus?.('connected');
    expect(claims).toEqual([true]);
    handle.teardown();
  });

  it('переподключение вкладки в фоне заявки не несёт', () => {
    focused = false;
    const { transport, opened, claims } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus?.('connected');
    expect(claims).toEqual([false]);
    handle.teardown();
  });

  it('пересчёт раскладки пассивной вкладки шлёт размер без заявки; после ввода — с заявкой', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback): number => {
      fn(0);
      return 0;
    });
    focused = false;
    const { transport, opened, claims } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus?.('connected');
    // Схлопнулась адресная строка телефона: размер меряется заново и досылается.
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(400);
    expect(claims.at(-1)).toBe(false);
    // Человек набрал символ — теперь здесь работают, и та же досылка несёт заявку.
    FakeTerminal.instances[0]!.type('x');
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(400);
    expect(claims.at(-1)).toBe(true);
    // Через десять секунд без действий экран снова пассивен.
    vi.advanceTimersByTime(10_000);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(400);
    expect(claims.at(-1)).toBe(false);
    handle.teardown();
    vi.unstubAllGlobals();
  });

  it('чужой размер панели: действие здесь шлёт заявку', () => {
    focused = false;
    const { transport, opened, claims } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus?.('connected');
    opened[0]!.opts.onTerminalState!({ cols: 244, rows: 63 });
    touch();
    expect(claims).toEqual([false, true]);
    handle.teardown();
  });

  it('панель под нас не встаёт (окно поделено): заявка одна, сколько бы ни нажимали', () => {
    vi.useFakeTimers();
    const { transport, opened, claims } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus?.('connected');
    opened[0]!.opts.onTerminalState!({ cols: 40, rows: 24 }); // половина окна
    for (let i = 0; i < 8; i++) {
      FakeTerminal.instances[0]!.type('x');
      vi.advanceTimersByTime(1500);
    }
    expect(claims.filter((c) => c === true)).toHaveLength(2); // открытие и одна заявка
    // Размер панели сменился — его забрал кто-то ещё: заявить снова уместно.
    opened[0]!.opts.onTerminalState!({ cols: 60, rows: 20 });
    FakeTerminal.instances[0]!.type('x');
    FakeTerminal.instances[0]!.type('x');
    expect(claims.filter((c) => c === true)).toHaveLength(3);
    handle.teardown();
  });

  it('гость «только чтение» размер не заявляет', () => {
    const { transport, opened, claims } = termTransport();
    (transport as { clientScope: unknown }).clientScope = { session: 'work', write: false, files: false };
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus?.('connected');
    const before = claims.length;
    opened[0]!.opts.onTerminalState!({ cols: 244, rows: 63 });
    touch();
    expect(claims.length).toBe(before);
    handle.teardown();
  });
});

describe('режим подключения у своего терминала', () => {
  it('агент подключил не тем способом, о котором просили: сказано один раз, режим помнится за сессией', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus?.('connected');
    opened[0]!.opts.onTerminalState!({ mode: 'attach' }); // просили control (по умолчанию)
    opened[0]!.opts.onTerminalState!({ mode: 'attach' });
    expect(document.querySelectorAll('.th-toast')).toHaveLength(1);
    expect(sessionTerminalMode('work')).toBe('attach');
    expect(sessionTerminalMode('other')).toBeUndefined();
    handle.teardown();
  });

  it('режим совпал с просьбой — сообщения нет', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus?.('connected');
    opened[0]!.opts.onTerminalState!({ mode: 'control' });
    expect(document.querySelectorAll('.th-toast')).toHaveLength(0);
    expect(sessionTerminalMode('work')).toBe('control');
    handle.teardown();
  });
});
