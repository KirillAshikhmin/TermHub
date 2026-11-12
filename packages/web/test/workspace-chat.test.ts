// @vitest-environment happy-dom
// Вход в сессию и вкладка ленты рабочего пространства: чат у сессии с Claude/Codex,
// прежняя лента — у остальных; ручной выбор вида старше умолчания; терминал не
// пересоздаётся при переключении видов.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { setLang } from '../src/i18n';
import type { Transport } from '../src/transport';
import { setSessionViewPref } from '../src/view-pref';
import { mountWorkspace } from '../src/workspace';

const spies = vi.hoisted(() => ({
  term: vi.fn(),
  termTeardown: vi.fn(),
  chat: vi.fn(),
  feed: vi.fn(),
}));
vi.mock('../src/term', () => ({
  mountTerminal: vi.fn((el: HTMLElement) => {
    spies.term(el);
    return { focus: vi.fn(), teardown: spies.termTeardown };
  }),
  openTerminal: vi.fn(),
}));
vi.mock('../src/files', () => ({ mountFiles: vi.fn(() => () => {}) }));
vi.mock('../src/chat', () => ({
  mountChat: vi.fn(() => {
    spies.chat();
    return { teardown: vi.fn(), jumpTo: vi.fn() };
  }),
}));
vi.mock('../src/feed', () => ({
  mountFeed: vi.fn(() => {
    spies.feed();
    return { teardown: vi.fn(), jumpTo: vi.fn() };
  }),
}));

function transportOf(command: string, caps: string[]): Transport {
  return {
    mode: 'lan',
    clientScope: null,
    capabilities: async () => caps,
    list: async () => [{ name: 'work', command, path: '/p' }],
  } as unknown as Transport;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function open(command: string, caps = ['feed', 'chat']): ReturnType<typeof mountWorkspace> {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  return mountWorkspace(root, 'work', transportOf(command, caps));
}

beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  location.hash = '';
  for (const spy of Object.values(spies)) spy.mockClear();
});

describe('вход в сессию', () => {
  it('сессия с Claude открывается чатом: терминал не монтируется, адрес — #/sfeed', async () => {
    const ws = open('claude');
    ws.show('term');
    await settle();
    expect(location.hash).toBe('#/sfeed/work');
    expect(spies.term).not.toHaveBeenCalled();
    ws.teardown();
  });

  it('Codex и голая версия Claude — то же', async () => {
    for (const command of ['codex', '2.1.322']) {
      forgetCaps();
      location.hash = '';
      const ws = open(command);
      ws.show('term');
      await settle();
      expect(location.hash).toBe('#/sfeed/work');
      ws.teardown();
    }
  });

  it('оболочка, opencode и агент старше чата открываются терминалом', async () => {
    for (const [command, caps] of [
      ['zsh', ['feed', 'chat']],
      ['opencode', ['feed', 'chat']],
      ['claude', ['feed']],
    ] as const) {
      forgetCaps();
      spies.term.mockClear();
      const ws = open(command, [...caps]);
      ws.show('term');
      await settle();
      expect(spies.term).toHaveBeenCalledTimes(1);
      ws.teardown();
    }
    expect(location.hash).toBe('');
  });

  it('ручной выбор «терминал» помнится по сессии: эта сессия — терминалом, и после «перезагрузки»', async () => {
    setSessionViewPref('work', 'term');
    const ws = open('claude');
    ws.show('term');
    await settle();
    expect(spies.term).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe('');
    ws.teardown();
  });

  it('список сессий не ответил — терминал, как раньше', async () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    const transport = {
      mode: 'lan',
      clientScope: null,
      capabilities: async () => ['feed', 'chat'],
      list: () => new Promise(() => {}),
    } as unknown as Transport;
    const ws = mountWorkspace(root, 'work', transport);
    ws.show('term');
    await vi.advanceTimersByTimeAsync(2000);
    expect(spies.term).toHaveBeenCalledTimes(1);
    ws.teardown();
    vi.useRealTimers();
  });

  it('вход через другую вкладку вид не подменяет: проводник первым — потом «терминал» осознан', async () => {
    const ws = open('claude');
    ws.show('files');
    ws.show('term');
    await settle();
    expect(spies.term).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe('');
    ws.teardown();
  });
});

describe('вкладка ленты', () => {
  it('Claude + chat — чат; без чата, opencode, оболочка без выбора — прежняя лента', async () => {
    for (const [command, caps, wantChat] of [
      ['claude', ['feed', 'chat'], true],
      ['claude', ['feed'], false],
      ['opencode', ['feed', 'chat'], false],
      ['zsh', ['feed', 'chat'], false],
    ] as const) {
      forgetCaps();
      spies.chat.mockClear();
      spies.feed.mockClear();
      const ws = open(command, [...caps]);
      ws.show('feed');
      await settle();
      expect(spies.chat).toHaveBeenCalledTimes(wantChat ? 1 : 0);
      expect(spies.feed).toHaveBeenCalledTimes(wantChat ? 0 : 1);
      ws.teardown();
    }
  });

  it('агент вышел из панели, но чат выбирали — чат скажет «агент не запущен», а не тупик ленты', async () => {
    setSessionViewPref('work', 'chat');
    const ws = open('zsh');
    ws.show('feed');
    await settle();
    expect(spies.chat).toHaveBeenCalledTimes(1);
    ws.teardown();
  });

  it('переключение чат ↔ терминал не пересоздаёт ни терминал, ни чат', async () => {
    setSessionViewPref('work', 'term');
    const ws = open('claude');
    ws.show('term');
    await settle();
    ws.show('feed');
    await settle();
    ws.show('term');
    ws.show('feed');
    ws.show('term');
    await settle();
    expect(spies.term).toHaveBeenCalledTimes(1);
    expect(spies.chat).toHaveBeenCalledTimes(1);
    expect(spies.termTeardown).not.toHaveBeenCalled();
    ws.teardown();
  });
});
