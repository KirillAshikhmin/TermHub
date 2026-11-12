// @vitest-environment happy-dom
// Поле ввода в оболочке чата: у владельца и гостя с write оно есть, у зрителя — нет;
// отправленное встаёт в переписку и заменяется записью транскрипта.
import type { ActResult, ChatAction, LiveResult } from '@termhub/protocol/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { mountChat } from '../src/chat';
import { setLang } from '../src/i18n';
import type { FeedEntry, FeedPage, FeedResult, Transport } from '../src/transport';

vi.mock('../src/term', () => ({ mountTerminal: () => ({ focus() {}, teardown() {} }) }));

const page = (entries: FeedEntry[]): FeedPage => ({ ok: true, agent: 'claude', entries, head: 'h', tail: 't', bof: true, eof: true, complete: true, live: true, skipped: 0 });

let host: HTMLElement;
let feedAnswer: FeedResult;
const acts: ChatAction[] = [];

function transport(scope: unknown): Transport {
  return {
    mode: 'lan',
    clientScope: scope,
    capabilities: async () => ['feed', 'chat'],
    gradle: async () => null,
    list: async () => [{ name: 'work', command: 'claude', path: '/root/a', title: '' }],
    dirs: async () => [{ root: '/root/a', dirs: [] }],
    feed: async () => feedAnswer,
    live: async (): Promise<LiveResult> => ({ ok: true, agent: 'claude', tested: true, screen: { kind: 'idle' }, modes: [], models: [] }),
    act: async (_s: string, a: ChatAction): Promise<ActResult> => {
      acts.push(a);
      return { ok: true, screen: { kind: 'idle' } };
    },
    commands: async () => ({ ok: true, commands: [], verified: true }),
  } as unknown as Transport;
}

beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  acts.length = 0;
  feedAnswer = page([]);
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => document.body.replaceChildren());

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe('поле ввода в чате', () => {
  it('отправка идёт действием prompt, сообщение стоит в переписке и заменяется записью транскрипта', async () => {
    const chat = mountChat(host, 'work', transport(null));
    await flush();
    const field = host.querySelector<HTMLTextAreaElement>('.th-chat__slot--composer textarea')!;
    field.value = 'привет, агент';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(acts).toEqual([{ kind: 'prompt', text: 'привет, агент', key: expect.any(String) }]);
    expect(host.querySelector('.th-feed__entry--local')!.textContent).toContain('привет, агент');

    feedAnswer = page([{ id: 'x', at: 1, kind: 'human', text: 'привет, агент', cursor: '1:0' }]);
    chat.refresh();
    await flush();
    expect(host.querySelector('.th-feed__entry--local')).toBeNull();
    expect(host.querySelectorAll('.th-feed__entry--human')).toHaveLength(1);
    chat.teardown();
  });

  it('гость с write — поле есть, гость без write — поля нет', async () => {
    const withWrite = mountChat(host, 'work', transport({ session: 'work', write: true, files: false }));
    await flush();
    expect(host.querySelector('.th-composer')).not.toBeNull();
    withWrite.teardown();
    document.body.replaceChildren();
    host = document.createElement('div');
    document.body.append(host);
    const viewer = mountChat(host, 'work', transport({ session: 'work', write: false, files: false }));
    await flush();
    expect(host.querySelector('.th-composer')).toBeNull();
    expect(host.querySelector('.th-chat__slot--composer')!.children.length).toBe(0);
    viewer.teardown();
  });
});
