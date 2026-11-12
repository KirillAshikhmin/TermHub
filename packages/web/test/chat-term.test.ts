// @vitest-environment happy-dom
// Окошко терминала чата: ленивое создание, passive, сворачивание снимает терминал.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountChatTerm } from '../src/chat-term';
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
});
