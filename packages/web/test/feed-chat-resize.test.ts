// @vitest-environment happy-dom
// Чат: нижняя часть (поле ввода) растёт и отнимает высоту у переписки. Раскладка — поток
// (flex), а вот прокрутка сама за низом не идёт: прокрученный к низу список после сжатия
// оставляет последнее сообщение под краем. Лента следит за высотой области (ResizeObserver).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { mountFeed } from '../src/feed';
import type { FeedOptions, FeedResult, Transport } from '../src/transport';

let fire: () => void = () => {};
const transport = {
  mode: 'lan',
  clientScope: null,
  capabilities: async () => ['feed'],
  gradle: async () => null,
  list: async () => [],
  feed: async (_s: string, _o: FeedOptions = {}): Promise<FeedResult> => ({
    ok: true, agent: 'claude', entries: [], head: 'h', tail: 't', bof: true, eof: true, complete: true, live: false, skipped: 0,
  }),
} as unknown as Transport;

beforeEach(() => {
  forgetCaps();
  document.body.replaceChildren();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(cb: () => void) {
      fire = cb;
    }
    observe(): void {}
    disconnect(): void {}
  };
});
afterEach(() => vi.useRealTimers());

async function mount(chat: boolean): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  mountFeed(host, 'work', transport, chat ? ({ linker: { ready: Promise.resolve() } } as never) : undefined);
  await new Promise((r) => setTimeout(r, 0));
  const l = host.querySelector('.th-feed__list') as HTMLElement;
  Object.defineProperty(l, 'scrollHeight', { value: 1000, configurable: true });
  return l;
}
const setHeight = (l: HTMLElement, h: number): void => {
  Object.defineProperty(l, 'clientHeight', { value: h, configurable: true });
};

describe('рост поля ввода в чате', () => {
  it('прокрученная к низу переписка остаётся у низа после сжатия области', async () => {
    const l = await mount(true);
    setHeight(l, 500);
    l.scrollTop = 500; // у самого низа
    fire(); // первое срабатывание запоминает высоту
    setHeight(l, 400); // поле выросло
    fire();
    expect(l.scrollTop).toBe(1000);
  });

  it('читающий выше не сдвигается', async () => {
    const l = await mount(true);
    setHeight(l, 500);
    l.scrollTop = 100;
    fire();
    setHeight(l, 400);
    fire();
    expect(l.scrollTop).toBe(100);
  });

  it('возврат высоты после отправки держит низ', async () => {
    const l = await mount(true);
    setHeight(l, 400);
    l.scrollTop = 600;
    fire();
    setHeight(l, 500);
    fire();
    expect(l.scrollTop).toBe(1000);
  });

  it('лента без чата прокрутку не трогает', async () => {
    const l = await mount(false);
    setHeight(l, 500);
    l.scrollTop = 500;
    fire();
    setHeight(l, 400);
    fire();
    expect(l.scrollTop).toBe(500);
  });
});
