// Шов один: readOpencodeFeed() над подложенной базой во временном каталоге. Живого opencode,
// tmux и сети здесь нет. Формы строк сняты с живой базы владельца 29.10.2026
// (~/.local/share/opencode/opencode.db, opencode 2.2.0): таблица `session_message`, тип строки
// столбцом, тело — JSON. Чужие беседы не копируются: каждая строка собрана вручную.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readOpencodeFeed } from '../src/opencode-feed.js';
import type { FeedFailure, FeedPage } from '../src/transcript-feed.js';

const SES = 'ses_e7c66b880ffeW0WgHzxxkjpRh7';
const OTHER = 'ses_e7c82fb96ffejQwD0OLSEzrryn';
const T0 = 1793209223087;

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-ocfeed-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Строка беседы: тип, `seq` и тело. */
interface Msg {
  type: string;
  seq: number;
  data: unknown;
  session?: string;
}

/** База со схемой `session_message`, как у opencode 2.2. */
const db = (name: string, msgs: Msg[]): string => {
  const file = path.join(dir, `${name}.db`);
  const conn = new DatabaseSync(file);
  conn.exec(
    'CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, ' +
      'seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)',
  );
  const put = conn.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const m of msgs) {
    const data = typeof m.data === 'string' ? m.data : JSON.stringify(m.data);
    put.run(`msg_${m.seq}_${m.session ?? SES}`, m.session ?? SES, m.type, m.seq, T0 + m.seq, T0 + m.seq, data);
  }
  conn.close();
  return file;
};

const user = (seq: number, text: string): Msg => ({
  type: 'user',
  seq,
  data: { time: { created: T0 + seq }, text, files: [], agents: [] },
});
const answer = (seq: number, content: unknown[], extra: object = {}): Msg => ({
  type: 'assistant',
  seq,
  data: {
    time: { created: T0 + seq, completed: T0 + seq + 10 },
    agent: 'build',
    model: { id: 'qwen3.8-27b', providerID: 'lmstudio' },
    content,
    ...extra,
  },
});
const system = (seq: number): Msg => ({
  type: 'system',
  seq,
  data: { time: { created: T0 + seq }, text: "Today's date is now: Thu Oct 29 2026" },
});

const page = (r: FeedPage | FeedFailure): FeedPage => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as FeedPage;
};

describe('readOpencodeFeed: записи', () => {
  it('реплики, мышление, вызов инструмента и вехи — в общей форме ленты', async () => {
    const file = db('kinds', [
      user(4, 'почини создание сессии'),
      answer(6, [
        { type: 'reasoning', text: 'Смотрю sessions.ts' },
        { type: 'tool', id: '1', name: 'read', state: { status: 'completed', input: { path: '/w/sessions.ts', limit: 50 } } },
        { type: 'text', text: 'Нашёл причину.' },
      ]),
      { type: 'compaction', seq: 8, data: { time: { created: T0 + 8 }, status: 'completed', reason: 'auto', summary: '## Objective' } },
      { type: 'compaction', seq: 9, data: { time: { created: T0 + 9 }, status: 'failed', error: { type: 'compaction.failed', message: 'limit' } } },
      { type: 'idle', seq: 10, data: { time: { created: T0 + 10 }, outcome: 'failed', error: { type: 'compaction.failed', message: 'limit' } } },
      { type: 'idle', seq: 11, data: { time: { created: T0 + 11 }, outcome: 'succeeded' } },
      { type: 'synthetic', seq: 12, data: { time: { created: T0 + 12 }, text: 'The previous response was interrupted.' } },
      system(13),
    ]);
    const r = page(await readOpencodeFeed(file, SES));
    expect(r.agent).toBe('opencode');
    expect(r.entries.map((e) => [e.kind, e.text, e.note ?? e.tool ?? ''])).toEqual([
      ['human', 'почини создание сессии', ''],
      ['thinking', 'Смотрю sessions.ts', ''],
      ['tool', 'read /w/sessions.ts', 'read'],
      ['agent', 'Нашёл причину.', ''],
      ['note', '## Objective', 'compacted'],
      ['note', 'limit', 'error'],
    ]);
    // Части одного ответа — как блоки строки Claude: идентификатор строки и `#<номер>`.
    expect(r.entries.slice(1, 4).map((e) => e.id)).toEqual(['msg_6_' + SES, `msg_6_${SES}#1`, `msg_6_${SES}#2`]);
    expect(r.entries[0].at).toBe(T0 + 4);
    expect(r.bof).toBe(true);
    expect(r.eof).toBe(true);
    expect(r.skipped).toBe(0);
  });

  it('ошибка ответа модели — веха после его частей', async () => {
    const file = db('error', [
      answer(4, [{ type: 'text', text: 'Начинаю' }], { error: { type: 'provider', message: 'model unloaded' } }),
    ]);
    const r = page(await readOpencodeFeed(file, SES));
    expect(r.entries.map((e) => [e.kind, e.text, e.id])).toEqual([
      ['agent', 'Начинаю', `msg_4_${SES}`],
      ['note', 'model unloaded', `msg_4_${SES}#1`],
    ]);
  });

  it('битая строка считается пропущенной, а соседей не роняет', async () => {
    const file = db('broken', [user(4, 'раз'), { type: 'user', seq: 5, data: '{oops' }, user(6, 'два')]);
    const r = page(await readOpencodeFeed(file, SES));
    expect(r.entries.map((e) => e.text)).toEqual(['раз', 'два']);
    expect(r.skipped).toBe(1);
  });

  it('чужая беседа той же базы в ленту не попадает', async () => {
    const file = db('mixed', [user(4, 'моя'), { ...user(5, 'чужая'), session: OTHER }, user(6, 'тоже моя')]);
    const r = page(await readOpencodeFeed(file, SES));
    expect(r.entries.map((e) => e.text)).toEqual(['моя', 'тоже моя']);
  });
});

