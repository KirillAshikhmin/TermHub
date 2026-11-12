// @vitest-environment happy-dom
// Живая часть вставлена в оболочку чата: полоса в своём месте, ряд управления перед
// полем ввода (место поля пустое), смена состояния агента тянет приращение переписки,
// ручка отдаёт `live` для поля ввода.
import type { LiveResult } from '@termhub/protocol/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { mountChat } from '../src/chat';
import { setLang } from '../src/i18n';
import type { FeedOptions, Transport } from '../src/transport';

vi.mock('../src/term', () => ({ mountTerminal: () => ({ focus() {}, teardown() {} }) }));

let current: LiveResult;
let feedLive = false;
let feedGate: Promise<void> | null = null;
const feedCalls: FeedOptions[] = [];
const transport = {
  mode: 'lan',
  clientScope: null,
  capabilities: async () => ['feed', 'chat'],
  gradle: async () => null,
  list: async () => [{ name: 'work', command: 'claude', path: '/r', title: '' }],
  dirs: async () => [],
  live: async () => current,
  act: async () => ({ ok: true, screen: { kind: 'idle' } }),
  feed: async (_s: string, opts: FeedOptions = {}) => {
    feedCalls.push(opts);
    if (feedGate) await feedGate;
    return { ok: true, agent: 'claude', entries: [], head: 'h', tail: 'tl', bof: true, eof: true, complete: true, live: feedLive, skipped: 0 };
  },
} as unknown as Transport;
const state = (kind: 'idle' | 'working'): LiveResult => ({
  ok: true, agent: 'claude', tested: true, screen: { kind }, modes: [], models: [],
});

let host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  feedCalls.length = 0;
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => vi.useRealTimers());

describe('чат: живая часть в оболочке', () => {
  it('состояние — в строке шапки переписки (слот status пуст), ряд управления — перед полем ввода; смена состояния просит приращение', async () => {
    current = state('idle');
    const chat = mountChat(host, 'work', transport);
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.el.querySelector('.th-feed__head .th-live__state')).not.toBeNull();
    expect(chat.slots.status.childElementCount).toBe(0);
    expect(chat.slots.composer.querySelector('.th-composer')).not.toBeNull();
    expect(chat.slots.composer.previousElementSibling!.classList.contains('th-live__controls')).toBe(true);
    expect(chat.live.state()!.screen.kind).toBe('idle');

    const before = feedCalls.filter((c) => c.after !== undefined).length;
    current = state('working');
    await vi.advanceTimersByTimeAsync(1100);
    expect(feedCalls.filter((c) => c.after !== undefined).length).toBeGreaterThan(before);
    chat.teardown();
    expect(host.querySelector('.th-live__controls')).toBeNull();
  });
});

describe('чат: частота приращения переписки', () => {
  const increments = (): number => feedCalls.filter((c) => c.after !== undefined).length;
  afterEach(() => {
    feedLive = false;
    feedGate = null;
  });

  it('агент работает — приращение на каждой секунде; ждёт ввода — на третьей', async () => {
    feedLive = true;
    current = state('working');
    const chat = mountChat(host, 'work', transport);
    // Два кадра: состояние «работает» устоялось.
    await vi.advanceTimersByTimeAsync(1500);
    let before = increments();
    for (let second = 1; second <= 4; second += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      expect(increments()).toBe(before + second);
    }

    current = state('idle');
    await vi.advanceTimersByTimeAsync(1500); // смена состояния просит приращение сама
    before = increments();
    await vi.advanceTimersByTimeAsync(2000);
    expect(increments() - before).toBeLessThanOrEqual(1);
    before = increments();
    await vi.advanceTimersByTimeAsync(6000);
    expect(increments() - before).toBe(2);
    chat.teardown();
  });

  it('запросы не накладываются: пока ответ в пути, следующего не шлём; скрытая вкладка не опрашивается', async () => {
    feedLive = true;
    current = state('working');
    const chat = mountChat(host, 'work', transport);
    await vi.advanceTimersByTimeAsync(1500);
    let release = (): void => {};
    feedGate = new Promise<void>((r) => { release = r; });
    const before = increments();
    await vi.advanceTimersByTimeAsync(4000);
    expect(increments() - before).toBe(1);
    feedGate = null;
    release();
    await vi.advanceTimersByTimeAsync(10);

    const view = document.createElement('div');
    view.className = 'th-ws-view';
    host.replaceWith(view);
    view.append(host);
    const hidden = increments();
    await vi.advanceTimersByTimeAsync(4000);
    expect(increments()).toBe(hidden);
    chat.teardown();
  });
});

describe('чат: вид и строка «в терминале набрано» в оболочке', () => {
  it('набранное в строке агента видно над полем; человек начал писать в поле — строка уходит', async () => {
    current = { ok: true, agent: 'claude', tested: true, screen: { kind: 'idle', input: 'из терминала' }, modes: [], models: [] };
    const chat = mountChat(host, 'work', transport);
    await vi.advanceTimersByTimeAsync(10);
    const line = chat.el.querySelector<HTMLElement>('.th-typed')!;
    expect(line.hidden).toBe(false);
    expect(line.querySelector('.th-typed__text')!.textContent).toBe('из терминала');
    expect(line.compareDocumentPosition(chat.slots.composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    chat.composer!.setText('моё');
    expect(line.hidden).toBe(true);
    chat.teardown();
  });

  it('область чата несёт переменные вида из настроек терминала', async () => {
    current = state('idle');
    const chat = mountChat(host, 'work', transport);
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.el.style.getPropertyValue('--chat-fs')).toMatch(/^\d+px$/);
    expect(chat.el.style.getPropertyValue('--chat-lh')).toBe('1');
    chat.teardown();
  });
});
