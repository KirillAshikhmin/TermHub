// Вопрос, заданный агентом, в ленте: запись `tool` с полем `questions` — текст целиком,
// варианты и данный ответ. Формы сняты с транскриптов 12.11.2026, строки собраны руками:
//   Claude `AskUserQuestion`: input.questions[{question, header, multiSelect, options[{label,
//     description}]}]; ответ — `toolUseResult.answers {<текст вопроса>: <строка>}` записи
//     результата (несколько отметок — подписи через «, »).
//   Codex `request_user_input`: arguments.questions[{id, header, question, options[{label,
//     description}]}]; ответ — в выводе вызова `{answers: {<id>: {answers: [строка]}}}`.
//   Codex `request_user_input_async`: arguments.questions[{title, options?: [строка]}]; вывод
//     вызова — только `{accepted: true}`; ответ приходит позже записью человека
//     `<send_user_message_question_reply>[{answer, question, questionItemId}]…`, где
//     `questionItemId` — строка JSON `[<что-то>, <call_id>, <номер вопроса>]`.
// Там же — слэш-команда Claude: запись человека из `<command-name>/имя</command-name>`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RESPONSE_LIMIT, readFeed, weigh, type FeedEntry, type FeedPage } from '../src/transcript-feed.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-question-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (name: string, lines: unknown[]): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};
const at = (n: number): string => `2026-11-12T10:00:${String(n).padStart(2, '0')}.000Z`;

const page = async (file: string, agent: 'claude' | 'codex'): Promise<FeedPage> => {
  const res = await readFeed(file, agent);
  if (!res.ok) throw new Error(res.detail);
  return res;
};

// --- Claude ---------------------------------------------------------------------------

const ASK = {
  questions: [
    {
      question: 'Какой формат отчёта нужен?',
      header: 'Формат',
      multiSelect: false,
      options: [
        { label: 'Таблица', description: 'Строки и столбцы' },
        { label: 'Список', description: 'Пункты подряд' },
      ],
    },
    {
      question: 'Что включить в отчёт?',
      header: 'Состав',
      multiSelect: true,
      options: [
        { label: 'Итоги', description: 'Сумма по разделам' },
        { label: 'Графики', description: 'Картинки' },
        { label: 'Сноски', description: 'Мелкий текст' },
      ],
    },
  ],
};
const cAsk = (uuid: string, id: string, n: number, input: unknown = ASK): unknown => ({
  type: 'assistant',
  uuid,
  timestamp: at(n),
  message: { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] },
});
const cAnswer = (uuid: string, id: string, n: number, answers: Record<string, string>): unknown => ({
  type: 'user',
  uuid,
  timestamp: at(n),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'User has answered your questions' }] },
  toolUseResult: { questions: ASK.questions, answers },
});
const cHuman = (uuid: string, text: string, n: number): unknown => ({
  type: 'user',
  uuid,
  timestamp: at(n),
  message: { role: 'user', content: text },
});

// --- Codex ----------------------------------------------------------------------------

const xCall = (id: string, callId: string, name: string, args: unknown, n: number): unknown => ({
  timestamp: at(n),
  type: 'response_item',
  payload: { id, type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId },
});
const xOut = (callId: string, output: unknown, n: number): unknown => ({
  timestamp: at(n),
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
});
const xReply = (id: string, callId: string, index: number, question: string, answer: string, n: number): unknown => ({
  timestamp: at(n),
  type: 'response_item',
  payload: {
    id,
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text:
          '<send_user_message_question_reply>\n' +
          JSON.stringify([{ answer, question, questionItemId: JSON.stringify(['item-1', callId, index]) }]) +
          '\n</send_user_message_question_reply>',
      },
    ],
  },
});

