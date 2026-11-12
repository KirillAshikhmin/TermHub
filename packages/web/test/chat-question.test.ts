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
