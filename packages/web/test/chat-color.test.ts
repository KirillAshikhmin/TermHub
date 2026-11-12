// @vitest-environment happy-dom
// Цвет в чате: подсветка команды оболочки, метка исхода, ANSI в выводе, раскрытие и строка
// действия. Контраст новых красок — chat-color-contrast.test.ts.
import { describe, expect, it, vi } from 'vitest';

import { setLang } from '../src/i18n';
import { ansiNodes, createMark, highlightShell, isShellTool } from '../src/chat-color';
import { mountToolDetail } from '../src/chat-tool';
import type { DetailResult, FeedEntry } from '../src/transport';

setLang('ru');

const holder = (frag: DocumentFragment): HTMLElement => {
  const el = document.createElement('div');
  el.append(frag);
  return el;
};
const classes = (root: HTMLElement, cls: string): string[] =>
  Array.from(root.querySelectorAll(`.${cls}`)).map((n) => n.textContent ?? '');

describe('подсветка команды оболочки', () => {
  it('имя команды, ключи, строки, перенаправления и операторы получают свои классы; текст цел', async () => {
    const code = 'git commit --amend -m "fix it" 2>&1 | tee out.log && ls -la > /tmp/x';
    const el = document.createElement('span');
    el.textContent = code;
    await highlightShell(el, code);
    expect(el.textContent).toBe(code);
    // tee и ls highlight.js уже знает как встроенные — они красятся цветом команды в CSS.
    expect(classes(el, 'th-sh-cmd')).toEqual(['git']);
    expect(classes(el, 'hljs-built_in')).toEqual(['tee', 'ls']);
    expect(classes(el, 'th-sh-flag')).toEqual(['--amend', '-m', '-la']);
    expect(classes(el, 'th-sh-op')).toEqual(['2>&1', '|', '&&', '>']);
    expect(classes(el, 'hljs-string')).toEqual(['"fix it"']);
  });

  it('обрезанная строка с незакрытой кавычкой не ломает подсветку и не теряет текст', async () => {
    const code = 'echo "unterminated and …';
    const el = document.createElement('span');
    el.textContent = code;
    await highlightShell(el, code);
    expect(el.textContent).toBe(code);
  });

  it('разметка из команды остаётся текстом, а не узлами', async () => {
    const code = 'echo "<img src=x onerror=alert(1)>" && cat <b>x</b>';
    const el = document.createElement('span');
    el.textContent = code;
    await highlightShell(el, code);
    expect(el.textContent).toBe(code);
    expect(el.querySelector('img, b')).toBeNull();
  });

  it('оболочечные инструменты Claude и Codex узнаются, прочие — нет', () => {
    for (const name of ['Bash', 'shell', 'exec_command']) expect(isShellTool(name)).toBe(true);
    for (const name of ['Read', 'Edit', undefined]) expect(isShellTool(name)).toBe(false);
  });
});

describe('метка исхода', () => {
  it('выполнено, выполняется, прервано — точкой с подписью; ошибка — ещё и кодом выхода', () => {
    expect(createMark({ state: 'done' }).classList.contains('is-done')).toBe(true);
    expect(createMark({ state: 'done' }).title).toBe('Выполнено');
    expect(createMark({ state: 'running' }).title).toBe('Выполняется');
    expect(createMark({ state: 'stopped' }).title).toBe('Прервано');
    const bad = createMark({ state: 'failed', exit: 2 });
    expect(bad.classList.contains('is-failed')).toBe(true);
    expect(bad.textContent).toBe('код 2');
    expect(bad.title).toBe('Завершилось с ошибкой: код 2');
    expect(createMark({ state: 'failed' }).textContent).toBe('');
  });

  it('исхода нет — метка скрыта', () => {
    expect(createMark(null).hidden).toBe(true);
  });
});

describe('цвета ANSI', () => {
  it('цветовые последовательности — узлы с классами, остальные управляющие отброшены', () => {
    const raw = 'a\x1b[31mred\x1b[0m b\x1b[2K\x1b[1;32mok\x1b[m\x1b]0;title\x07 \x1b[38;5;200mx\x1b[0m';
    const root = holder(ansiNodes(raw));
    expect(root.textContent).toBe('ared bok x');
    expect(classes(root, 'th-ansi-1')).toEqual(['red']);
    expect(classes(root, 'th-ansi-2')).toEqual(['ok']);
    expect(root.querySelector('.th-ansi-2')!.classList.contains('th-ansi-bold')).toBe(true);
    expect(root.querySelectorAll('span')).toHaveLength(2); // 256 цветов не берём — «x» без окраски
  });

  it('текст без последовательностей — один текстовый узел; разметка остаётся текстом', () => {
    const root = holder(ansiNodes('<b>x</b>\nline'));
    expect(root.childNodes).toHaveLength(1);
    expect(root.firstChild!.nodeType).toBe(3);
    expect(root.querySelector('b')).toBeNull();
  });
});

describe('раскрытие действия: цвет', () => {
  const ENTRY: FeedEntry = { id: 'u', at: 0, kind: 'tool', tool: 'Bash', text: 'Bash make', detail: true, cursor: '1:2' };
  const row = (): HTMLElement => {
    const el = document.createElement('div');
    el.append(createMark({ state: 'running' }), document.createTextNode('make'));
    document.body.replaceChildren(el);
    return el;
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  it('команда подсвечена, вывод с ANSI окрашен, метка строки догоняет ошибку с кодом', async () => {
    const load = vi.fn((): Promise<DetailResult> =>
      Promise.resolve({ ok: true, input: 'make -j4 > log', output: 'x\x1b[31mfail\x1b[0m', result: { state: 'failed', exit: 2 } }));
    const el = row();
    mountToolDetail(el, ENTRY, load);
    el.querySelector<HTMLElement>('.th-tool__head')!.click();
    await flush();
    expect(classes(el, 'th-sh-cmd')).toEqual(['make']);
    expect(el.querySelector('.th-tool__output')!.textContent).toBe('xfail');
    expect(classes(el, 'th-ansi-1')).toEqual(['fail']);
    const mark = el.querySelector<HTMLElement>('.th-tool__mark')!;
    expect(mark.classList.contains('is-failed')).toBe(true);
    expect(mark.textContent).toBe('код 2');
  });

  it('успешное действие без поля исхода — метка «выполнено»; незаконченное — «выполняется»', async () => {
    const el = row();
    mountToolDetail(el, ENTRY, () => Promise.resolve({ ok: true, input: 'make', output: 'ok' }));
    el.querySelector<HTMLElement>('.th-tool__head')!.click();
    await flush();
    expect(el.querySelector('.th-tool__mark')!.classList.contains('is-done')).toBe(true);
    const el2 = row();
    mountToolDetail(el2, ENTRY, () => Promise.resolve({ ok: true, input: 'make', pending: true }));
    el2.querySelector<HTMLElement>('.th-tool__head')!.click();
    await flush();
    expect(el2.querySelector('.th-tool__mark')!.classList.contains('is-running')).toBe(true);
  });
});
