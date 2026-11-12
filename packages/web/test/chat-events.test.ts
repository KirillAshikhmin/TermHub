// @vitest-environment happy-dom
// Чат: описание действия первой строкой, события фоновых агентов в переписке, состояние
// агента со «Стоп» в строке шапки переписки, три кнопки-переключателя (поиск, рассуждения,
// действия). Транспорт подделан (единственный шов); записи написаны руками по форме провода.
import type { LiveResult, ScreenState } from '@termhub/protocol/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { mountChat, type ChatHandle } from '../src/chat';
import { mountFeed } from '../src/feed';
import { setLang, t } from '../src/i18n';
import { previewOf, refreshPreviews } from '../src/session-preview';
import type { FeedEntry, FeedOptions, FeedPage, Transport } from '../src/transport';

vi.mock('../src/term', () => ({ mountTerminal: () => ({ focus() {}, teardown() {} }) }));

function page(entries: FeedEntry[], over: Partial<FeedPage> = {}): FeedPage {
  return { ok: true, agent: 'claude', entries, head: 'h', tail: 'tl', bof: true, eof: true, complete: true, live: true, skipped: 0, ...over };
}
function liveOf(screen: ScreenState): LiveResult {
  return { ok: true, agent: 'claude', version: '2.1.322', tested: true, model: 'opus', screen, modes: [], models: [] };
}

let entries: FeedEntry[] = [];
let fresh: FeedEntry[] = [];
let screen: LiveResult | Error = liveOf({ kind: 'idle' });
let scope: unknown = null;
const feedCalls: FeedOptions[] = [];
const acts: unknown[] = [];
const transport = (): Transport =>
  ({
    mode: 'lan',
    clientScope: scope,
    capabilities: async () => ['feed', 'chat'],
    gradle: async () => null,
    list: async () => [{ name: 'work', command: 'claude', path: '/root/a', title: '' }],
    dirs: async () => [{ root: '/root/a', dirs: [] }],
    live: async () => {
      if (screen instanceof Error) throw screen;
      return screen;
    },
    act: async (_s: string, a: unknown) => {
      acts.push(a);
      return { ok: true, screen: { kind: 'idle' } };
    },
    commands: async () => ({ ok: true, commands: [], verified: true }),
    feed: async (_s: string, opts: FeedOptions = {}) => {
      feedCalls.push(opts);
      if (opts.usage) return { ok: false, reason: 'no-agent', detail: '' };
      if (opts.after !== undefined) {
        const out = fresh;
        fresh = [];
        return page(out, { head: 'tl', tail: 'tl2' });
      }
      return page(entries);
    },
    feedDetail: async () => ({ ok: true, output: 'PASS' }),
  }) as unknown as Transport;

let host: HTMLElement;
let chat: ChatHandle | undefined;
beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  location.hash = '';
  entries = [];
  fresh = [];
  screen = liveOf({ kind: 'idle' });
  scope = null;
  feedCalls.length = 0;
  acts.length = 0;
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  chat?.teardown();
  chat = undefined;
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);
const qa = (sel: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(sel)];
async function open(): Promise<ChatHandle> {
  chat = mountChat(host, 'work', transport());
  await flush();
  return chat;
}

const HUMAN: FeedEntry = { id: 'h', at: 1, kind: 'human', text: 'запусти проверки в фоне', cursor: '1:0' };
const AGENT: FeedEntry = { id: 'a', at: 2, kind: 'agent', text: 'Запустил.', cursor: '1:10' };
const THINK: FeedEntry = { id: 'th', at: 2, kind: 'thinking', text: 'думаю', cursor: '1:15' };
const DESCRIBED: FeedEntry = { id: 't', at: 3, kind: 'tool', tool: 'Bash', text: 'Bash git add -A', desc: 'Сложить правки в индекс', cursor: '1:20', detail: true };
const PLAIN: FeedEntry = { id: 't2', at: 4, kind: 'tool', tool: 'Read', text: 'Read x.ts', cursor: '1:30' };
const START: FeedEntry = { id: 'e1', at: 5, kind: 'note', note: 'agent-start', text: 'Проверить сборку', cursor: '1:40' };
const MESSAGE: FeedEntry = { id: 'e2', at: 6, kind: 'note', note: 'agent-message', text: 'Сборка **зелёная**.', from: 'general-purpose', cursor: '1:50' };
const DONE: FeedEntry = { id: 'e3', at: 7, kind: 'note', note: 'agent-done', text: 'Проверить сборку', elapsed: 331, cursor: '1:60' };

