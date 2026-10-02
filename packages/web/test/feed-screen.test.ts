// @vitest-environment happy-dom
// Экран ленты: что видно на нём и когда он ходит к агенту. Транспорт подделан
// (единственный шов), разметка — happy-dom. Страницы написаны руками по interfaces.md.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { mountFeed, searchFeed } from '../src/feed';
import { setLang, t } from '../src/i18n';
import type { FeedEntry, FeedOptions, FeedPage, FeedResult, Transport } from '../src/transport';

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

const HUMAN: FeedEntry = { id: 'e1', at: 1_700_000_000_000, kind: 'human', text: 'собери ленту', cursor: '7:0' };
const AGENT: FeedEntry = { id: 'e2', at: 1_700_000_001_000, kind: 'agent', text: 'готово', cursor: '7:40' };
const TOOL: FeedEntry = { id: 'e3', at: 1_700_000_002_000, kind: 'tool', text: 'прочитал feed.ts', tool: 'Read' };
const THINK: FeedEntry = { id: 'e4', at: 1_700_000_003_000, kind: 'thinking', text: 'надо бы проверить края' };

let host: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  vi.useRealTimers();
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const list = (): HTMLElement => host.querySelector('.th-feed__list') as HTMLElement;
const entries = (kind?: string): HTMLElement[] =>
  [...host.querySelectorAll(`.th-feed__entry${kind ? `[data-kind="${kind}"]` : ''}`)] as HTMLElement[];
const notice = (): string => (host.querySelector('.th-feed__notice') as HTMLElement | null)?.textContent ?? '';

describe('лента при открытии', () => {
  it('спрашивает хвост и показывает разговор: реплики целиком, инструмент строчкой', async () => {
    const { transport, calls } = feedTransport(() => page({ entries: [HUMAN, AGENT, TOOL] }));
    const feed = mountFeed(host, 'work', transport);
    await flush();

    // Первый запрос — без курсоров: это и есть хвост беседы.
    expect(calls[0]).toEqual({ limit: 100 });
    expect(entries('human')[0]?.textContent).toContain('собери ленту');
    expect(entries('agent')[0]?.textContent).toContain('готово');
    const tool = entries('tool')[0];
    expect(tool?.textContent).toContain('Read');
    expect(tool?.textContent).toContain('прочитал feed.ts');
    feed.teardown();
  });

  it('не повторяет имя инструмента, если агент уже начал им текст', async () => {
    const dup: FeedEntry = { id: 'e5', at: 1_700_000_004_000, kind: 'tool', text: 'Bash cd apps && git add .', tool: 'Bash' };
    const { transport } = feedTransport(() => page({ entries: [dup] }));
    const feed = mountFeed(host, 'work', transport);
    await flush();

    const toolText = host.querySelector('.th-feed__tooltext')?.textContent ?? '';
    expect(toolText).toBe('cd apps && git add .');
    expect(host.querySelector('.th-feed__toolname')?.textContent).toBe('Bash');
    feed.teardown();
  });

  it('прячет мышление, пока не включён тумблер, и помнит выбор между открытиями', async () => {
    const { transport } = feedTransport(() => page({ entries: [THINK, AGENT] }));
    const first = mountFeed(host, 'work', transport);
    await flush();
    expect(entries('thinking')[0]?.hidden).toBe(true);

    const toggle = host.querySelector('.th-feed__toggle') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(entries('thinking')[0]?.hidden).toBe(false);
    first.teardown();

    // Новое открытие — выбор пережил его.
    host.replaceChildren();
    const second = mountFeed(host, 'work', transport);
    await flush();
    expect(entries('thinking')[0]?.hidden).toBe(false);
    second.teardown();
  });

  it('говорит про обрезанный текст, веху и неразобранные строки', async () => {
    const { transport } = feedTransport(() =>
      page({
        entries: [
          { id: 'n1', at: 1, kind: 'note', note: 'compacted', text: '' },
          { id: 'b1', at: 2, kind: 'agent', text: 'длинно', truncated: true },
        ],
        skipped: 3,
        complete: false,
      }),
    );
    const feed = mountFeed(host, 'work', transport);
    await flush();

    expect(entries('note')[0]?.textContent).toContain(t('feed.note.compacted'));
    expect(entries('agent')[0]?.textContent).toContain(t('feed.truncated'));
    expect(host.querySelector('.th-feed__skipped')?.textContent).toBe(t('feed.skipped', { n: 3 }));
    expect(host.querySelector('.th-feed__edge')?.textContent).toBe(t('feed.incomplete'));
    feed.teardown();
  });
});

