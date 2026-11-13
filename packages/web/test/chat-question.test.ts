// @vitest-environment happy-dom
// Вопрос, заданный агентом, остаётся в переписке блоком: текст, варианты с пояснениями и
// данный ответ. Записи собраны руками по форме провода (`FeedEntry.questions`).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { mountChat } from '../src/chat';
import { mountFeed } from '../src/feed';
import { setLang, t } from '../src/i18n';
import type { FeedEntry, FeedPage, FeedResult, Transport } from '../src/transport';

function page(entries: FeedEntry[]): FeedPage {
  return { ok: true, agent: 'codex', entries, head: 'h', tail: 'tl', bof: true, eof: true, complete: true, live: false, skipped: 0 };
}

const ASKED: FeedEntry = {
  id: 'q1',
  at: 2,
  kind: 'tool',
  tool: 'request_user_input_async',
  text: 'request_user_input_async Оставить копию `demo` или **удалить**? См. [навык](/root/a/SKILL.md)',
  cursor: '1:20',
  detail: true,
  result: { state: 'done' },
  questions: [
    {
      text: 'Оставить копию `demo` или **удалить**? См. [навык](/root/a/SKILL.md)',
      options: [{ label: 'Оставить' }, { label: 'Удалить рабочую копию', hint: 'Ветка останется' }],
    },
  ],
};
const answered = (answer: string[]): FeedEntry => ({ ...ASKED, questions: [{ ...ASKED.questions![0]!, answer }] });
const SHELL: FeedEntry = { id: 't1', at: 1, kind: 'tool', tool: 'exec', text: 'exec ls', cursor: '1:10' };

let host: HTMLElement;
let answer: () => FeedResult;
const transport = {
  mode: 'lan',
  clientScope: null,
  capabilities: async () => ['feed', 'chat'],
  list: async () => [{ name: 'work', command: 'codex', path: '/root/a', title: '' }],
  dirs: async () => [],
  gradle: async () => null,
  feed: async () => answer(),
  live: async () => ({ ok: false, reason: 'no-agent', detail: '' }),
} as unknown as Transport;

beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => document.body.replaceChildren());

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const blocks = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.th-feed__entry--question')];

describe('блок вопроса в переписке чата', () => {
  it('значок, текст с оформлением, варианты списком с пояснениями; ответа нет — отметки нет', async () => {
    answer = () => page([SHELL, ASKED]);
    const chat = mountChat(host, 'work', transport);
    await flush();
    expect(blocks()).toHaveLength(1);
    const block = blocks()[0]!;
    expect(block.querySelector('.th-q__mark')!.textContent).toBe('?');
    const text = block.querySelector('.th-q__text')!;
    expect(text.querySelector('code')!.textContent).toBe('demo');
    expect(text.querySelector('strong')!.textContent).toBe('удалить');
    // Ссылка markdown на локальный файл — названием, сырой разметки на экране нет.
    expect(text.textContent).toBe('Оставить копию demo или удалить? См. навык');
    const options = [...block.querySelectorAll<HTMLElement>('.th-q__option')];
    expect(options.map((o) => o.querySelector('.th-q__label')!.textContent)).toEqual(['Оставить', 'Удалить рабочую копию']);
    expect(options.map((o) => o.querySelector('.th-q__hint')?.textContent ?? null)).toEqual([null, 'Ветка останется']);
    expect(block.querySelectorAll('.is-chosen')).toHaveLength(0);
    expect(block.querySelector('.th-q__answer')).toBeNull();
    // Имя инструмента и строка действия в блоке не показываются.
    expect(block.textContent).not.toContain('request_user_input_async');
    chat.teardown();
  });

  it('выбранный вариант выделен; свой текст — строкой «ответ: …»', async () => {
    answer = () => page([answered(['Удалить рабочую копию'])]);
    const chat = mountChat(host, 'work', transport);
    await flush();
    const chosen = [...blocks()[0]!.querySelectorAll('.th-q__option.is-chosen')];
    expect(chosen.map((o) => o.querySelector('.th-q__label')!.textContent)).toEqual(['Удалить рабочую копию']);
    expect(blocks()[0]!.querySelector('.th-q__answer')).toBeNull();
    chat.teardown();

    host.replaceChildren();
    answer = () => page([answered(['оставь до пятницы'])]);
    const next = mountChat(host, 'work', transport);
    await flush();
    expect(blocks()[0]!.querySelectorAll('.is-chosen')).toHaveLength(0);
    expect(blocks()[0]!.querySelector('.th-q__answer')!.textContent).toBe(t('feed.question.answer', { text: 'оставь до пятницы' }));
    expect(blocks()[0]!.querySelector('.th-q__answer')!.textContent).toBe('ответ: оставь до пятницы');
    next.teardown();
  });

  it('несколько вопросов одного вызова — все, с заголовками', async () => {
    const two: FeedEntry = {
      ...ASKED,
      questions: [
        { text: 'Что налить?', header: 'Напиток', options: [{ label: 'Чай' }], answer: ['Чай'] },
        { text: 'Сколько?', header: 'Объём' },
      ],
    };
    answer = () => page([two]);
    const chat = mountChat(host, 'work', transport);
    await flush();
    const items = [...blocks()[0]!.querySelectorAll<HTMLElement>('.th-q')];
    expect(items.map((q) => q.querySelector('.th-q__header')!.textContent)).toEqual(['Напиток', 'Объём']);
    expect(items.map((q) => q.querySelector('.th-q__text')!.textContent)).toEqual(['Что налить?', 'Сколько?']);
    chat.teardown();
  });

  it('кнопка «действия» прячет действия, а блок вопроса оставляет', async () => {
    localStorage.setItem('termhub.feedHideActions', '1');
    answer = () => page([SHELL, ASKED]);
    const chat = mountChat(host, 'work', transport);
    await flush();
    const shell = host.querySelector<HTMLElement>('.th-feed__entry--tool')!;
    expect(shell.hidden).toBe(true);
    expect(blocks()[0]!.hidden).toBe(false);
    chat.teardown();
  });
});

