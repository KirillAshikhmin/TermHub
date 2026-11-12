// @vitest-environment happy-dom
// Окошко терминала в чате подключается зрителем размера (`passive`): единственный
// обязательный первый RESIZE идёт без заявки, дальше ни заявок, ни просьб размера —
// ни от ввода, ни от касания, ни от пересчёта раскладки. Ввод и панель клавиш работают.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountTerminal } from '../src/term';
import { FakeTerminal, stubResizeObserver, termTransport } from './term-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./term-harness')).FakeTerminal }));

let root: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  FakeTerminal.instances.length = 0;
  stubResizeObserver();
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => true);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 800);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('terminal passive', () => {
  it('первый RESIZE без заявки, дальше ни одного: ввод, касание и пересчёт раскладки размер не просят', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback): number => {
      fn(0);
      return 0;
    });
    const { transport, opened, claims, frames } = termTransport();
    const handle = mountTerminal(root, 'work', transport, { embedded: true, passive: true });
    opened[0]!.opts.onStatus?.('connected');
    expect(claims).toEqual([false]);
    opened[0]!.opts.onTerminalState!({ cols: 120, rows: 40 }); // чужой размер панели
    FakeTerminal.instances[0]!.type('x');
    root.querySelector('.th-term__host')!.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(500);
    expect(claims).toEqual([false]);
    expect(frames.filter((f) => f.kind === 'resize')).toHaveLength(1);
    // а сам ввод в панель агента уходит
    expect(frames.filter((f) => f.kind === 'data').map((f) => f.text)).toEqual(['x']);
    handle.teardown();
  });

  it('просит агента открыть терминал зрителем: панель окошко не меняет ни подключением, ни позже', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport, { embedded: true, passive: true });
    expect(opened[0]!.opts.passive).toBe(true);
    handle.teardown();
    const plain = termTransport();
    const h2 = mountTerminal(root, 'work', plain.transport, { embedded: true });
    expect(plain.opened[0]!.opts.passive).toBeUndefined();
    h2.teardown();
  });

  it('открытие, закрытие и повторное открытие окошка: ни одной заявки размера, каждый канал — зрителем', () => {
    const { transport, opened, claims } = termTransport();
    for (let i = 0; i < 3; i += 1) {
      const h = mountTerminal(root, 'work', transport, { embedded: true, passive: true });
      opened[i]!.opts.onStatus?.('connected');
      opened[i]!.opts.onTerminalState!({ cols: 236, rows: 34 });
      FakeTerminal.instances.at(-1)!.type('x');
      h.teardown();
    }
    expect(opened.map((o) => o.opts.passive)).toEqual([true, true, true]);
    expect(claims).toEqual([false, false, false]);
  });

  it('пассивное окошко несёт панель клавиш; обычный встроенный терминал — нет', () => {
    const a = termTransport();
    const h1 = mountTerminal(root, 'work', a.transport, { embedded: true, passive: true });
    expect(root.querySelector('.th-qk')).not.toBeNull();
    h1.teardown();
    const b = termTransport();
    const h2 = mountTerminal(root, 'work', b.transport, { embedded: true });
    expect(root.querySelector('.th-qk')).toBeNull();
    h2.teardown();
  });

  it('клавиша панели уходит в терминал', () => {
    const { transport, opened, frames } = termTransport();
    const h = mountTerminal(root, 'work', transport, { embedded: true, passive: true });
    opened[0]!.opts.onStatus?.('connected');
    root.querySelector<HTMLButtonElement>('.th-qk [data-key="esc"], .th-qk button')!.click();
    expect(frames.some((f) => f.kind === 'data')).toBe(true);
    h.teardown();
  });
});