describe('листание вверх', () => {
  it('шагает через пустую страницу и останавливается по bof, а не по пустому списку', async () => {
    const older: FeedEntry = { id: 'old', at: 5, kind: 'human', text: 'самое начало' };
    const { transport, calls } = feedTransport((opts) => {
      if (!opts.before) return page({ entries: [AGENT], head: 'h1' });
      // Шаг через строку, не влезшую в окно: записей нет, но край НЕ достигнут.
      if (opts.before === 'h1') return page({ entries: [], head: 'h2', bof: false });
      return page({ entries: [older], head: 'h3', bof: true });
    });
    const feed = mountFeed(host, 'work', transport);
    await flush();

    list().dispatchEvent(new Event('scroll'));
    await flush();

    expect(calls.slice(1)).toEqual([
      { limit: 100, before: 'h1' },
      { limit: 100, before: 'h2' },
    ]);
    expect(entries('human')[0]?.textContent).toContain('самое начало');

    // Край достигнут — дальше не ходим ни при каком листании.
    list().dispatchEvent(new Event('scroll'));
    await flush();
    expect(calls).toHaveLength(3);
    expect(host.querySelector('.th-feed__edge')?.textContent).toBe(t('feed.start'));
    feed.teardown();
  });
});

describe('приращение', () => {
  it('идёт только на показанной вкладке и только пока агент работает', async () => {
    vi.useFakeTimers();
    const view = document.createElement('div');
    view.className = 'th-ws-view'; // вкладка смонтирована, но не показана
    host.append(view);
    const { transport, calls } = feedTransport((opts) =>
      opts.after ? page({ entries: [AGENT], tail: 'tl2', live: true }) : page({ entries: [HUMAN], live: true }),
    );
    const feed = mountFeed(view, 'work', transport);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(9000);
    expect(calls).toHaveLength(1); // вкладка скрыта — опроса нет

    view.classList.add('is-active');
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls[1]).toEqual({ limit: 100, after: 'tl' });
    feed.teardown();
  });

  it('не спрашивает продолжения у мёртвого агента', async () => {
    vi.useFakeTimers();
    const { transport, calls } = feedTransport(() => page({ entries: [AGENT], live: false }));
    const feed = mountFeed(host, 'work', transport);
    await vi.advanceTimersByTimeAsync(9000);
    expect(calls).toHaveLength(1);
    feed.teardown();
  });
});