const question = (entries: FeedEntry[]): FeedEntry => {
  const found = entries.filter((e) => e.questions);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe('вопрос Claude в ленте', () => {
  it('все вопросы вызова: текст, заголовок, варианты с пояснениями, несколько отметок', async () => {
    const file = put('claude-ask.jsonl', [cAsk('a1', 't1', 1)]);
    const entry = question((await page(file, 'claude')).entries);
    expect(entry.kind).toBe('tool');
    expect(entry.tool).toBe('AskUserQuestion');
    expect(entry.questions).toEqual([
      {
        text: 'Какой формат отчёта нужен?',
        header: 'Формат',
        options: [
          { label: 'Таблица', hint: 'Строки и столбцы' },
          { label: 'Список', hint: 'Пункты подряд' },
        ],
      },
      {
        text: 'Что включить в отчёт?',
        header: 'Состав',
        multi: true,
        options: [
          { label: 'Итоги', hint: 'Сумма по разделам' },
          { label: 'Графики', hint: 'Картинки' },
          { label: 'Сноски', hint: 'Мелкий текст' },
        ],
      },
    ]);
  });

  it('текст записи несёт вопросы словами — клиент, не знающий поля, вопроса не теряет', async () => {
    const file = put('claude-ask-text.jsonl', [cAsk('a1', 't1', 1)]);
    const entry = question((await page(file, 'claude')).entries);
    expect(entry.text).toBe('AskUserQuestion Какой формат отчёта нужен?\nЧто включить в отчёт?');
  });

  it('ответ из результата вызова: вариант, несколько отметок и свой текст', async () => {
    const file = put('claude-answered.jsonl', [
      cAsk('a1', 't1', 1),
      cAnswer('r1', 't1', 2, { 'Какой формат отчёта нужен?': 'ни то ни другое, пришли файлом', 'Что включить в отчёт?': 'Итоги, Сноски' }),
    ]);
    const entry = question((await page(file, 'claude')).entries);
    expect(entry.questions!.map((q) => q.answer)).toEqual([['ни то ни другое, пришли файлом'], ['Итоги', 'Сноски']]);
    expect(entry.result).toEqual({ state: 'done' });
  });

  it('ответа ещё нет — поля ответа нет', async () => {
    const file = put('claude-pending.jsonl', [cAsk('a1', 't1', 1)]);
    const entry = question((await page(file, 'claude')).entries);
    expect(entry.questions!.every((q) => q.answer === undefined)).toBe(true);
  });

  it('неразобранный ввод остаётся обычным действием', async () => {
    const file = put('claude-raw.jsonl', [cAsk('a1', 't1', 1, { __unparsedToolInput: { len: 3, raw: '{"q' } })]);
    const entries = (await page(file, 'claude')).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('tool');
    expect(entries[0]!.questions).toBeUndefined();
  });
});

describe('вопрос Codex в ленте', () => {
  const LONG = 'Оставить рабочую копию `demo-copy` или удалить? '.repeat(20).trim();

  it('асинхронный вопрос: текст из title целиком, варианты строками без пояснений', async () => {
    const file = put('codex-async.jsonl', [
      xCall('fc1', 'call_1', 'request_user_input_async', { questions: [{ title: LONG, options: ['Оставить', 'Удалить рабочую копию'] }] }, 1),
      xOut('call_1', { accepted: true }, 2),
    ]);
    const entry = question((await page(file, 'codex')).entries);
    expect(LONG.length).toBeGreaterThan(400);
    expect(entry.tool).toBe('request_user_input_async');
    expect(entry.questions).toEqual([{ text: LONG, options: [{ label: 'Оставить' }, { label: 'Удалить рабочую копию' }] }]);
    expect(entry.text).toBe(`request_user_input_async ${LONG}`);
    expect(entry.truncated).toBeUndefined();
  });

  it('асинхронный вопрос без вариантов и ответ на него записью человека', async () => {
    const file = put('codex-async-reply.jsonl', [
      xCall('fc1', 'call_1', 'request_user_input_async', { questions: [{ title: 'Как назвать ветку?' }] }, 1),
      xOut('call_1', { accepted: true }, 2),
      xCall('fc2', 'call_2', 'request_user_input_async', { questions: [{ title: 'Удалить копию?', options: ['Оставить', 'Удалить'] }] }, 3),
      xOut('call_2', { accepted: true }, 4),
      xReply('m1', 'call_2', 0, 'Удалить копию?', 'Удалить', 5),
      xReply('m2', 'call_1', 0, 'Как назвать ветку?', 'feature/report', 6),
    ]);
    const entries = (await page(file, 'codex')).entries;
    const asked = entries.filter((e) => e.questions);
    expect(asked.map((e) => e.questions![0])).toEqual([
      { text: 'Как назвать ветку?', answer: ['feature/report'] },
      { text: 'Удалить копию?', options: [{ label: 'Оставить' }, { label: 'Удалить' }], answer: ['Удалить'] },
    ]);
    // Служебная обёртка ответа репликой человека не становится: ответ уже стоит у вопроса.
    expect(entries.filter((e) => e.kind === 'human')).toEqual([]);
  });

  it('синхронный вопрос: заголовок, пояснения вариантов и ответ из вывода вызова по id вопроса', async () => {
    const file = put('codex-sync.jsonl', [
      xCall(
        'fc1',
        'call_1',
        'request_user_input',
        {
          questions: [
            { id: 'drink', header: 'Напиток', question: 'Что налить?', options: [{ label: 'Чай', description: 'Горячий' }, { label: 'Вода', description: 'Холодная' }] },
            { id: 'size', header: 'Объём', question: 'Сколько?' },
          ],
        },
        1,
      ),
      xOut('call_1', { answers: { size: { answers: ['пол-литра'] }, drink: { answers: ['Чай'] } } }, 2),
    ]);
    const entry = question((await page(file, 'codex')).entries);
    expect(entry.questions).toEqual([
      { text: 'Что налить?', header: 'Напиток', options: [{ label: 'Чай', hint: 'Горячий' }, { label: 'Вода', hint: 'Холодная' }], answer: ['Чай'] },
      { text: 'Сколько?', header: 'Объём', answer: ['пол-литра'] },
    ]);
  });

  it('вес страницы считает вопросы: страница остаётся в пределе ответа', async () => {
    const big = 'ё'.repeat(30_000);
    const lines: unknown[] = [];
    for (let i = 0; i < 40; i += 1)
      lines.push(xCall(`fc${i}`, `call_${i}`, 'request_user_input_async', { questions: [{ title: `${i} ${big}`, options: ['да', 'нет'] }] }, i % 60));
    const file = put('codex-heavy.jsonl', lines);
    const p = await page(file, 'codex');
    expect(p.entries.length).toBeGreaterThan(0);
    expect(p.entries.length).toBeLessThan(40);
    expect(Buffer.byteLength(JSON.stringify(p.entries))).toBeLessThanOrEqual(RESPONSE_LIMIT + 64 * 1024);
    const one = p.entries[0]!;
    expect(weigh(one)).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(one)) - 200);
  });
});

describe('слэш-команда Claude в ленте', () => {
  const slash = (name: string, args: string): string =>
    `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>`;

  it('запись команды — реплика человека «/имя аргументы», вывод команды в ленту не идёт', async () => {
    const file = put('claude-slash.jsonl', [
      cHuman('u1', slash('/model', ''), 1),
      cHuman('u2', '<local-command-stdout>Set model to demo</local-command-stdout>', 2),
      cHuman('u3', slash('/rename', 'отчёт за ноябрь'), 3),
    ]);
    const entries = (await page(file, 'claude')).entries;
    expect(entries.map((e) => [e.kind, e.text])).toEqual([
      ['human', '/model'],
      ['human', '/rename отчёт за ноябрь'],
    ]);
  });
});
