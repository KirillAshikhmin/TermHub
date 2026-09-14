// @vitest-environment happy-dom
// Поиск по ленте: чистая функция над загруженными записями и то, что видит человек
// сверху ленты. Транспорт подделан (единственный шов), разметка — happy-dom.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountFeed, searchFeed } from '../src/feed';
import { setLang, t } from '../src/i18n';
import type { FeedEntry, FeedOptions, FeedPage, FeedResult, Transport } from '../src/transport';

/** Запись с курсором: по умолчанию — реплика человека. */
function entry(over: Partial<FeedEntry> & { id: string }): FeedEntry {
  return { at: 1_700_000_000_000, kind: 'human', text: '', cursor: `c${over.id}`, ...over };
}

/** Страница с разумными краями: переопределяем только то, что проверяем. */
function page(over: Partial<FeedPage> = {}): FeedPage {
  return {
    ok: true,
    agent: 'claude',
    entries: [],
    head: 'h',
    tail: 'tl',
    bof: false,
    eof: true,
    complete: true,
    live: false,
    skipped: 0,
    ...over,
  };
}

/** Транспорт с подставным ответом ленты; журнал — что именно у него спросили. */
function feedTransport(answer: (opts: FeedOptions) => FeedResult): {
  transport: Transport;
  calls: FeedOptions[];
} {
  const calls: FeedOptions[] = [];
  const transport = {
    mode: 'lan',
    clientScope: null,
    capabilities: async () => ['feed'],
    gradle: async () => null,
    list: async () => [],
    feed: async (_session: string, opts: FeedOptions = {}) => {
      calls.push(opts);
      return answer(opts);
    },
  } as unknown as Transport;
  return { transport, calls };
}

let host: HTMLElement;