describe('отказы', () => {
  /** Слова, которыми лента объясняет отказ (снимаются до teardown — он сносит экран). */
  const explain = async (reason: string, detail: string): Promise<string> => {
    const { transport } = feedTransport(() => ({ ok: false, reason, detail }) as FeedResult);
    const feed = mountFeed(host, 'work', transport);
    await flush();
    const text = notice();
    feed.teardown();
    return text;
  };
  const saidFor = (reason: string): Promise<string> => explain(reason, 'детали от агента');

  it('на каждую причину — свои слова, и «беседу ещё не начинали» не путается со сбоем', async () => {
    const said: string[] = [];
    for (const reason of ['no-agent', 'no-transcript', 'unknown-format', 'lookup-failed', 'forbidden']) {
      host.replaceChildren();
      said.push(await saidFor(reason));
    }
    expect(new Set(said).size).toBe(5);
    expect(said[1]).toContain(t('feed.fail.noTranscript'));
    expect(said[3]).toContain(t('feed.fail.lookupFailed'));
    expect(said[3]).toContain('детали от агента');
  });

  it('на пустом экране даёт дорогу назад, а загруженную беседу отказом не стирает', async () => {
    let broken = true;
    const { transport } = feedTransport(() =>
      broken ? ({ ok: false, reason: 'lookup-failed', detail: '' } as FeedResult) : page({ entries: [AGENT] }),
    );
    const feed = mountFeed(host, 'work', transport);
    await flush();
    const retry = host.querySelector('.th-feed__notice .th-loaderror button') as HTMLButtonElement;
    expect(retry).not.toBeNull();

    broken = false;
    retry.click();
    await flush();
    expect(entries('agent')).toHaveLength(1);
    expect(notice()).toBe('');

    // Беседа уже на экране: следующий отказ говорит строкой, но записи не стирает.
    broken = true;
    await feed.loadOlder();
    expect(entries('agent')).toHaveLength(1);
    expect(host.querySelector('.th-feed__notice .th-loaderror')).toBeNull();
    expect(notice()).toContain(t('feed.fail.lookupFailed'));
    feed.teardown();
  });

  it('устаревший курсор не показывается: лента молча берёт хвост заново', async () => {
    let stale = true;
    const { transport, calls } = feedTransport((opts) => {
      if (opts.before && stale) {
        stale = false;
        return { ok: false, reason: 'cursor-stale', detail: '' };
      }
      return page({ entries: [AGENT], head: 'h1' });
    });
    const feed = mountFeed(host, 'work', transport);
    await flush();
    list().dispatchEvent(new Event('scroll'));
    await flush();

    expect(calls[2]).toEqual({ limit: 100 }); // хвост заново, без курсора
    expect(notice()).toBe('');
    feed.teardown();
  });

  it('повторный устаревший курсор на том же действии показывается как сбой', async () => {
    const { transport } = feedTransport((opts) =>
      opts.before || opts.after
        ? ({ ok: false, reason: 'cursor-stale', detail: '' } as FeedResult)
        : ({ ok: false, reason: 'cursor-stale', detail: '' } as FeedResult),
    );
    const feed = mountFeed(host, 'work', transport);
    await flush();
    expect(notice()).toContain(t('feed.fail.lookupFailed'));
    feed.teardown();
  });
});

describe('что лента даёт поиску', () => {
  it('отдаёт загруженные записи, дочитывает назад и переносит к месту с подсветкой', async () => {
    const target: FeedEntry = { id: 'far', at: 9, kind: 'human', text: 'найди меня', cursor: '9:99' };
    const { transport, calls } = feedTransport((opts) => {
      if (opts.around) return page({ entries: [target, AGENT], bof: true });
      if (opts.before) return page({ entries: [target], bof: true });
      return page({ entries: [HUMAN] });
    });
    const feed = mountFeed(host, 'work', transport);
    await flush();
    expect(feed.entries().map((e) => e.id)).toEqual(['e1']);

    // Дочитывание назад: вернулось «есть ли ещё», и записи прибавились спереди.
    expect(await feed.loadOlder()).toBe(false);
    expect(feed.entries().map((e) => e.id)).toEqual(['far', 'e1']);

    await feed.jumpTo('9:99');
    expect(calls[calls.length - 1]).toEqual({ limit: 100, around: '9:99' });
    // Окно началось заново с той страницы, и запись подсвечена.
    expect(feed.entries().map((e) => e.id)).toEqual(['far', 'e2']);
    expect(host.querySelector('.th-feed__entry.is-hit')?.textContent).toContain('найди меня');
    feed.teardown();
  });
});