describe('описание действия', () => {
  it('описание — первой строкой, «инструмент: аргумент» — второй; без описания вид прежний', async () => {
    entries = [HUMAN, DESCRIBED, PLAIN];
    await open();
    const [described, plain] = qa('.th-feed__entry--tool');
    // У раскрываемого действия строка лежит в его заголовке.
    const row = described!.querySelector('.th-tool__head')!;
    expect([...row.children].map((n) => n.className)).toEqual(['th-feed__tooldesc', 'th-feed__toolline']);
    expect([...row.children[1]!.children].map((n) => n.className)).toEqual(['th-feed__toolname', 'th-feed__tooltext']);
    expect(described!.querySelector('.th-feed__tooldesc')!.textContent).toBe('Сложить правки в индекс');
    expect(described!.querySelector('.th-feed__toolname')!.textContent).toBe('Bash');
    expect(described!.querySelector('.th-feed__tooltext')!.textContent).toBe('git add -A');
    expect(described!.classList.contains('has-desc')).toBe(true);
    expect(plain!.querySelector('.th-feed__tooldesc')).toBeNull();
    expect(plain!.classList.contains('has-desc')).toBe(false);
    expect([...plain!.children].map((n) => n.className).slice(0, 2)).toEqual(['th-feed__toolname', 'th-feed__tooltext']);
  });

  it('лента без чата описания не показывает', async () => {
    entries = [HUMAN, DESCRIBED];
    const feed = mountFeed(host, 'work', transport());
    await flush();
    expect(q('.th-feed__tooldesc')).toBeNull();
    expect(q('.th-feed__tooltext')!.textContent).toBe('git add -A');
    feed.teardown();
  });
});

