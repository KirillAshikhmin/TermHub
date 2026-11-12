// @vitest-environment happy-dom
// Экран чата: оболочка вокруг ленты — переписка с оформлением, раскрытие действий,
// пути ссылками, пустые состояния, обрыв связи, слоты для полос следующих тасков.
// Транспорт подделан (единственный шов), страницы написаны руками по interfaces.md.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { mountChat } from '../src/chat';
import { setLang, t } from '../src/i18n';
import type { DetailResult, FeedEntry, FeedOptions, FeedPage, FeedResult, Transport } from '../src/transport';
import { sessionViewPref } from '../src/view-pref';

function page(over: Partial<FeedPage> = {}): FeedPage {
  return { ok: true, agent: 'claude', entries: [], head: 'h', tail: 'tl', bof: true, eof: true, complete: true, live: false, skipped: 0, ...over };
}

interface Fixture {
  transport: Transport;
  detailCalls: string[];
  feedCalls: FeedOptions[];
}

function fixture(
  answer: () => FeedResult | Promise<FeedResult>,
  detail: (cursor: string) => DetailResult = () => ({ ok: true, output: 'PASS' }),
  clientScope: unknown = null,
): Fixture {
  const detailCalls: string[] = [];
  const feedCalls: FeedOptions[] = [];
  const transport = {
    mode: 'lan',
    clientScope,
    capabilities: async () => ['feed', 'chat'],
    gradle: async () => null,
    list: async () => [{ name: 'work', command: 'claude', path: '/root/a', title: '' }],
    dirs: async () => [{ root: '/root/a', dirs: [] }],
    feed: async (_s: string, opts: FeedOptions = {}) => {
      feedCalls.push(opts);
      return answer();
    },
    feedDetail: async (_s: string, cursor: string) => {
      detailCalls.push(cursor);
      return detail(cursor);
    },
  } as unknown as Transport;
  return { transport, detailCalls, feedCalls };
}

let host: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  location.hash = '';
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => vi.useRealTimers());

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const HUMAN: FeedEntry = { id: 'h', at: 1_700_000_000_000, kind: 'human', text: 'запусти тесты', cursor: '1:0' };
const AGENT: FeedEntry = {
  id: 'a',
  at: 1_700_000_001_000,
  kind: 'agent',
  text: '# Итог\n\nПравка в /root/a/src/x.ts, см. https://example.com.\n\n```ts\nconst a = 1;\n```',
  cursor: '1:10',
};
const TOOL: FeedEntry = { id: 't', at: 1_700_000_002_000, kind: 'tool', tool: 'Bash', text: 'Bash npm test /root/a/run.sh', cursor: '1:20', detail: true };
const PLAIN_TOOL: FeedEntry = { id: 't2', at: 1_700_000_003_000, kind: 'tool', tool: 'Read', text: 'Read x.ts', cursor: '1:30' };

describe('шапка сессии в виде «Чат»', () => {
  it('та же, что у терминала: шестерёнка настроек и статус подключения стоят в шапке', async () => {
    const { transport } = fixture(() => page({ entries: [HUMAN] }));
    const chat = mountChat(host, 'work', transport);
    const bar = host.querySelector('.th-termbar')!;
    const gear = bar.querySelector<HTMLButtonElement>('.th-termbar__view')!;
    const conn = bar.querySelector<HTMLElement>('.th-conn-dot')!;
    expect(gear.getAttribute('aria-label')).toBe(t('termview.title'));
    await flush();
    expect(conn.classList.contains('is-connected')).toBe(true);
    expect(conn.getAttribute('aria-label')).toBe(t('term.statusConnected'));
    chat.teardown();
  });

  it('шестерёнка открывает настройки, и смена размера шрифта в них меняет чат сразу', async () => {
    const { transport } = fixture(() => page({ entries: [HUMAN] }));
    const chat = mountChat(host, 'work', transport);
    await flush();
    const before = chat.el.style.getPropertyValue('--chat-fs');
    host.querySelector<HTMLButtonElement>('.th-termbar__view')!.click();
    const win = document.querySelector('.th-termview')!;
    expect(win).not.toBeNull();
    win.querySelectorAll<HTMLButtonElement>('.th-termview__stepper button')[1]!.click();
    expect(chat.el.style.getPropertyValue('--chat-fs')).not.toBe(before);
    chat.teardown();
  });

  it('связь с агентом пропала — статус говорит «переподключение»; вернулась — снова «установлено»', async () => {
    let fail = false;
    const { transport } = fixture(() => {
      if (fail) throw new Error('offline');
      return page({ entries: [HUMAN], live: true });
    });
    const chat = mountChat(host, 'work', transport);
    await flush();
    const conn = host.querySelector<HTMLElement>('.th-conn-dot')!;
    fail = true;
    chat.feed.refresh();
    await flush();
    expect(conn.classList.contains('is-reconnecting')).toBe(true);
    expect(conn.title).toBe(t('term.statusReconnecting'));
    fail = false;
    chat.feed.refresh();
    await flush();
    expect(conn.classList.contains('is-connected')).toBe(true);
    chat.teardown();
  });
});