describe('очередь запросов', () => {
  it('ждёт своей очереди, а не шлёт второй запрос поверх идущего', async () => {
    vi.useFakeTimers();
    let release = (): void => {};
    // Журнал провода: запрос попадает в него в момент отправки, ещё до ответа, —
    // иначе «дождался очереди» и «ушёл параллельно» выглядели бы одинаково.
    const wire: string[] = [];
    const { transport } = feedTransport(() => page({ entries: [AGENT], head: 'h1', live: true }));
    const slow = {
      ...transport,
      feed: async (session: string, opts: FeedOptions = {}) => {
        wire.push(opts.after ? 'after' : opts.before ? 'before' : 'tail');
        // Приращение зависает: пока оно в полёте, пользователь долистывает до верха.
        if (opts.after) await new Promise<void>((resolve) => (release = resolve));
        return (transport as unknown as { feed: (s: string, o: FeedOptions) => Promise<FeedResult> }).feed(
          session,
          opts,
        );
      },
    } as unknown as Transport;
    const feed = mountFeed(host, 'work', slow);
    await vi.advanceTimersByTimeAsync(3000); // приращение ушло и повисло без ответа

    list().dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(0);
    // Пока приращение без ответа, второго запроса на проводе нет: листание ждёт.
    expect(wire).toEqual(['tail', 'after']);

    release();
    await vi.advanceTimersByTimeAsync(0);
    // И не потеряно: повторить его пользователь не может — он уже у верхнего края.
    expect(wire).toEqual(['tail', 'after', 'before']);
    feed.teardown();
  });

  it('решает про низ в момент вклейки: ушедшего листать историю приращение не тянет вниз', async () => {
    vi.useFakeTimers();
    let release = (): void => {};
    const { transport } = feedTransport((opts) =>
      // Продолжение — НОВАЯ запись: повтор уже известной не вклеивался бы вовсе,
      // и проверять было бы нечего.
      opts.after ? page({ entries: [TOOL], tail: 'tl2', live: true }) : page({ entries: [AGENT], live: true }),
    );
    const slow = {
      ...transport,
      feed: async (session: string, opts: FeedOptions = {}) => {
        if (opts.after) await new Promise<void>((resolve) => (release = resolve));
        return (transport as unknown as { feed: (s: string, o: FeedOptions) => Promise<FeedResult> }).feed(
          session,
          opts,
        );
      },
    } as unknown as Transport;
    const feed = mountFeed(host, 'work', slow);
    await vi.advanceTimersByTimeAsync(0);
    // happy-dom раскладки не считает — высоты задаём сами, иначе «низ» неотличим.
    const l = list();
    Object.defineProperty(l, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(l, 'clientHeight', { value: 200, configurable: true });
    l.scrollTop = 900; // в момент запроса пользователь внизу
    await vi.advanceTimersByTimeAsync(3000);
    l.scrollTop = 0; // пока ответ в пути, ушёл читать историю
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(entries('tool')).toHaveLength(1); // продолжение действительно вклеено
    expect(l.scrollTop).toBe(0);
    feed.teardown();
  });
});

describe('края окна', () => {
  it('говорит, что читает беседу, пока первая страница в пути', async () => {
    let release = (): void => {};
    const { transport } = feedTransport(() => page({ entries: [AGENT] }));
    const slow = {
      ...transport,
      feed: async (session: string, opts: FeedOptions = {}) => {
        await new Promise<void>((resolve) => (release = resolve));
        return (transport as unknown as { feed: (s: string, o: FeedOptions) => Promise<FeedResult> }).feed(
          session,
          opts,
        );
      },
    } as unknown as Transport;
    const feed = mountFeed(host, 'work', slow);
    await flush();
    expect(host.querySelector('.th-feed__edge')?.textContent).toBe(t('feed.loading'));

    release();
    await flush();
    expect(host.querySelector('.th-feed__edge')?.textContent).not.toBe(t('feed.loading'));
    feed.teardown();
  });

  it('говорит про непрочитанное продолжение, пока окно не дошло до конца беседы', async () => {
    const { transport, calls } = feedTransport((opts) =>
      opts.after
        ? page({ entries: [TOOL], tail: 'tl2', eof: true })
        : page({ entries: [AGENT], tail: 'tl', eof: false }),
    );
    const feed = mountFeed(host, 'work', transport);
    await flush();
    const tail = (): HTMLElement => host.querySelector('.th-feed__edge--tail') as HTMLElement;
    expect(tail().hidden).toBe(false);
    expect(tail().textContent).toBe(t('feed.tailMore'));

    // У нижнего края лента дочитывает вперёд — как у верхнего дочитывает назад.
    list().scrollTop = 500;
    list().dispatchEvent(new Event('scroll'));
    await flush();
    expect(calls[1]).toEqual({ limit: 100, after: 'tl' });
    expect(tail().hidden).toBe(true);
    feed.teardown();
  });
});

describe('ответ о дочитывании назад', () => {
  it('вторая просьба ждёт ту же подкачку, а не отвечает «занят» словом о беседе', async () => {
    const older: FeedEntry = { id: 'old', at: 5, kind: 'human', text: 'самое начало' };
    let release = (): void => {};
    const { transport, calls } = feedTransport((opts) =>
      opts.before ? page({ entries: [older], head: 'h2', bof: true }) : page({ entries: [AGENT], head: 'h1' }),
    );
    const slow = {
      ...transport,
      feed: async (session: string, opts: FeedOptions = {}) => {
        if (opts.before) await new Promise<void>((resolve) => (release = resolve));
        return (transport as unknown as { feed: (s: string, o: FeedOptions) => Promise<FeedResult> }).feed(
          session,
          opts,
        );
      },
    } as unknown as Transport;
    const feed = mountFeed(host, 'work', slow);
    await flush();

    const first = feed.loadOlder();
    const second = feed.loadOlder(); // пришла поверх идущей
    let secondAnswered = false;
    void second.then(() => (secondAnswered = true));
    await flush();
    // Пока подкачка в полёте, второй просьбе отвечать нечем: «занят» она бы
    // приняла за прочитанную страницу.
    expect(secondAnswered).toBe(false);

    release();
    expect(await first).toBe(false); // начало беседы достигнуто
    expect(await second).toBe(false); // тот же настоящий итог, а не «есть ещё»
    expect(calls.filter((c) => c.before).length).toBe(1);
    feed.teardown();
  });
});

describe('переход к находке', () => {
  // Курсор у агента общий на всю строку транскрипта, поэтому записей с ним бывает
  // несколько — и первой из них у Claude часто стоит мышление.
  const think: FeedEntry = { id: 't1', at: 1, kind: 'thinking', text: 'прикидываю', cursor: 'c1' };
  const reply: FeedEntry = { id: 'a1', at: 2, kind: 'agent', text: 'вот ответ', cursor: 'c1' };

  it('отмечает видимую запись строки, а не скрытое мышление перед ней', async () => {
    const { transport } = feedTransport(() => page({ entries: [think, reply] }));
    const feed = mountFeed(host, 'work', transport);
    await flush();
    await feed.jumpTo('c1');

    const marked = [...host.querySelectorAll('.th-feed__entry.is-hit')] as HTMLElement[];
    const visible = marked.filter((e) => !e.hidden);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.dataset.kind).toBe('agent');
    // Выбор тумблера переход не трогает.
    expect(entries('thinking')[0]?.hidden).toBe(true);
    feed.teardown();
  });

  it('находку в скрытом мышлении показывает — иначе переход остался бы без следа', async () => {
    const { transport } = feedTransport(() => page({ entries: [think] }));
    const feed = mountFeed(host, 'work', transport);
    await flush();
    await feed.jumpTo('c1');

    const mark = host.querySelector('.th-feed__entry.is-hit') as HTMLElement;
    expect(mark?.dataset.kind).toBe('thinking');
    expect(mark.hidden).toBe(false);
    // Показана одна запись, ради которой прыгали, — тумблер остался выключен.
    expect((host.querySelector('.th-feed__toggle') as HTMLInputElement).checked).toBe(false);
    feed.teardown();
  });
});

