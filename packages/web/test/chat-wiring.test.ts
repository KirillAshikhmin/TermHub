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
const feedCalls: FeedOptions[] = [];
const transport = {
  mode: 'lan',
  clientScope: null,
  capabilities: async () => ['feed', 'chat'],
  gradle: async () => null,
  list: async () => [{ name: 'work', command: 'claude', path: '/r' }],
  dirs: async () => [],
  live: async () => current,
  act: async () => ({ ok: true, screen: { kind: 'idle' } }),
  feed: async (_s: string, opts: FeedOptions = {}) => {
    feedCalls.push(opts);
    return { ok: true, agent: 'claude', entries: [], head: 'h', tail: 'tl', bof: true, eof: true, complete: true, live: false, skipped: 0 };
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
  it('полоса состояния — в слоте status, ряд управления — перед полем ввода; смена состояния просит приращение', async () => {
    current = state('idle');
    const chat = mountChat(host, 'work', transport);
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.slots.status.querySelector('.th-live__state')).not.toBeNull();
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