beforeEach(() => {
  // Часы поддельные во всём файле: поиск лезет за пределы загруженного не сразу,
  // а переждав набор слова.
  vi.useFakeTimers();
  localStorage.clear();
  setLang('ru');
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  vi.useRealTimers();
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** Ввод буквы без ожидания: так печатает человек — событие за событием. */
function pressQuery(text: string): void {
  const field = host.querySelector('.th-feed__query') as HTMLInputElement;
  field.value = text;
  field.dispatchEvent(new Event('input'));
}
const hits = (): HTMLElement[] => [...host.querySelectorAll('.th-feed__hit')] as HTMLElement[];
const status = (): string => (host.querySelector('.th-feed__searchstatus') as HTMLElement | null)?.textContent ?? '';
const more = (): HTMLButtonElement | null => host.querySelector('.th-feed__searchmore');

/** Ввод запроса человеком: слово набрано, и набор окончен. */
async function typeQuery(text: string): Promise<void> {
  pressQuery(text);
  await vi.advanceTimersByTimeAsync(1000);
}

describe('поиск по загруженному', () => {
  it('не различает регистр и отдаёт строку вокруг совпадения', () => {
    const items = [
      entry({ id: '1', text: 'первая строка\nвторая со словом ЛЕНТА внутри\nтретья строка' }),
      entry({ id: '2', text: 'ничего похожего' }),
    ];

    const hits = searchFeed(items, 'лента');

    expect(hits.map((h) => h.entry.id)).toEqual(['1']);
    expect(hits[0]?.snippet).toBe('вторая со словом ЛЕНТА внутри');
  });

  it('не предлагает точкой прыжка запись без курсора', () => {
    const items = [
      { id: 'n', at: 1, kind: 'note', note: 'chain', text: 'склейка беседы' } as FeedEntry,
      entry({ id: 'ok', text: 'склейка беседы видна и здесь' }),
    ];

    expect(searchFeed(items, 'склейка').map((h) => h.entry.id)).toEqual(['ok']);
  });

  it('длинную строку показывает окном вокруг совпадения, обрезанные края — многоточием', () => {
    // Строка в 406 знаков: 200 «a», слово, 200 «b». Окно — 120 знаков вокруг слова,
    // значит по 57 знаков с каждой стороны (120 − 6 на само слово, пополам).
    const long = entry({ id: 'long', text: `${'a'.repeat(200)}ИГОЛКА${'b'.repeat(200)}` });
    // Та же длина, но слово в самом начале: слева резать нечего.
    const head = entry({ id: 'head', text: `ИГОЛКА${'b'.repeat(400)}` });

    expect(searchFeed([long], 'иголка')[0]?.snippet).toBe(`…${'a'.repeat(57)}ИГОЛКА${'b'.repeat(57)}…`);
    expect(searchFeed([head], 'иголка')[0]?.snippet).toBe(`ИГОЛКА${'b'.repeat(114)}…`);
  });

  it('на пустой запрос не находит ничего', () => {
    expect(searchFeed([entry({ id: '1', text: 'что-нибудь' })], '   ')).toEqual([]);
  });
});

describe('поиск сверху ленты', () => {
  it('отвечает по загруженному, не ходя к агенту', async () => {
    const human: FeedEntry = { id: 'e1', at: 1_700_000_000_000, kind: 'human', text: 'собери ленту', cursor: '7:0' };
    const agent: FeedEntry = { id: 'e2', at: 1_700_000_001_000, kind: 'agent', text: 'готово', cursor: '7:40' };
    const { transport, calls } = feedTransport(() => page({ entries: [human, agent], bof: true }));
    const feed = mountFeed(host, 'work', transport);
    await flush();

    await typeQuery('ГОТОВО');

    expect(hits()).toHaveLength(1);
    expect(hits()[0]?.textContent).toContain('готово');
    expect(status()).toBe(t('feed.search.found', { n: 1 }));
    // Хвост спросили при открытии — и больше ни одного запроса ради поиска.
    expect(calls).toHaveLength(1);
    feed.teardown();
  });
});

describe('переход к найденному месту', () => {
  it('нажатие на находку переносит ленту к записи и подсвечивает её', async () => {
    const far: FeedEntry = { id: 'far', at: 1_700_000_000_000, kind: 'agent', text: 'нашлось далеко', cursor: '9:99' };
    const near: FeedEntry = { id: 'near', at: 1_700_000_050_000, kind: 'human', text: 'свежее', cursor: '9:120' };
    const { transport, calls } = feedTransport((opts) => {
      if (opts.around) return page({ entries: [far, near], bof: true });
      if (opts.before) return page({ entries: [far], bof: true });
      return page({ entries: [near] });
    });
    const feed = mountFeed(host, 'work', transport);
    await flush();

    // Слова нет в хвосте — поиск сам дочитал назад и нашёл там.
    await typeQuery('далеко');
    await flush();
    expect(hits()).toHaveLength(1);

    hits()[0]?.dispatchEvent(new Event('click'));
    await flush();

    expect(calls[calls.length - 1]).toEqual({ limit: 100, around: '9:99' });
    const hit = host.querySelector('.th-feed__entry.is-hit') as HTMLElement | null;
    expect(hit?.textContent).toContain('нашлось далеко');
    feed.teardown();
  });

  it('после прыжка список находок говорит про новое окно, а не про снесённое', async () => {
    const first: FeedEntry = { id: 'f1', at: 1, kind: 'human', text: 'иголка в хвосте', cursor: 'c1' };
    const second: FeedEntry = { id: 'f2', at: 2, kind: 'agent', text: 'иголка ещё раз', cursor: 'c2' };
    const plain: FeedEntry = { id: 'f3', at: 3, kind: 'agent', text: 'рядом, без слова', cursor: 'c3' };
    const { transport } = feedTransport((opts) =>
      // Окно вокруг находки — другое: в нём эта запись и её сосед без слова.
      opts.around ? page({ entries: [first, plain], bof: true }) : page({ entries: [first, second], bof: true }),
    );
    const feed = mountFeed(host, 'work', transport);
    await flush();

    await typeQuery('иголка');
    expect(hits()).toHaveLength(2);

    hits()[0]?.dispatchEvent(new Event('click'));
    await flush();

    // Прежнее окно снесено прыжком: находок в новом ровно одна, и счёт про неё.
    expect(hits()).toHaveLength(1);
    expect(status()).toBe(t('feed.search.found', { n: 1 }));
    feed.teardown();
  });
});

describe('дочитывание назад', () => {
  it('упёршись в предел, говорит, сколько просмотрел, и продолжает по просьбе', async () => {
    let n = 0;
    const { transport, calls } = feedTransport((opts) => {
      if (!opts.before) return page({ entries: [{ id: 'tail', at: 1, kind: 'human', text: 'хвост', cursor: 'c0' }] });
      n += 1;
      // Беседа длиннее любого предела: край не достигнут, слова нет ни на одной странице.
      return page({
        entries: [{ id: `o${n}`, at: 1, kind: 'agent', text: `страница ${n}`, cursor: `c${n}` }],
        head: `h${n}`,
      });
    });
    const feed = mountFeed(host, 'work', transport);
    await flush();

    await typeQuery('иголка');
    await flush();

    // Двадцать страниц назад — и остановка со счётом просмотренных (хвост + 20).
    expect(calls.filter((c) => c.before)).toHaveLength(20);
    expect(status()).toBe(t('feed.search.limit', { n: 21 }));
    expect(more()?.hidden).toBe(false);
    expect(hits()).toHaveLength(0);

    more()?.dispatchEvent(new Event('click'));
    await flush();
    expect(calls.filter((c) => c.before)).toHaveLength(40);
    expect(status()).toBe(t('feed.search.limit', { n: 41 }));
    feed.teardown();
  });

  it('дойдя до начала беседы, говорит, что просмотрел её всю, и кнопки не даёт', async () => {
    const { transport } = feedTransport((opts) =>
      opts.before
        ? page({ entries: [{ id: 'first', at: 1, kind: 'human', text: 'самое начало', cursor: 'c1' }], bof: true })
        : page({ entries: [{ id: 'tail', at: 2, kind: 'agent', text: 'хвост', cursor: 'c2' }], head: 'h1' }),
    );
    const feed = mountFeed(host, 'work', transport);
    await flush();

    await typeQuery('иголка');
    await flush();

    expect(status()).toBe(t('feed.search.all'));
    expect(more()?.hidden).toBe(true);
    feed.teardown();
  });

  it('дочитывает один раз на слово, а не на каждую букву', async () => {
    let back = 0;
    const { transport, calls } = feedTransport((opts) => {
      if (!opts.before) return page({ entries: [{ id: 'tail', at: 1, kind: 'human', text: 'хвост', cursor: 'c0' }] });
      back += 1;
      return page({
        entries: [{ id: `o${back}`, at: 1, kind: 'agent', text: `страница ${back}`, cursor: `c${back}` }],
        head: `h${back}`,
        bof: back >= 2,
      });
    });
    const feed = mountFeed(host, 'work', transport);
    await vi.advanceTimersByTimeAsync(0);

    // Три быстрых нажатия подряд: слово набирают по букве, а лента не должна
    // начинать по заходу дочитывания на каждую.
    pressQuery('и');
    pressQuery('иг');
    pressQuery('игл');
    await vi.advanceTimersByTimeAsync(1000);

    // Один заход, дошедший до начала беседы, — и его честный итог.
    expect(calls.filter((c) => c.before)).toHaveLength(2);
    expect(status()).toBe(t('feed.search.all'));
    expect(more()?.hidden).toBe(true);
    feed.teardown();
  });

  it('заход поверх идущего не теряет и не повторяет страницу, а счёт не врёт', async () => {
    const asked: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = feedTransport((opts) => {
      if (opts.before === 'h0') {
        return page({ entries: [{ id: 'p1', at: 2, kind: 'agent', text: 'первая назад', cursor: 'c1' }], head: 'h1' });
      }
      if (opts.before === 'h1') {
        return page({ entries: [{ id: 'p2', at: 3, kind: 'agent', text: 'тут нитка', cursor: 'c2' }], head: 'h2' });
      }
      return page({ entries: [{ id: 'tail', at: 1, kind: 'human', text: 'хвост', cursor: 'c0' }], head: 'h0' });
    });
    const slow = {
      ...base.transport,
      feed: async (session: string, opts: FeedOptions = {}) => {
        if (opts.before) asked.push(opts.before);
        // Первая страница назад висит: пока её читают, человек набирает другое слово.
        if (opts.before === 'h0') await held;
        return (base.transport as unknown as { feed: (s: string, o: FeedOptions) => Promise<FeedResult> }).feed(
          session,
          opts,
        );
      },
    } as unknown as Transport;
    const feed = mountFeed(host, 'work', slow);
    await vi.advanceTimersByTimeAsync(0);

    await typeQuery('иголка'); // заход пошёл и повис на первой странице
    expect(asked).toEqual(['h0']);
    await typeQuery('нитка'); // второе слово — поверх идущего захода

    release();
    await vi.advanceTimersByTimeAsync(1000);

    // Страницу, дочитанную первым заходом, второй увидел (её не перезапрашивали),
    // и пошёл дальше — до той, где слово есть.
    expect(asked).toEqual(['h0', 'h1']);
    expect(status()).toBe(t('feed.search.found', { n: 1 }));
    expect(hits()[0]?.textContent).toContain('тут нитка');
    feed.teardown();
  });
});