describe('события фоновых агентов', () => {
  it('запуск и завершение — отдельные строки с названием задачи и длительностью, в порядке записей', async () => {
    entries = [HUMAN, START, AGENT, MESSAGE, DONE];
    await open();
    const kinds = qa('.th-feed__entry').map((n) => n.dataset.note ?? n.dataset.kind);
    expect(kinds).toEqual(['human', 'agent-start', 'agent', 'agent-message', 'agent-done']);
    const start = q('[data-note="agent-start"]')!;
    expect(start.classList.contains('th-feed__entry--event')).toBe(true);
    expect(start.textContent).toBe(t('feed.note.agent-start', { name: 'Проверить сборку' }));
    const done = q('[data-note="agent-done"]')!;
    expect(done.textContent).toBe(`${t('feed.note.agent-done', { name: 'Проверить сборку' })} · 5m 31s`);
  });

  it('сбой и остановка названы; без длительности — без неё', async () => {
    entries = [
      { ...DONE, id: 'f', elapsed: undefined, outcome: 'failed' },
      { ...DONE, id: 's', elapsed: 12, outcome: 'stopped' },
    ];
    await open();
    const [failed, stopped] = qa('[data-note="agent-done"]');
    expect(failed!.textContent).toBe(t('feed.note.agent-failed', { name: 'Проверить сборку' }));
    expect(stopped!.textContent).toBe(`${t('feed.note.agent-stopped', { name: 'Проверить сборку' })} · 12s`);
  });

  it('сообщение агента — строка «сообщение от …», по нажатию раскрывается в текст', async () => {
    entries = [HUMAN, MESSAGE, { ...MESSAGE, id: 'anon', from: undefined }];
    await open();
    const [named, anon] = qa('[data-note="agent-message"]');
    const toggle = named!.querySelector<HTMLButtonElement>('.th-feed__event-toggle')!;
    expect(toggle.textContent).toBe(t('feed.note.agent-message', { from: 'general-purpose' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const body = named!.querySelector<HTMLElement>('.th-feed__event-body')!;
    expect(body.hidden).toBe(true);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    expect(body.querySelector('strong')!.textContent).toBe('зелёная');
    toggle.click();
    expect(body.hidden).toBe(true);
    expect(anon!.querySelector('.th-feed__event-toggle')!.textContent).toBe(t('feed.note.agent-message-anon'));
  });

  it('событие не снимает локальную запись «отправляется»', async () => {
    entries = [HUMAN];
    const c = await open();
    c.feed.addLocal('Проверить сборку');
    fresh = [START, MESSAGE, DONE];
    c.feed.refresh();
    await flush();
    expect(qa('[data-note]').length).toBe(3);
    expect(q('.th-feed__local')).not.toBeNull();
    fresh = [{ id: 'h2', at: 9, kind: 'human', text: 'Проверить сборку', cursor: '1:70' }];
    c.feed.refresh();
    await flush();
    expect(q('.th-feed__local')).toBeNull();
  });

  it('превью карточки сессии берёт последнюю реплику, а не событие', async () => {
    entries = [HUMAN, AGENT, START, MESSAGE, DONE];
    const tr = transport();
    await refreshPreviews(tr, [{ name: 'work', activityTs: 1 }], () => {});
    expect(previewOf(tr, 'work')).toBe('Запустил.');
  });
});

describe('состояние агента в строке шапки переписки', () => {
  it('слово состояния, время и токены стоят в шапке рядом с агентом; слот status пуст', async () => {
    screen = liveOf({ kind: 'working', status: 'Transmuting…', elapsed: 75, tokens: 2100 });
    const c = await open();
    const head = q('.th-feed__head')!;
    const state = head.querySelector('.th-live__state')!;
    expect(state.textContent).toBe(`Transmuting… · 1m 15s · ${t('chat.live.tokens', { n: '2.1k' })}`);
    expect(head.querySelector('.th-feed__agent')!.nextElementSibling!.contains(state)).toBe(true);
    expect(c.slots.status.childElementCount).toBe(0);
    expect(host.querySelectorAll('.th-live__bar').length).toBe(1);
  });

  it('подпись «Агент работает» шапки не дублирует состояние с экрана; без состояния — на месте', async () => {
    screen = liveOf({ kind: 'working', status: 'Transmuting…' });
    await open();
    expect(q('.th-feed__live')!.hidden).toBe(true);
    chat!.teardown();
    screen = { ok: false, reason: 'no-agent', detail: '' };
    await open();
    expect(q('.th-feed__live')!.hidden).toBe(false);
    expect(q('.th-feed__head .th-live__bar')!.hidden).toBe(true);
  });

  it('ожидание фоновых агентов названо числом; чего экран не дал — того нет', async () => {
    screen = liveOf({ kind: 'working', waiting: 2 });
    await open();
    expect(q('.th-live__state')!.textContent).toBe(`${t('chat.live.working')} · ${t('chat.live.waiting', { n: 2 })}`);
    chat!.teardown();
    screen = liveOf({ kind: 'idle', waiting: 1 });
    await open();
    expect(q('.th-live__state')!.textContent).toBe(`${t('chat.live.idle')} · ${t('chat.live.waiting', { n: 1 })}`);
  });

  it('«Стоп» — в шапке при работе и шлёт interrupt; гостю без write его нет', async () => {
    screen = liveOf({ kind: 'working', status: 'Transmuting…' });
    await open();
    const stop = q<HTMLButtonElement>('.th-feed__head .th-live__stop')!;
    expect(stop.hidden).toBe(false);
    // Кнопка-иконка в ряду кнопок шапки, сразу после поиска; рядом со словом состояния её нет.
    expect(stop.closest('.th-feed__tools')).not.toBeNull();
    expect(q('.th-live__bar .th-live__stop')).toBeNull();
    expect(stop.classList.contains('th-iconbtn')).toBe(true);
    expect(stop.getAttribute('aria-label')).toBe(t('chat.live.stop'));
    expect(stop.title).toBe(t('chat.live.stop'));
    expect(stop.textContent).toBe('');
    const tools = [...q('.th-feed__tools')!.querySelectorAll<HTMLElement>('button')];
    expect(tools.map((b) => b.dataset.toggle ?? 'stop')).toEqual(['search', 'stop', 'thinking', 'actions']);
    stop.click();
    await flush();
    expect(acts).toEqual([{ kind: 'interrupt' }]);
    chat!.teardown();
    scope = { write: false, files: false };
    screen = liveOf({ kind: 'working', status: 'Transmuting…' });
    await open();
    expect(q<HTMLButtonElement>('.th-feed__head .th-live__stop')!.hidden).toBe(true);
    expect(q('.th-live__state')!.textContent).toContain('Transmuting…');
  });

  it('нет связи — видно в шапке', async () => {
    vi.useFakeTimers();
    try {
      chat = mountChat(host, 'work', transport());
      await vi.advanceTimersByTimeAsync(10);
      screen = new Error('network');
      await vi.advanceTimersByTimeAsync(1100);
      expect(q('.th-feed__head .th-live__state')!.textContent).toBe(t('chat.live.offline'));
      expect(q('.th-feed__head .th-live__bar')!.hidden).toBe(false);
    } finally {
      chat?.teardown();
      chat = undefined;
      vi.useRealTimers();
    }
  });
});

describe('три кнопки шапки переписки', () => {
  const btn = (name: string): HTMLButtonElement => q<HTMLButtonElement>(`.th-feed__head .th-iconbtn[data-toggle="${name}"]`)!;

  it('поиск, рассуждения, действия — кнопки-иконки с подписью без «Показать»; чекбоксов нет', async () => {
    entries = [HUMAN];
    await open();
    for (const [name, label] of [['search', 'feed.toggle.search'], ['thinking', 'feed.toggle.thinking'], ['actions', 'feed.toggle.actions']] as const) {
      const b = btn(name);
      expect(b.classList.contains('th-iconbtn')).toBe(true);
      expect(b.querySelector('svg')).not.toBeNull();
      expect(b.getAttribute('aria-label')).toBe(t(label));
      expect(b.title).toBe(t(label));
      expect(t(label)).not.toMatch(/Показать|Show/);
      expect(b.textContent).toBe('');
    }
    const icons = ['search', 'thinking', 'actions'].map((n) => btn(n).querySelector('svg')!.innerHTML);
    expect(new Set(icons).size).toBe(3);
    expect(q('.th-feed__head input[type="checkbox"]')).toBeNull();
    // По умолчанию: поиск выключен, рассуждения скрыты, действия показаны.
    expect(['search', 'thinking', 'actions'].map((n) => btn(n).getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
    expect(btn('actions').classList.contains('is-on')).toBe(true);
    expect(btn('search').classList.contains('is-on')).toBe(false);
  });

  it('поле поиска скрыто, пока кнопка выключена; включение показывает и ставит фокус, выключение прячет и сбрасывает запрос', async () => {
    entries = [HUMAN, AGENT];
    const c = await open();
    const field = q<HTMLInputElement>('.th-feed__query')!;
    expect(c.searchSlot.hidden).toBe(true);
    btn('search').click();
    expect(c.searchSlot.hidden).toBe(false);
    expect(btn('search').getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(field);
    field.value = 'Запустил';
    field.dispatchEvent(new Event('input'));
    await flush();
    expect(qa('.th-feed__hit').length).toBe(1);
    btn('search').click();
    expect(c.searchSlot.hidden).toBe(true);
    expect(field.value).toBe('');
    expect(qa('.th-feed__hit').length).toBe(0);
  });

  it('прыжок к записи работает и при скрытом поле поиска', async () => {
    entries = [HUMAN, AGENT];
    const c = await open();
    expect(c.searchSlot.hidden).toBe(true);
    await c.jumpTo('1:10');
    await flush();
    expect(feedCalls.some((o) => o.around === '1:10')).toBe(true);
    expect(q('.th-feed__entry.is-hit')).not.toBeNull();
  });

  it('рассуждения и действия переключаются кнопками', async () => {
    entries = [HUMAN, THINK, PLAIN];
    await open();
    expect(q('[data-kind="thinking"]')!.hidden).toBe(true);
    expect(q('[data-kind="tool"]')!.hidden).toBe(false);
    btn('thinking').click();
    btn('actions').click();
    expect(q('[data-kind="thinking"]')!.hidden).toBe(false);
    expect(q('[data-kind="tool"]')!.hidden).toBe(true);
    expect(btn('thinking').getAttribute('aria-pressed')).toBe('true');
    expect(btn('actions').getAttribute('aria-pressed')).toBe('false');
  });

  it('выбор каждой кнопки помнится; прежний ключ рассуждений действует', async () => {
    localStorage.setItem('termhub.feedThinking', '1');
    entries = [HUMAN, THINK, PLAIN];
    await open();
    expect(btn('thinking').getAttribute('aria-pressed')).toBe('true');
    btn('thinking').click();
    btn('actions').click();
    btn('search').click();
    expect(localStorage.getItem('termhub.feedThinking')).toBe('0');
    chat!.teardown();
    await open();
    expect(['search', 'thinking', 'actions'].map((n) => btn(n).getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(chat!.searchSlot.hidden).toBe(false);
    expect(q('[data-kind="tool"]')!.hidden).toBe(true);
  });

  it('лента без чата — прежние чекбоксы и всегда видимый поиск', async () => {
    entries = [HUMAN];
    const feed = mountFeed(host, 'work', transport());
    await flush();
    expect(q('.th-feed__head .th-iconbtn')).toBeNull();
    expect(q('.th-feed__toggle')).not.toBeNull();
    expect(q('.th-feed__show-actions')).not.toBeNull();
    expect(feed.searchSlot.hidden).toBe(false);
    feed.teardown();
  });
});