describe('оба края сразу', () => {
  it('дочитывает вперёд и тогда, когда беседа короче экрана и близок ещё и верх', async () => {
    const older: FeedEntry = { id: 'old', at: 1, kind: 'human', text: 'начало' };
    // Агент мёртв: опроса нет вовсе, и хвост дочитать может только нижний край.
    const { transport, calls } = feedTransport((opts) => {
      if (opts.before) return page({ entries: [older], head: 'h2', bof: true, eof: false, live: false });
      if (opts.after) return page({ entries: [TOOL], tail: 'tl2', eof: true, live: false });
      return page({ entries: [AGENT], head: 'h1', tail: 'tl', eof: false, live: false });
    });
    const feed = mountFeed(host, 'work', transport);
    await flush();

    // В happy-dom высот нет: верхний край близок всегда — как на короткой беседе.
    list().dispatchEvent(new Event('scroll'));
    await flush();

    expect(calls.some((c) => c.before === 'h1')).toBe(true);
    expect(calls.some((c) => c.after === 'tl')).toBe(true);
    expect(entries('tool')).toHaveLength(1);
    feed.teardown();
  });

  it('снесённый экран отвечает «ответа нет», а не краем беседы', async () => {
    const { transport } = feedTransport(() => page({ entries: [AGENT], head: 'h1' }));
    const feed = mountFeed(host, 'work', transport);
    await flush();
    feed.teardown();

    expect(await feed.loadOlder()).toBeNull();
  });
});