describe('вопрос в ленте без чата', () => {
  it('показан текстом целиком, прежней строкой действия', async () => {
    answer = () => page([ASKED]);
    const feed = mountFeed(host, 'work', transport);
    await flush();
    expect(blocks()).toHaveLength(0);
    const row = host.querySelector<HTMLElement>('.th-feed__entry--tool')!;
    expect(row.hidden).toBe(false);
    expect(row.querySelector('.th-feed__toolname')!.textContent).toBe('request_user_input_async');
    expect(row.querySelector('.th-feed__tooltext')!.textContent).toContain('Оставить копию `demo` или **удалить**?');
    feed.teardown();
  });
});

describe('ответ из записи вопроса в переписке', () => {
  const IDLE = { kind: 'working', input: '', pending: true };
  const OPENED = {
    kind: 'question',
    question: {
      stamp: 'st-1',
      title: 'Оставить копию demo или удалить?',
      options: [
        { key: '1', label: 'Оставить', selected: true },
        { key: '2', label: 'Удалить рабочую копию' },
        { key: '3', label: 'Other', free: true },
      ],
    },
  };
  const liveOf = (screen: unknown): unknown => ({ ok: true, agent: 'codex', tested: true, screen, modes: [], models: [] });
  const withLive = (screen: unknown, acts: unknown[], reply: (a: { kind: string }) => unknown): Transport =>
    ({
      ...transport,
      live: async () => liveOf(screen),
      act: async (_s: string, a: { kind: string }) => {
        acts.push(a);
        return reply(a);
      },
    }) as unknown as Transport;
  const option = (i: number): HTMLElement => blocks()[0]!.querySelectorAll<HTMLElement>('.th-q__option')[i]!;

  it('вопрос ждёт в очереди Codex: нажатие варианта открывает вопрос и отвечает его клавишей', async () => {
    answer = () => page([structuredClone(ASKED)]);
    const acts: unknown[] = [];
    const chat = mountChat(host, 'work', withLive(IDLE, acts, (a) => ({ ok: true, screen: a.kind === 'show-question' ? OPENED : IDLE })));
    await flush();
    expect(option(1).classList.contains('is-pickable')).toBe(true);
    option(1).click();
    await flush();
    expect(acts).toEqual([{ kind: 'show-question' }, { kind: 'answer', stamp: 'st-1', option: '2' }]);
    // Ответ отмечен на месте, варианты больше не кнопки: повторное нажатие ничего не шлёт.
    expect(option(1).classList.contains('is-chosen')).toBe(true);
    expect(blocks()[0]!.querySelectorAll('.is-pickable')).toHaveLength(0);
    option(0).click();
    await flush();
    expect(acts).toHaveLength(2);
    chat.teardown();
  });

  it('вопрос уже показан на экране — отвечает сразу; на экране другой вопрос — клавиш нет', async () => {
    answer = () => page([structuredClone(ASKED)]);
    const acts: unknown[] = [];
    const chat = mountChat(host, 'work', withLive(OPENED, acts, () => ({ ok: true, screen: IDLE })));
    await flush();
    option(0).click();
    await flush();
    expect(acts).toEqual([{ kind: 'answer', stamp: 'st-1', option: '1' }]);
    chat.teardown();
    document.body.replaceChildren(host);
    host.replaceChildren();
    const none: unknown[] = [];
    const other = mountChat(host, 'work', withLive({ kind: 'idle', input: '' }, none, () => ({ ok: true, screen: IDLE })));
    await flush();
    option(0).click();
    await flush();
    expect(none).toEqual([]);
    other.teardown();
  });

  it('вопрос с ответом — варианты не кнопки', async () => {
    answer = () => page([answered(['Оставить'])]);
    const chat = mountChat(host, 'work', transport);
    await flush();
    expect(blocks()[0]!.querySelectorAll('.is-pickable')).toHaveLength(0);
    chat.teardown();
  });
});
