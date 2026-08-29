// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountTerminal } from '../src/term';
import { FakeTerminal, stubResizeObserver, termTransport } from './term-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./term-harness')).FakeTerminal }));

describe('копирование в mountTerminal', () => {
  beforeEach(() => {
    FakeTerminal.instances.length = 0;
    stubResizeObserver();
    document.body.replaceChildren();
  });

  it('mouseup копирует сохранённое выделение, даже если redraw уже очистил его в xterm', async () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    const root = document.createElement('div');
    document.body.append(root);
    const { transport } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    const xt = FakeTerminal.instances[0]!;
    const host = root.querySelector<HTMLElement>('.th-term__host')!;

    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    xt.select('строка из Codex');
    xt.select('');
    host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    await vi.waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
    handle.teardown();
  });

  it('в mouse mode Codex Option+drag принудительно выделяет и копирует, а обычный drag уходит TUI', async () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    const root = document.createElement('div');
    document.body.append(root);
    const { transport } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    const xt = FakeTerminal.instances[0]!;
    xt.mouseModeActive = true;

    expect(xt.options.macOptionClickForcesSelection).toBe(true);
    expect(xt.drag('обычный drag')).toBe('mouse');
    expect(xt.mouseEvents).toHaveLength(1);
    expect(execCommand).not.toHaveBeenCalled();

    expect(xt.drag('строка из Codex', { altKey: true })).toBe('selection');
    await vi.waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
    expect(xt.getSelection()).toBe('строка из Codex');
    expect(xt.mouseEvents).toHaveLength(1);
    handle.teardown();
  });
});