// ── Разметка и кнопка «вниз» ─────────────────────────────────────────

const MD: FeedEntry = {
  id: 'm1',
  at: 1_700_000_004_000,
  kind: 'agent',
  text: '## Готово\n\n- раз\n- два',
  cursor: '7:80',
};

describe('ответ агента в ленте нарисован, а не показан markdown-ом', () => {
  it('заголовок и список — узлами, решётки и дефисы не видны', async () => {
    const { transport } = feedTransport(() => page({ entries: [MD] }));
    mountFeed(host, 'work', transport);
    await flush();

    const box = entries('agent')[0]!;
    expect(box.querySelector('h2')?.textContent).toBe('Готово');
    expect(box.querySelectorAll('li')).toHaveLength(2);
    expect(box.textContent).not.toContain('##');
  });

  it('тег из ответа агента остаётся видимой строкой, а не элементом', async () => {
    const dirty: FeedEntry = { id: 'x', at: 1, kind: 'agent', text: 'верну <img onerror=alert(1)> как есть' };
    const { transport } = feedTransport(() => page({ entries: [dirty] }));
    mountFeed(host, 'work', transport);
    await flush();

    const box = entries('agent')[0]!;
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).toContain('<img onerror=alert(1)>');
  });

  it('реплику человека оставляет как набрали — её markdown-ом не считаем', async () => {
    const asked: FeedEntry = { id: 'h', at: 1, kind: 'human', text: '## это просто решётки' };
    const { transport } = feedTransport(() => page({ entries: [asked] }));
    mountFeed(host, 'work', transport);
    await flush();

    const box = entries('human')[0]!;
    expect(box.querySelector('h2')).toBeNull();
    expect(box.textContent).toContain('## это просто решётки');
  });

  it('поиск и прыжок работают по исходному тексту, а не по нарисованному', async () => {
    const { transport } = feedTransport(() => page({ entries: [MD] }));
    const feed = mountFeed(host, 'work', transport);
    await flush();

    // Ищется то, что написал агент: «## Готово» на экране решёток не показывает,
    // но находкой остаётся — иначе разметка сломала бы поиск по беседе.
    expect(searchFeed(feed.entries(), '## Готово')).toHaveLength(1);
    // Точка прыжка по-прежнему на самой записи, а не потерялась внутри разметки.
    expect(entries('agent')[0]!.dataset.cursor).toBe('7:80');
  });
});

describe('кнопка «вниз»', () => {
  const fab = (): HTMLButtonElement => host.querySelector('.th-feed__fab') as HTMLButtonElement;

  it('у конца беседы её нет — последнюю запись закрывать нечем', async () => {
    const { transport } = feedTransport(() => page({ entries: [HUMAN, AGENT] }));
    mountFeed(host, 'work', transport);
    await flush();

    expect(fab().hidden).toBe(true);
  });

  it('появляется, когда ушли листать историю, и возвращает к последней записи', async () => {
    const { transport } = feedTransport(() => page({ entries: [HUMAN, AGENT] }));
    mountFeed(host, 'work', transport);
    await flush();

    const l = list();
    Object.defineProperty(l, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(l, 'clientHeight', { value: 200, configurable: true });
    l.scrollTop = 300;
    l.dispatchEvent(new Event('scroll'));
    expect(fab().hidden).toBe(false);

    fab().click();

    expect(l.scrollTop).toBe(1000);
    expect(fab().hidden).toBe(true);
  });
});


describe('скрытие действий', () => {
  it('скрывает инструменты, сохраняет реплики и запоминает выбор', async () => {
    const { transport } = feedTransport(() => page({ entries: [HUMAN, AGENT, TOOL, THINK] }));
    let feed = mountFeed(host, 'work', transport);
    await flush();
    const toggle = host.querySelector<HTMLInputElement>('.th-feed__hide-actions');
    expect(toggle).not.toBeNull();
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event('change'));
    expect(entries('tool')[0]?.hidden).toBe(true);
    expect(entries('human')[0]?.hidden).toBe(false);
    expect(entries('agent')[0]?.hidden).toBe(false);
    feed.teardown();
    feed = mountFeed(host, 'work', transport);
    await flush();
    expect(entries('tool')[0]?.hidden).toBe(true);
    feed.teardown();
  });
});
