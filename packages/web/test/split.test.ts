// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang } from '../src/i18n';
import { parseSplit, splitHash } from '../src/routes';
import { mountSplit } from '../src/split';
import { mountTerminal } from '../src/term';
import { FakeTerminal, stubResizeObserver, termTransport } from './term-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./term-harness')).FakeTerminal }));

describe('сплит-вид', () => {
  let root: HTMLElement;

  beforeEach(() => {
    setLang('ru');
    localStorage.clear();
    FakeTerminal.instances.length = 0;
    stubResizeObserver();
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
  });

  it('адрес: туда и обратно, без повторов и не больше четырёх', () => {
    expect(parseSplit(splitHash(['a b', 'c/d']))).toEqual(['a b', 'c/d']);
    expect(parseSplit('#/split/a/a/b/c/d/e')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseSplit('#/term/a')).toBeNull();
    expect(parseSplit('#/split/%E0%A4%A')).toBeNull();
  });

  it('встроенный терминал: ни шапки с вкладками, ни полосы разделов, ни панели клавиш', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport, { embedded: true });
    expect(opened.map((o) => o.session)).toEqual(['work']);
    expect(root.querySelector('.th-term__host')).not.toBeNull();
    expect(root.querySelector('.th-termbar')).toBeNull();
    expect(root.querySelector('.th-holobar')).toBeNull();
    expect(root.querySelector('.th-qk')).toBeNull();
    handle.teardown();
  });

  it('control mode: экран принимает размер панели, а агенту продолжает уходить свой', () => {
    const { transport, opened, frames } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus?.('connected');
    const term = FakeTerminal.instances[0]!;
    const note = root.querySelector<HTMLElement>('.th-term__foreign')!;
    expect(note.hidden).toBe(true);
    // Окно сессии держит другой клиент tmux: панель 244×63, а просили 80×24.
    opened[0]!.opts.onTerminalState!({ cols: 244, rows: 63 });
    expect([term.cols, term.rows]).toEqual([244, 63]);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('244×63');
    expect(frames.filter((f) => f.kind === 'resize').every((f) => f.text === '80x24')).toBe(true);
    // Панель вернулась к нашему размеру — пометка гаснет.
    opened[0]!.opts.onTerminalState!({ cols: 80, rows: 24 });
    expect([term.cols, term.rows]).toEqual([80, 24]);
    expect(note.hidden).toBe(true);
    // Новое подключение размер панели забывает: его назовёт новый терминал агента.
    opened[0]!.opts.onTerminalState!({ cols: 100, rows: 30 });
    opened[0]!.opts.onStatus?.('connected');
    expect([term.cols, term.rows]).toEqual([80, 24]);
    handle.teardown();
  });

  it('каждой сессии — своя панель и свой канал; teardown закрывает все', () => {
    const { transport, opened } = termTransport();
    const stop = mountSplit(root, ['a', 'b', 'c'], transport);
    expect(root.querySelectorAll('.th-split__pane').length).toBe(3);
    expect(root.querySelector<HTMLElement>('.th-split')!.dataset.panes).toBe('3');
    expect(opened.map((o) => o.session)).toEqual(['a', 'b', 'c']);
    stop();
    expect(root.children.length).toBe(0);
  });

  it('крестик панели уводит на сплит без неё, а из двух — на обычный терминал', () => {
    const { transport } = termTransport();
    const stop = mountSplit(root, ['a', 'b', 'c'], transport);
    root.querySelectorAll<HTMLButtonElement>('.th-split__head .th-iconbtn')[1]!.click();
    expect(location.hash).toBe('#/split/b/c');
    stop();
    const stop2 = mountSplit(root, ['a', 'b'], transport);
    root.querySelectorAll<HTMLButtonElement>('.th-split__head .th-iconbtn')[1]!.click();
    expect(location.hash).toBe('#/term/b');
    stop2();
  });
});
