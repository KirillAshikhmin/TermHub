// @vitest-environment happy-dom
// Живая часть вставлена в оболочку чата: полоса в своём месте, ряд управления перед
// полем ввода (место поля пустое), смена состояния агента тянет приращение переписки,
// ручка отдаёт `live` для поля ввода.
import type { LiveResult } from '@termhub/protocol/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { mountChat } from '../src/chat';
import { noteOverlayClosed } from '../src/overlay-events';
import { openModal } from '../src/ui';
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
    // над полем ввода — место карточки вопроса, над ним — ряд управления
    expect(chat.slots.composer.previousElementSibling).toBe(chat.slots.question);
    expect(chat.slots.question.previousElementSibling!.classList.contains('th-live__controls')).toBe(true);
    // окошко терминала — выше ряда управления, а не между карточкой и полем
    expect(chat.slots.terminal.compareDocumentPosition(chat.slots.question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

describe('чат: закрытие окна терминала ставит фокус в поле ввода', () => {
  const unknown: LiveResult = { ok: true, agent: 'claude', tested: true, screen: { kind: 'unknown' }, modes: [], models: [] };
  const coarse = (on: boolean): void => {
    window.matchMedia = ((query: string) => ({ matches: on && query.includes('coarse'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  };
  const field = (chat: ReturnType<typeof mountChat>): HTMLElement => chat.el.querySelector<HTMLElement>('.th-composer__field')!;
  const open = async (chat: ReturnType<typeof mountChat>): Promise<void> => {
    current = unknown;
    await vi.advanceTimersByTimeAsync(2100);
    expect(chat.el.querySelector<HTMLElement>('.th-chat-term')!.hidden).toBe(false);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  it('кнопка закрытия окна — фокус в поле ввода', async () => {
    coarse(false);
    current = state('idle');
    const chat = mountChat(host, 'work', transport);
    await open(chat);
    chat.el.querySelector<HTMLButtonElement>('.th-chat-term__close')!.click();
    expect(document.activeElement).toBe(field(chat));
    chat.teardown();
  });

  it('окно свернулось само после узнанного экрана — фокус в поле ввода; на телефоне — нет', async () => {
    coarse(false);
    current = state('idle');
    const chat = mountChat(host, 'work', transport);
    await open(chat);
    current = state('idle');
    await vi.advanceTimersByTimeAsync(2100);
    expect(chat.el.querySelector<HTMLElement>('.th-chat-term')!.hidden).toBe(true);
    expect(document.activeElement).toBe(field(chat));

    coarse(true);
    await open(chat);
    current = state('idle');
    await vi.advanceTimersByTimeAsync(2100);
    expect(chat.el.querySelector<HTMLElement>('.th-chat-term')!.hidden).toBe(true);
    expect(document.activeElement).not.toBe(field(chat));
    // кнопкой — ставится и на телефоне
    await open(chat);
    chat.el.querySelector<HTMLButtonElement>('.th-chat-term__close')!.click();
    expect(document.activeElement).toBe(field(chat));
    chat.teardown();
  });

  it('окно свернулось само: у поиска, палитры и окна настроек фокус не отбирается; из окна терминала — переходит в поле', async () => {
    coarse(false);
    current = state('idle');
    const chat = mountChat(host, 'work', transport);
    // Фокус в чужом поле (поиск по переписке, палитра, окно настроек — любое вне окна терминала).
    const other = document.createElement('input');
    document.body.append(other);
    await open(chat);
    other.focus();
    current = state('idle');
    await vi.advanceTimersByTimeAsync(2100);
    expect(chat.el.querySelector<HTMLElement>('.th-chat-term')!.hidden).toBe(true);
    expect(document.activeElement).toBe(other);

    // Фокус внутри окна терминала: окно ушло — фокус переходит в поле ввода.
    await open(chat);
    const inside = document.createElement('textarea');
    chat.el.querySelector<HTMLElement>('.th-chat-term')!.append(inside);
    inside.focus();
    current = state('idle');
    await vi.advanceTimersByTimeAsync(2100);
    expect(document.activeElement).toBe(field(chat));
    other.remove();
    chat.teardown();
  });

  it('фокус в поле своего ответа карточки вопроса не перехватывается', async () => {
    coarse(false);
    current = state('idle');
    const chat = mountChat(host, 'work', transport);
    await vi.advanceTimersByTimeAsync(10);
    chat.el.querySelector<HTMLButtonElement>('.th-live__term-btn')!.click(); // открыл сам
    current = {
      ok: true, agent: 'claude', tested: true, modes: [], models: [],
      screen: { kind: 'question', question: { stamp: 'F', title: 'Что?', freeText: true, options: [{ key: '1', label: 'Да' }, { key: '2', label: 'Type something.', free: true }] } },
    };
    await vi.advanceTimersByTimeAsync(1100);
    const own = chat.el.querySelector<HTMLInputElement>('.th-live-q__input')!;
    own.focus();
    chat.el.querySelector<HTMLButtonElement>('.th-chat-term__close')!.click();
    expect(document.activeElement).toBe(own);
    chat.teardown();
  });

  it('у гостя без поля ввода закрытие окна ничего не трогает', async () => {
    coarse(false);
    current = state('idle');
    const guest = { ...transport, clientScope: { write: false, files: false } } as unknown as Transport;
    const chat = mountChat(host, 'work', guest);
    await vi.advanceTimersByTimeAsync(10);
    chat.el.querySelector<HTMLButtonElement>('.th-live__term-btn')!.click();
    expect(() => chat.el.querySelector<HTMLButtonElement>('.th-chat-term__close')!.click()).not.toThrow();
    expect(chat.composer).toBeNull();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    chat.teardown();
  });
});

// История 21в: показ чата (переключение вида, вкладка другой сессии, возврат из проводника)
// ставит фокус в поле ввода — одним правилом с закрытием окна терминала.
describe('чат: фокус в поле ввода при показе', () => {
  const original = window.matchMedia;
  const coarse = (on: boolean): void => {
    window.matchMedia = ((query: string) => ({ matches: on && query.includes('coarse'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => {
    window.matchMedia = original;
  });
  const field = (chat: ReturnType<typeof mountChat>): HTMLTextAreaElement => chat.el.querySelector<HTMLTextAreaElement>('.th-composer__field')!;
  const boot = async (t: Transport = transport): Promise<ReturnType<typeof mountChat>> => {
    current = state('idle');
    const chat = mountChat(host, 'work', t);
    await vi.advanceTimersByTimeAsync(10);
    return chat;
  };

  it('показ ставит фокус в поле; нажатие на вкладку текущей сессии — тоже', async () => {
    coarse(false);
    const chat = await boot();
    expect(document.activeElement).not.toBe(field(chat));
    chat.focusInput();
    expect(document.activeElement).toBe(field(chat));
    field(chat).blur();
    await vi.advanceTimersByTimeAsync(3100); // полоса вкладок получила список
    host.querySelector<HTMLButtonElement>('.th-tab.is-active .th-tab__btn')!.click();
    expect(document.activeElement).toBe(field(chat));
    chat.teardown();
  });

  it('открытое окно (настройки, сведения), палитра, поле поиска и поле своего ответа фокус не теряют', async () => {
    coarse(false);
    const chat = await boot();
    for (const cls of ['th-overlay', 'th-palette']) {
      const layer = document.createElement('div');
      layer.className = cls;
      const input = document.createElement('input');
      layer.append(input);
      document.body.append(layer);
      input.focus();
      chat.focusInput();
      expect(document.activeElement).toBe(input);
      layer.remove();
    }
    const query = chat.el.querySelector<HTMLInputElement>('.th-feed__query')!;
    chat.searchSlot.hidden = false;
    query.focus();
    chat.focusInput();
    expect(document.activeElement).toBe(query);
    chat.teardown();
  });

  it('закрытие окна поверх чата (настройки, расход, палитра — общий openModal) возвращает фокус в поле ввода', async () => {
    coarse(false);
    const chat = await boot();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    let closeIt: () => void = () => {};
    openModal((close) => {
      closeIt = () => close();
      const card = document.createElement('div');
      card.append(document.createElement('input'));
      return card;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).not.toBe(field(chat));
    closeIt();
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).toBe(field(chat));
    opener.remove();
    chat.teardown();
  });

  it('закрыли одно окно из двух — фокус не перехватывается, пока открыто второе', async () => {
    coarse(false);
    const chat = await boot();
    // Второе окно — другого вида (просмотр картинки): у него своё закрытие.
    const viewer = document.createElement('div');
    viewer.className = 'th-imgview';
    document.body.append(viewer);
    let closeModal: () => void = () => {};
    openModal((close) => {
      closeModal = () => close();
      const card = document.createElement('div');
      card.append(document.createElement('input'));
      return card;
    });
    await vi.advanceTimersByTimeAsync(50);
    closeModal();
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).not.toBe(field(chat));
    viewer.remove();
    noteOverlayClosed();
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).toBe(field(chat));
    chat.teardown();
  });

  it('прочие окна сообщают о закрытии тем же событием; возврат на вкладку браузера — тоже фокус в поле', async () => {
    coarse(false);
    const chat = await boot();
    field(chat).blur();
    noteOverlayClosed();
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).toBe(field(chat));
    field(chat).blur();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).toBe(field(chat));
    field(chat).blur();
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).toBe(field(chat));
    // После снятия чата событие никого не трогает.
    chat.teardown();
    expect(() => noteOverlayClosed()).not.toThrow();
  });

  it('грубый указатель: фокус после закрытия окна — тихий; гость без поля — ничего', async () => {
    coarse(true);
    const chat = await boot();
    noteOverlayClosed();
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).toBe(field(chat));
    expect(field(chat).getAttribute('inputmode')).toBe('none');
    chat.teardown();
    const guest = await boot({ ...transport, clientScope: { write: false, files: false } } as unknown as Transport);
    noteOverlayClosed();
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    guest.teardown();
  });

  it('гость без поля: показ ничего не трогает', async () => {
    coarse(false);
    const chat = await boot({ ...transport, clientScope: { write: false, files: false } } as unknown as Transport);
    expect(() => chat.focusInput()).not.toThrow();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    chat.teardown();
  });

  it('грубый указатель: фокус ставится с inputmode=none (клавиатура не выскакивает), касание поля возвращает обычный ввод', async () => {
    coarse(true);
    const chat = await boot();
    chat.focusInput();
    const f = field(chat);
    expect(document.activeElement).toBe(f);
    expect(f.getAttribute('inputmode')).toBe('none');
    f.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(f.getAttribute('inputmode')).toBeNull();
    // Точный указатель режим поля не трогает.
    coarse(false);
    f.blur();
    chat.focusInput();
    expect(f.getAttribute('inputmode')).toBeNull();
    chat.teardown();
  });
});