describe('оболочка чата', () => {
  it('переписка: человек — своя запись без подписи «кто», агент — markdown с кодом, копированием и ссылками', async () => {
    const { transport } = fixture(() => page({ entries: [HUMAN, AGENT] }));
    const chat = mountChat(host, 'work', transport);
    await flush();

    const human = host.querySelector('.th-feed__entry--human')!;
    expect(human.textContent).toBe('запусти тесты');
    expect(human.querySelector('.th-feed__who')).toBeNull();

    const agent = host.querySelector('.th-feed__entry--agent')!;
    expect(agent.querySelector('h1')!.textContent).toBe('Итог');
    expect(agent.querySelector('pre button.th-md__copy')).not.toBeNull();
    expect(agent.querySelector('a.th-md__link')!.getAttribute('href')).toBe('https://example.com');
    // путь внутри корня /root/a — ссылка на проводник сессии (корни приезжают позже записей)
    const path = agent.querySelector<HTMLAnchorElement>('a.th-path')!;
    expect(path.textContent).toBe('/root/a/src/x.ts');
    expect(path.getAttribute('href')).toBe('#/sfiles/work/src%2Fx.ts');
    chat.teardown();
  });

  it('гость без права files: пути — обычный текст', async () => {
    const { transport } = fixture(() => page({ entries: [AGENT] }), undefined, { write: false, files: false });
    const chat = mountChat(host, 'work', transport);
    await flush();
    expect(host.querySelector('a.th-path')).toBeNull();
    expect(host.querySelector('.th-feed__entry--agent')!.textContent).toContain('/root/a/src/x.ts');
    chat.teardown();
  });

  it('действие раскрывается только когда у записи есть подробности; запрос — по курсору записи', async () => {
    const { transport, detailCalls } = fixture(() => page({ entries: [TOOL, PLAIN_TOOL] }));
    const chat = mountChat(host, 'work', transport);
    await flush();
    const rows = host.querySelectorAll<HTMLElement>('.th-feed__entry--tool');
    expect(rows[1]!.querySelector('.th-tool__head')).toBeNull(); // detail не заявлен — обычная строка
    rows[0]!.querySelector<HTMLElement>('.th-tool__head')!.click();
    await flush();
    expect(detailCalls).toEqual(['1:20']);
    expect(rows[0]!.querySelector('.th-tool__output')!.textContent).toBe('PASS');
    // путь в строке действия — ссылка, а клик по нему не раскрывает строку
    const link = rows[0]!.querySelector<HTMLAnchorElement>('.th-feed__tooltext a.th-path')!;
    expect(link.textContent).toBe('/root/a/run.sh');
    chat.teardown();
  });

  it('строка действия: метка исхода и подсветка команды оболочки; без исхода метки нет, путь остаётся ссылкой', async () => {
    const failed: FeedEntry = { ...TOOL, result: { state: 'failed', exit: 1 } };
    const { transport } = fixture(() => page({ entries: [failed, { ...PLAIN_TOOL, tool: 'Read' }] }));
    const chat = mountChat(host, 'work', transport);
    await flush();
    const rows = host.querySelectorAll<HTMLElement>('.th-feed__entry--tool');
    const mark = rows[0]!.querySelector<HTMLElement>('.th-tool__mark')!;
    expect(mark.classList.contains('is-failed')).toBe(true);
    expect(mark.textContent).toBe('код 1');
    expect(rows[1]!.querySelector('.th-tool__mark')).toBeNull();
    const what = rows[0]!.querySelector('.th-feed__tooltext')!;
    expect(what.querySelector('.th-sh-cmd, .hljs-built_in')!.textContent).toBe('npm');
    expect(what.textContent).toBe('npm test /root/a/run.sh');
    expect(what.querySelector('a.th-path')!.textContent).toBe('/root/a/run.sh');
    expect(rows[1]!.querySelector('.th-feed__tooltext .th-sh-cmd')).toBeNull(); // Read — не оболочка
    chat.teardown();
  });

  it('беседы ещё нет: приглашение написать запрос, а не ошибка', async () => {
    const { transport } = fixture(() => ({ ok: false, reason: 'no-transcript', detail: '' }));
    const chat = mountChat(host, 'work', transport);
    await flush();
    expect(host.querySelector('.th-chat__empty')!.textContent).toContain(t('chat.empty'));
    expect(host.querySelector('.th-loaderror')).toBeNull();
    chat.teardown();
  });

  it('агент вышел: «агент не запущен» и переход в терминал, который запоминает выбор', async () => {
    const { transport } = fixture(() => ({ ok: false, reason: 'no-agent', detail: '' }));
    const chat = mountChat(host, 'work', transport);
    await flush();
    expect(host.querySelector('.th-chat__empty')!.textContent).toContain(t('chat.noAgent'));
    host.querySelector<HTMLButtonElement>('.th-chat__to-term')!.click();
    expect(location.hash).toBe('#/term/work');
    expect(sessionViewPref('work')).toBe('term');
    chat.teardown();
  });

  it('обрыв связи оставляет переписку и говорит «нет связи»; вернулась связь — плашка уходит', async () => {
    vi.useFakeTimers();
    let broken = false;
    const { transport } = fixture(async () => {
      if (broken) throw new Error('relay disconnected');
      return page({ entries: [HUMAN, AGENT], live: true });
    });
    const chat = mountChat(host, 'work', transport);
    await vi.advanceTimersByTimeAsync(10);
    expect(host.querySelectorAll('.th-feed__entry').length).toBe(2);
    expect(host.querySelector<HTMLElement>('.th-chat__offline')!.hidden).toBe(true);

    broken = true;
    await vi.advanceTimersByTimeAsync(3100); // опрос приращения
    expect(host.querySelector<HTMLElement>('.th-chat__offline')!.hidden).toBe(false);
    expect(host.querySelector('.th-chat__offline')!.textContent).toBe(t('chat.offline'));
    expect(host.querySelectorAll('.th-feed__entry').length).toBe(2); // переписка на месте

    broken = false;
    await vi.advanceTimersByTimeAsync(3100);
    expect(host.querySelector<HTMLElement>('.th-chat__offline')!.hidden).toBe(true);
    chat.teardown();
  });

  it('обрыв при НЕ работающем агенте: опрос идёт, пока связи нет, и сам снимает плашку; при целой связи опроса нет', async () => {
    vi.useFakeTimers();
    let broken = false;
    const { transport, feedCalls } = fixture(async () => {
      if (broken) throw new Error('x');
      return page({ entries: [HUMAN], live: false, bof: false });
    });
    const chat = mountChat(host, 'work', transport);
    await vi.advanceTimersByTimeAsync(10);
    const base = feedCalls.length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(feedCalls.length).toBe(base); // агент не работает, связь цела — опроса нет

    broken = true;
    void chat.loadOlder(); // листание назад упёрлось в обрыв
    await vi.advanceTimersByTimeAsync(10);
    expect(host.querySelector<HTMLElement>('.th-chat__offline')!.hidden).toBe(false);

    broken = false;
    await vi.advanceTimersByTimeAsync(3100);
    expect(host.querySelector<HTMLElement>('.th-chat__offline')!.hidden).toBe(true);
    chat.teardown();
  });

  it('места оболочки есть и названы: статус, вопрос, терминал, поле ввода; в слоте поля ввода стоит поле', async () => {
    const { transport } = fixture(() => page({ entries: [HUMAN] }));
    const chat = mountChat(host, 'work', transport);
    await flush();
    for (const name of ['status', 'question', 'terminal', 'composer'] as const) {
      const slot = host.querySelector<HTMLElement>(`[data-slot="${name}"]`)!;
      expect(slot).not.toBeNull();
      expect(chat.slots[name]).toBe(slot);
      if (name === 'composer') expect(slot.querySelector('.th-composer')).not.toBeNull();
    }
    // порядок сверху вниз: состояние, переписка, вопрос, терминал, поле ввода
    const order = [...host.querySelector('.th-chat')!.children].map((c) => (c as HTMLElement).dataset.slot ?? c.className);
    expect(order.indexOf('status')).toBeLessThan(order.findIndex((x) => String(x).includes('th-chat__thread')));
    expect(order.indexOf('composer')).toBe(order.length - 1);
    chat.teardown();
  });

  it('переключатель вида в полосе разделов — на позиции «Чат»', async () => {
    const { transport } = fixture(() => page({ entries: [HUMAN] }));
    const chat = mountChat(host, 'work', transport);
    await flush();
    const pressed = host.querySelector('.th-viewsw__opt[aria-pressed="true"]');
    expect(pressed?.getAttribute('data-view')).toBe('chat');
    chat.teardown();
  });

  it('поиск, прыжок и тумблер мышления работают как у ленты: ручка совпадает', async () => {
    const { transport } = fixture(() => page({ entries: [HUMAN, AGENT] }));
    const chat = mountChat(host, 'work', transport);
    await flush();
    expect(chat.entries().map((e) => e.id)).toEqual(['h', 'a']);
    expect(chat.searchSlot.querySelector('input[type="search"]')).not.toBeNull();
    // Тумблер мышления в чате — кнопка шапки переписки.
    expect(host.querySelector('.th-feed__head [data-toggle="thinking"]')).not.toBeNull();
    chat.teardown();
    expect(host.childElementCount).toBe(0);
  });
});
