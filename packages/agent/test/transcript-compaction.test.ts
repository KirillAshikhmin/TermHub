// Веха сжатия Codex: сохранённые без сжатия сообщения (`retained_context`) — числа в странице,
// тексты по курсору вехи. Форма записи — по замеру ноябрьских сессий (без содержимого):
// `payload.message` пуст, итог зашифрован в `replacement_history[].compaction`, открытым
// текстом лежит только `retained_context`. Строки собраны вручную, тексты нейтральные.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readDetail, readFeed, type FeedPage } from '../src/transcript-feed.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-compaction-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (name: string, lines: unknown[]): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
};

const msg = (order: number, text: string, extra: object = {}): object => ({
  revision: `rev-${order}`,
  order,
  turn_id: 't1',
  message_id: `m${order}`,
  text,
  complete: true,
  ...extra,
});

const compacted = (retained: object, message = ''): object => ({
  timestamp: '2026-11-12T10:00:05.000Z',
  ordinal: 5,
  type: 'compacted',
  payload: {
    message,
    replacement_history: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'служебные инструкции' }] },
      { type: 'compaction', encrypted_content: 'ZW5jcnlwdGVk' },
    ],
    retained_context: retained,
  },
});

const meta = { timestamp: '2026-11-12T10:00:00.000Z', type: 'session_meta', payload: { id: 'th-1' } };
const after = {
  timestamp: '2026-11-12T10:00:09.000Z',
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'продолжаю' }] },
};

const RETAINED = {
  user_messages: [msg(0, 'первая просьба'), msg(4, 'вторая просьба')],
  assistant_messages: [msg(2, 'первый ответ', { phase: 'commentary' }), msg(6, 'итоговый ответ', { phase: 'final_answer' })],
  incomplete: false,
};

async function noteOf(file: string): Promise<{ page: FeedPage; cursor: string }> {
  const page = (await readFeed(file, 'codex')) as FeedPage;
  expect(page.ok).toBe(true);
  const e = page.entries.find((x) => x.note === 'compacted');
  expect(e).toBeDefined();
  return { page, cursor: e!.cursor! };
}

describe('веха сжатия Codex', () => {
  it('страница несёт только числа сохранённого, без текстов', async () => {
    const file = put('a.jsonl', [meta, compacted(RETAINED), after]);
    const { page } = await noteOf(file);
    const e = page.entries.find((x) => x.note === 'compacted')!;
    expect(e.retained).toEqual({ human: 2, agent: 2 });
    expect(e.text).toBe('');
    expect(JSON.stringify(e)).not.toContain('первая просьба');
  });

  it('служебные обёртки человека не считаются; пустое сохранённое — поля нет', async () => {
    const reply = '<send_user_message_question_reply>да</send_user_message_question_reply>';
    const env = '<environment_context>cwd</environment_context>';
    const file = put('b.jsonl', [
      meta,
      compacted({ user_messages: [msg(0, reply), msg(1, env)], assistant_messages: [], incomplete: false }),
    ]);
    const { page } = await noteOf(file);
    expect(page.entries.find((x) => x.note === 'compacted')!.retained).toBeUndefined();
  });

  it('непустое message остаётся текстом вехи, как у Claude', async () => {
    const file = put('c.jsonl', [meta, compacted(RETAINED, 'итог сжатия')]);
    const { page } = await noteOf(file);
    const e = page.entries.find((x) => x.note === 'compacted')!;
    expect(e.text).toBe('итог сжатия');
    expect(e.retained).toEqual({ human: 2, agent: 2 });
  });
});

describe('раскрытие вехи сжатия', () => {
  it('отдаёт сообщения в порядке беседы с ролями; служебное и зашифрованное не отдаётся', async () => {
    const file = put('d.jsonl', [
      meta,
      compacted({
        ...RETAINED,
        user_messages: [...RETAINED.user_messages, msg(8, '<environment_context>x</environment_context>')],
      }),
    ]);
    const { cursor } = await noteOf(file);
    const res = await readDetail(file, 'codex', cursor);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.messages).toEqual([
      { role: 'human', text: 'первая просьба' },
      { role: 'agent', text: 'первый ответ' },
      { role: 'human', text: 'вторая просьба' },
      { role: 'agent', text: 'итоговый ответ' },
    ]);
    const body = JSON.stringify(res);
    expect(body).not.toContain('служебные инструкции');
    expect(body).not.toContain('ZW5jcnlwdGVk');
  });

  it('сообщения режутся общим пределом с пометкой обрезки; свежие важнее', async () => {
    const big = 'ж'.repeat(40 * 1024); // 80 КиБ в байтах
    const file = put('e.jsonl', [
      meta,
      compacted({ user_messages: [msg(0, 'старая'), msg(2, big)], assistant_messages: [msg(1, 'ответ')], incomplete: false }),
    ]);
    const { cursor } = await noteOf(file);
    const res = await readDetail(file, 'codex', cursor);
    if (!res.ok) throw new Error('detail failed');
    expect(res.truncated).toBe(true);
    const total = (res.messages ?? []).reduce((n, m) => n + Buffer.byteLength(m.text), 0);
    expect(total).toBeLessThanOrEqual(64 * 1024);
    expect(res.messages!.at(-1)!.role).toBe('human');
    expect(res.messages!.at(-1)!.text.startsWith('ж')).toBe(true);
  });

  it('запись в мегабайты не ломает чтение: сама лента на неё не падает', async () => {
    const huge = 'з'.repeat(3 * 1024 * 1024);
    const file = put('f.jsonl', [
      meta,
      compacted({ ...RETAINED, user_messages: [msg(0, huge)] }),
      after,
    ]);
    const page = (await readFeed(file, 'codex')) as FeedPage;
    expect(page.ok).toBe(true);
    expect(page.entries.at(-1)!.text).toBe('продолжаю');
  });
});