describe('readOpencodeFeed: страницы и курсоры', () => {
  // seq идёт с пропусками, как в живой базе (4..2542 на 275 строк).
  const seqs = Array.from({ length: 30 }, (_, i) => 4 + i * 3);
  let manyFile: string | undefined;
  const many = (): string => (manyFile ??= db('many', seqs.map((seq, i) => user(seq, `реплика ${i}`))));

  it('хвост, затем before по head — без пропусков и повторов до начала беседы', async () => {
    const file = many();
    const seen: string[] = [];
    let r = page(await readOpencodeFeed(file, SES, { limit: 7 }));
    expect(r.eof).toBe(true);
    seen.unshift(...r.entries.map((e) => e.text));
    while (!r.bof) {
      r = page(await readOpencodeFeed(file, SES, { limit: 7, before: r.head }));
      seen.unshift(...r.entries.map((e) => e.text));
    }
    expect(seen).toEqual(seqs.map((_, i) => `реплика ${i}`));
  });

  it('курсор записи — её строка; around возвращает окрестность с ней самой', async () => {
    const file = many();
    const tail = page(await readOpencodeFeed(file, SES, { limit: 30 }));
    const target = tail.entries[12];
    expect(target.cursor).toBe(`${SES}:${seqs[12]}`);
    const r = page(await readOpencodeFeed(file, SES, { limit: 6, around: target.cursor }));
    expect(r.entries.map((e) => e.text)).toEqual([9, 10, 11, 12, 13, 14].map((i) => `реплика ${i}`));
    expect(r.bof).toBe(false);
    expect(r.eof).toBe(false);
    const fwd = page(await readOpencodeFeed(file, SES, { limit: 6, after: r.tail }));
    expect(fwd.entries[0].text).toBe('реплика 15');
  });

  it('after по tail конца беседы — пустая страница с eof, курсор на месте', async () => {
    const file = many();
    const r = page(await readOpencodeFeed(file, SES));
    const next = page(await readOpencodeFeed(file, SES, { after: r.tail }));
    expect(next.entries).toEqual([]);
    expect(next.eof).toBe(true);
    expect(next.tail).toBe(r.tail);
  });

  it('полоса служебных строк не останавливает курсор', async () => {
    const msgs: Msg[] = [user(4, 'до')];
    for (let seq = 5; seq < 400; seq += 1) msgs.push(system(seq));
    msgs.push(user(400, 'после'));
    const file = db('service', msgs);
    const r = page(await readOpencodeFeed(file, SES, { limit: 1, after: `${SES}:5` }));
    expect(r.entries.map((e) => e.text)).toEqual(['после']);
    expect(r.eof).toBe(true);
  });

  it('курсор чужой беседы, мусор и seq за концом — cursor-stale', async () => {
    const file = many();
    for (const before of [`${OTHER}:10`, 'garbage', `${SES}:99999`]) {
      const r = await readOpencodeFeed(file, SES, { before });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason, before).toBe('cursor-stale');
    }
  });
});

describe('readOpencodeFeed: ответ, который ещё пишется', () => {
  const streaming = (seq: number): Msg => ({
    type: 'assistant',
    seq,
    data: { time: { created: T0 + seq }, agent: 'build', content: [{ type: 'text', text: 'Пишу…' }] },
  });

  it('последний недописанный ответ в ленту не едет, курсор стоит перед ним', async () => {
    const file = db('stream', [user(4, 'вопрос'), streaming(7)]);
    const r = page(await readOpencodeFeed(file, SES));
    expect(r.entries.map((e) => e.text)).toEqual(['вопрос']);
    expect(r.tail).toBe(`${SES}:5`);
    // Дописался — приезжает следующим приращением целиком.
    const conn = new DatabaseSync(file);
    conn.prepare('UPDATE session_message SET data = ? WHERE seq = 7').run(
      JSON.stringify({ time: { created: T0 + 7, completed: T0 + 9 }, content: [{ type: 'text', text: 'Готово' }] }),
    );
    conn.close();
    const next = page(await readOpencodeFeed(file, SES, { after: r.tail }));
    expect(next.entries.map((e) => e.text)).toEqual(['Готово']);
  });

  it('недописанный ответ посреди беседы — уже история и читается', async () => {
    const file = db('stuck', [streaming(4), user(5, 'ау?')]);
    const r = page(await readOpencodeFeed(file, SES));
    expect(r.entries.map((e) => e.text)).toEqual(['Пишу…', 'ау?']);
  });
});

describe('readOpencodeFeed: отказы', () => {
  it('базы нет — no-transcript', async () => {
    const r = await readOpencodeFeed(path.join(dir, 'missing.db'), SES);
    expect(r).toMatchObject({ ok: false, reason: 'no-transcript' });
  });

  it('незнакомая схема — unknown-format', async () => {
    const file = path.join(dir, 'alien.db');
    const conn = new DatabaseSync(file);
    conn.exec('CREATE TABLE message (id text)');
    conn.close();
    const r = await readOpencodeFeed(file, SES);
    expect(r).toMatchObject({ ok: false, reason: 'unknown-format' });
  });

  it('пустая беседа — пустая страница с обоими краями', async () => {
    const file = db('empty', [{ ...user(4, 'чужая'), session: OTHER }]);
    const r = page(await readOpencodeFeed(file, SES));
    expect(r.entries).toEqual([]);
    expect(r.bof).toBe(true);
    expect(r.eof).toBe(true);
  });
});
