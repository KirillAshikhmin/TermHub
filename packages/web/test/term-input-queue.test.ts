// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bellUnseen, observeBells } from '../src/bell-seen';
import { mountTerminal } from '../src/term';
import { FakeTerminal, stubResizeObserver, termTransport } from './term-harness';

// xterm подменён: проверяем, что уходит в транспорт, а не рендер (см. term-harness).
vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./term-harness')).FakeTerminal }));

const INPUT_LIMIT = 8 * 1024; // 8 КБ — потолок очереди из спецификации (§15)
const RESIZE = { kind: 'resize', text: '80x24' }; // cols×rows поддельного xterm

// Транспорт молча роняет байты, пока соединение не поднято (LAN: WebSocket ещё не OPEN;
// relay — до OpenOk). Экран обязан копить ввод и отдать его после первого кадра RESIZE.
describe('очередь ввода до подключения', () => {
  let root: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    FakeTerminal.instances.length = 0;
    stubResizeObserver();
    root = document.createElement('div');
    document.body.append(root);
  });

  it('floating keyboard shares panel state and appears only with collapsed toolbars', () => {
    const { transport } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    const floating = root.querySelector<HTMLButtonElement>('.th-term__keyboard-toggle')!;
    const panelKey = root.querySelector<HTMLButtonElement>('.th-qk__keyboard')!;
    expect(floating.classList.contains('is-hidden')).toBe(true);
    root.querySelector<HTMLButtonElement>('.th-holobar__hide')!.click();
    expect(floating.classList.contains('is-hidden')).toBe(false);
    const initial = panelKey.getAttribute('aria-pressed');
    floating.click();
    expect(panelKey.getAttribute('aria-pressed')).not.toBe(initial);
    expect(floating.getAttribute('aria-pressed')).toBe(panelKey.getAttribute('aria-pressed'));
    expect(localStorage.getItem('termhub.keyboard')).toBe(panelKey.getAttribute('aria-pressed') === 'true' ? '1' : '0');
    root.querySelector<HTMLButtonElement>('.th-term__toolbar-toggle:not(.th-term__keyboard-toggle)')!.click();
    expect(floating.classList.contains('is-hidden')).toBe(true);
    panelKey.click();
    expect(floating.getAttribute('aria-pressed')).toBe(initial);
    root.querySelector<HTMLButtonElement>('.th-holobar__hide')!.click();
    expect(floating.getAttribute('aria-pressed')).toBe(initial);
    handle.teardown();
  });

  it('terminal BEL becomes unread and input acknowledges it', () => {
    observeBells([]);
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onBell();
    expect(bellUnseen('work')).toBe(true);
    FakeTerminal.instances[0]!.type('x');
    expect(bellUnseen('work')).toBe(false);
    handle.teardown();
  });

  it('набранное до connected не уходит в транспорт; на connected — сначала RESIZE, затем очередь', () => {
    const { transport, frames, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    const xt = FakeTerminal.instances[0]!;
    xt.type('ls');
    xt.type('\r');
    expect(frames).toEqual([]);

    opened[0]!.opts.onStatus('connected');
    expect(frames[0]).toEqual(RESIZE);
    expect(frames.slice(1).map((f) => f.kind)).toEqual(['data', 'data']);
    expect(frames.slice(1).map((f) => f.text).join('')).toBe('ls\r');

    // После подключения ввод идёт сразу, без очереди.
    xt.type('x');
    expect(frames.at(-1)).toEqual({ kind: 'data', text: 'x' });
    handle.teardown();
  });

  it('лимит 8 КБ: чанк, который не влезает целиком, отбрасывается целиком; следующий, что влезает, — принимается', () => {
    const { transport, frames, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    const xt = FakeTerminal.instances[0]!;
    xt.type('a'.repeat(8000));
    xt.type('b'.repeat(500)); // 8500 > лимита — отброшен целиком, а не обрезан до 192
    xt.type('c'.repeat(INPUT_LIMIT - 8000)); // ровно до потолка — влезает
    xt.type('d'); // потолок достигнут

    opened[0]!.opts.onStatus('connected');
    const data = frames
      .filter((f) => f.kind === 'data')
      .map((f) => f.text)
      .join('');
    expect(data).toHaveLength(INPUT_LIMIT);
    expect(data).toBe('a'.repeat(8000) + 'c'.repeat(INPUT_LIMIT - 8000));
    handle.teardown();
  });

  it('многобайтовый символ на границе лимита не режется: в pty не уходит разорванный UTF-8', () => {
    const { transport, frames, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    const xt = FakeTerminal.instances[0]!;
    xt.type('a'.repeat(INPUT_LIMIT - 1)); // в очереди остался ровно один байт
    xt.type('ё'); // два байта UTF-8 — целиком не влезает
    xt.type('b'); // один байт — влезает

    opened[0]!.opts.onStatus('connected');
    const data = frames
      .filter((f) => f.kind === 'data')
      .map((f) => f.text)
      .join('');
    // Срез первого байта «ё» дал бы в кадре одинокий lead-байт (декодер показал бы U+FFFD).
    expect(data).not.toContain('�');
    expect(data).toBe('a'.repeat(INPUT_LIMIT - 1) + 'b');
    handle.teardown();
  });

  it('обрыв (reconnecting) снова копит ввод до нового connected — и снова после RESIZE', () => {
    const { transport, frames, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    const xt = FakeTerminal.instances[0]!;
    opened[0]!.opts.onStatus('connected');
    frames.length = 0;
    xt.type('a');
    expect(frames).toEqual([{ kind: 'data', text: 'a' }]);

    opened[0]!.opts.onStatus('reconnecting');
    xt.type('b');
    expect(frames).toHaveLength(1);

    opened[0]!.opts.onStatus('connected');
    expect(frames.slice(1)).toEqual([RESIZE, { kind: 'data', text: 'b' }]);
    handle.teardown();
  });

  it('onEnd очищает очередь', () => {
    const { transport, frames, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    const xt = FakeTerminal.instances[0]!;
    xt.type('zzz');
    opened[0]!.opts.onEnd({ kind: 'ended' });

    opened[0]!.opts.onStatus('connected');
    expect(frames).toEqual([RESIZE]);
    handle.teardown();
  });
});

// Очередь имеет смысл только потому, что фокус стоит в терминале с монтажа — до
// connected. Тумблер ⌨ фокус не отменяет: он лишь переводит поле в inputmode=none,
// чтобы не всплывала экранная клавиатура (R13, R13.4).
describe('фокус терминала', () => {
  let root: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    FakeTerminal.instances.length = 0;
    stubResizeObserver();
    root = document.createElement('div');
    document.body.append(root);
  });

  it('при монтаже — сразу, до connected и при выключенном ⌨; поле в inputmode=none; хэндл фокусирует повторно', () => {
    localStorage.setItem('termhub.keyboard', '0');
    const { transport } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    const xt = FakeTerminal.instances[0]!;
    expect(xt.focusCalls).toBe(1);
    expect(xt.textarea.inputMode).toBe('none');

    handle.focus();
    expect(xt.focusCalls).toBe(2);
    handle.teardown();
  });
});
