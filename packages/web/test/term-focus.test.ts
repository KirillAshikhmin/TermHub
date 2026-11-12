// @vitest-environment happy-dom
// Кому терминал вправе отдать фокус сам. Терминал, чья вкладка рабочего пространства не
// показана, фокус не берёт — ни при монтаже, ни отложенно, когда открылся канал: иначе он
// уводил бы фокус из поля ввода чата. Окошко терминала в чате, открывшееся само, тоже.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountTerminal } from '../src/term';
import { FakeTerminal, stubResizeObserver, termTransport } from './term-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./term-harness')).FakeTerminal }));

let view: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  FakeTerminal.instances.length = 0;
  stubResizeObserver();
  document.body.replaceChildren();
  view = document.createElement('div');
  view.className = 'th-ws-view';
  document.body.append(view);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => true);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 800);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('фокус терминала', () => {
  it('вкладка терминала не показана: фокус не берётся ни при монтаже, ни когда открылся канал', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(view, 'work', transport);
    const xterm = FakeTerminal.instances[0]!;
    expect(xterm.focusCalls).toBe(0);
    opened[0]!.opts.onStatus?.('connected');
    expect(xterm.focusCalls).toBe(0);
    handle.focus();
    expect(xterm.focusCalls).toBe(0);
    handle.teardown();
  });

  it('вкладка показана: фокус берётся и при открытии канала, и по просьбе рабочего пространства', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(view, 'work', transport);
    const xterm = FakeTerminal.instances[0]!;
    view.classList.add('is-active');
    handle.focus();
    expect(xterm.focusCalls).toBe(1);
    opened[0]!.opts.onStatus?.('connected');
    expect(xterm.focusCalls).toBe(2);
    handle.teardown();
  });

  it('терминал вне рабочего пространства (прямой экран) берёт фокус сразу, как раньше', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const { transport } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    expect(FakeTerminal.instances[0]!.focusCalls).toBe(1);
    handle.teardown();
  });

  it('`autofocus: false` (окошко чата открылось само): ни при монтаже, ни при открытии канала', () => {
    view.classList.add('is-active');
    const { transport, opened } = termTransport();
    const handle = mountTerminal(view, 'work', transport, { embedded: true, passive: true, autofocus: false });
    opened[0]!.opts.onStatus?.('connected');
    expect(FakeTerminal.instances[0]!.focusCalls).toBe(0);
    handle.teardown();
  });
});
