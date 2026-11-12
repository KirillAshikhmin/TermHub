// @vitest-environment happy-dom
// Окошко терминала чата: ленивое создание, passive, сворачивание снимает терминал.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountChatTerm } from '../src/chat-term';
import { setLang, t } from '../src/i18n';
import type { Transport } from '../src/transport';

const mounted: Array<{ root: HTMLElement; session: string; opts: unknown; torn: boolean }> = [];
vi.mock('../src/term', () => ({
  mountTerminal: (root: HTMLElement, session: string, _t: Transport, opts: unknown) => {
    const rec = { root, session, opts, torn: false };
    mounted.push(rec);
    root.append(document.createElement('canvas'));
    return { focus() {}, teardown: () => { rec.torn = true; } };
  },
}));

const transport = {} as Transport;
const tick = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

let host: HTMLElement;
beforeEach(() => {
  mounted.length = 0;
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.append(host);
});

describe('chat terminal window', () => {
  it('до показа терминал не создан; показ монтирует встроенный passive-терминал один раз', async () => {
    const w = mountChatTerm(host, 'work', transport);
    await tick();
    expect(mounted).toHaveLength(0);
    expect(w.el.hidden).toBe(true);
    w.show();
    w.show();
    await tick();
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toMatchObject({ session: 'work', opts: { embedded: true, passive: true } });
    expect(w.el.hidden).toBe(false);
    expect(w.visible()).toBe(true);
  });

  it('окно, открывшееся само, фокус не берёт; открытое человеком — берёт', async () => {
    const w = mountChatTerm(host, 'work', transport);
    w.show();
    await tick();
    expect(mounted[0]!.opts).toMatchObject({ autofocus: false });
    w.hide();
    w.show({ focus: true });
    await tick();
    expect(mounted[1]!.opts).toMatchObject({ autofocus: true });
  });

  it('сворачивание снимает терминал и прячет окошко; новый показ создаёт заново', async () => {
    const w = mountChatTerm(host, 'work', transport);
    w.show();
    await tick();
    w.hide();
    expect(mounted[0]!.torn).toBe(true);
    expect(w.el.hidden).toBe(true);
    w.show();
    await tick();
    expect(mounted).toHaveLength(2);
  });

  it('скрыли, пока модуль грузился, — терминал не монтируется', async () => {
    const w = mountChatTerm(host, 'work', transport);
    w.show();
    w.hide();
    await tick();
    expect(mounted).toHaveLength(0);
  });

  it('teardown убирает окошко из DOM', async () => {
    const w = mountChatTerm(host, 'work', transport);
    w.show();
    await tick();
    w.teardown();
    expect(host.querySelector('.th-chat-term')).toBeNull();
    expect(mounted[0]!.torn).toBe(true);
  });

  it('у окна своя шапка: название с именем сессии и кнопка закрытия с подписью; терминал — в теле окна', async () => {
    setLang('ru');
    const w = mountChatTerm(host, 'work', transport);
    w.show();
    await tick();
    const head = w.el.querySelector('.th-chat-term__head')!;
    expect(head.querySelector('.th-chat-term__title')!.textContent).toBe(`${t('chat.term.title')} · work`);
    const close = head.querySelector<HTMLButtonElement>('button.th-chat-term__close')!;
    expect(close.type).toBe('button');
    expect(close.getAttribute('aria-label')).toBe(t('chat.term.close'));
    expect(mounted[0]!.root.className).toBe('th-chat-term__body');
    expect(mounted[0]!.root.parentElement).toBe(w.el);
    expect(w.el.getAttribute('role')).toBe('dialog');
    expect(w.el.getAttribute('aria-modal')).toBeNull();
  });

  it('кнопка закрытия прячет окно, снимает терминал и сообщает владельцу; шапка переживает закрытие', async () => {
    let closed = 0;
    const w = mountChatTerm(host, 'work', transport, { onClose: () => { closed += 1; } });
    w.show();
    await tick();
    w.el.querySelector<HTMLButtonElement>('.th-chat-term__close')!.click();
    expect(closed).toBe(1);
    expect(w.visible()).toBe(false);
    expect(w.el.hidden).toBe(true);
    expect(mounted[0]!.torn).toBe(true);
    w.show();
    await tick();
    expect(w.el.querySelector('.th-chat-term__close')).not.toBeNull();
    expect(mounted).toHaveLength(2);
  });

  it('Esc в окне его не закрывает — это клавиша агенту', async () => {
    let closed = 0;
    const w = mountChatTerm(host, 'work', transport, { onClose: () => { closed += 1; } });
    w.show();
    await tick();
    const body = w.el.querySelector('.th-chat-term__body')!;
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    body.dispatchEvent(ev);
    expect(w.visible()).toBe(true);
    expect(closed).toBe(0);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('шапка называет причину открытия; пустая причина строку прячет', async () => {
    const w = mountChatTerm(host, 'work', transport);
    w.show();
    w.setReason('Причина: no footer');
    const why = w.el.querySelector<HTMLElement>('.th-chat-term__why')!;
    expect(why.textContent).toBe('Причина: no footer');
    expect(why.hidden).toBe(false);
    w.setReason('');
    expect(why.hidden).toBe(true);
  });
});
