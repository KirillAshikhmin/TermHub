// Шов один: readFeed() над подложенными файлами во временном каталоге. Живого агента,
// tmux и сети здесь нет. Формы строк сняты с живых данных владельца 14.09.2026: Claude —
// ~/.claude/projects/<slug>/<uuid>.jsonl, Codex — ~/.codex/sessions/**/rollout-*.jsonl.
// Чужие беседы не копируются: каждая строка собрана вручную по измеренной форме.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFeed, parseLine, type FeedPage } from '../src/transcript-feed.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-feed-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Пишет файл из строк и отдаёт путь: JSON-объекты сериализуются, строки кладутся как есть. */
const put = (name: string, lines: unknown[]): string => {
  const file = path.join(dir, name);
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(file, body + '\n');
  return file;
};

const page = (r: unknown): FeedPage => {
  expect((r as FeedPage).ok).toBe(true);
  return r as FeedPage;
};

// --- формы Claude ---
const cHuman = (uuid: string, text: string, at: string): unknown => ({
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: text },
  uuid,
  timestamp: at,
  userType: 'external',
  cwd: '/w',
  sessionId: 's',
  version: '2.1.263',
});
const cAssistant = (uuid: string, blocks: unknown[], at: string, extra: object = {}): unknown => ({
  parentUuid: null,
  isSidechain: false,
  type: 'assistant',
  uuid,
  timestamp: at,
  requestId: 'req_1',
  message: { id: 'msg_1', role: 'assistant', model: 'claude', content: blocks },
  ...extra,
});
const cToolResult = (uuid: string, at: string): unknown => ({
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', tool_use_id: 't1' }] },
  toolUseResult: { stdout: 'ok' },
  uuid,
  timestamp: at,
});

// --- формы Codex ---
const xMeta = (at: string): unknown => ({
  timestamp: at,
  ordinal: 0,
  type: 'session_meta',
  payload: { session_id: 'sid', id: 'tid', cwd: '/w', source: 'cli' },
});
const xMessage = (id: string, role: string, text: string, at: string, ordinal: number): unknown => ({
  timestamp: at,
  ordinal,
  type: 'response_item',
  payload: {
    type: 'message',
    id,
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  },
});

describe('parseLine: Claude', () => {
  it('дословно отдаёт реплику человека', () => {
    const e = parseLine(JSON.stringify(cHuman('u1', 'привет', '2026-09-14T10:00:00.000Z')), 'claude');
    expect(e).toEqual({ id: 'u1', at: Date.parse('2026-09-14T10:00:00.000Z'), kind: 'human', text: 'привет' });
  });

  it('делит ответ агента на мышление, текст и вызов инструмента', () => {
    const line = JSON.stringify(
      cAssistant(
        'a1',
        [
          { type: 'thinking', thinking: 'надо посмотреть файл', signature: 'sig' },
          { type: 'text', text: 'Смотрю файл.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/src/a.ts', limit: 20 } },
        ],
        '2026-09-14T10:00:01.000Z',
      ),
    );
    const f = put('claude-blocks.jsonl', [line]);
    return readFeed(f, 'claude').then((r) => {
      const p = page(r);
      expect(p.entries.map((e) => e.kind)).toEqual(['thinking', 'agent', 'tool']);
      expect(p.entries[0].text).toBe('надо посмотреть файл');
      expect(p.entries[1].text).toBe('Смотрю файл.');
      expect(p.entries[2]).toMatchObject({ kind: 'tool', tool: 'Read', text: 'Read /w/src/a.ts' });
      // Идентификатор первого блока — uuid записи, дальше суффикс: строка одна, записей три.
      expect(p.entries.map((e) => e.id)).toEqual(['a1', 'a1#1', 'a1#2']);
    });
  });

  it('не пускает в ленту вывод инструмента и служебные записи', async () => {
    const f = put('claude-noise.jsonl', [
      cToolResult('r1', '2026-09-14T10:00:02.000Z'),
      { type: 'attachment', uuid: 'x1', timestamp: '2026-09-14T10:00:03.000Z', attachment: { type: 'x' } },
      { type: 'file-history-snapshot', messageId: 'm', snapshot: {} },
      { type: 'ai-title', title: 'что-то' },
      { type: 'queue-operation', op: 'add' },
      {
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>…</local-command-caveat>' },
        uuid: 'meta1',
        timestamp: '2026-09-14T10:00:04.000Z',
      },
      cHuman('u2', 'вопрос', '2026-09-14T10:00:05.000Z'),
    ]);
    const p = page(await readFeed(f, 'claude'));
    expect(p.entries).toEqual([
      { id: 'u2', at: Date.parse('2026-09-14T10:00:05.000Z'), kind: 'human', text: 'вопрос' },
    ]);
    expect(p.skipped).toBe(0);
  });

  it('вехи беседы едут отдельным видом записи', async () => {
    const f = put('claude-notes.jsonl', [
      {
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'This session is being continued…' },
        uuid: 'c1',
        timestamp: '2026-09-14T10:00:06.000Z',
      },
      {
        type: 'user',
        interruptedMessageId: 'msg_011',
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
        uuid: 'i1',
        timestamp: '2026-09-14T10:00:07.000Z',
      },
      cAssistant('e1', [{ type: 'text', text: "You've hit your weekly limit" }], '2026-09-14T10:00:08.000Z', {
        isApiErrorMessage: true,
      }),
    ]);
    const p = page(await readFeed(f, 'claude'));
    expect(p.entries.map((e) => [e.kind, e.note])).toEqual([
      ['note', 'compacted'],
      ['note', 'interrupted'],
      ['note', 'error'],
    ]);
    expect(p.entries[2].text).toBe("You've hit your weekly limit");
  });

  it('помечает веткой подагента записи бокового потока', () => {
    const line = JSON.stringify({
      isSidechain: true,
      agentId: 'a5a2119f4b01eb75b',
      agentName: 'Explore',
      type: 'user',
      message: { role: 'user', content: 'задание подагенту' },
      uuid: 's1',
      timestamp: '2026-09-14T10:00:09.000Z',
    });
    expect(parseLine(line, 'claude')).toMatchObject({ kind: 'human', branch: 'Explore' });
  });

  it('без имени подагента ветка не называется техническим идентификатором', async () => {
    const record = {
      isSidechain: true,
      agentId: 'a5a2119f4b01eb75b',
      type: 'user',
      message: { role: 'user', content: 'задание подагенту' },
      uuid: 's2',
      timestamp: '2026-09-14T10:00:10.000Z',
    };
    const one = parseLine(JSON.stringify(record), 'claude');
    // Имя ветки показывают человеку: `agentId` там читается как мусор, и запасным
    // вариантом он быть не может — записи без имени едут без ветки вовсе.
    expect(one?.branch).toBeUndefined();
    expect(one).toEqual({
      id: 's2',
      at: Date.parse('2026-09-14T10:00:10.000Z'),
      kind: 'human',
      text: 'задание подагенту',
    });
    const p = page(await readFeed(put('claude-branchless.jsonl', [record]), 'claude'));
    expect(p.entries[0].branch).toBeUndefined();
    expect(Object.keys(p.entries[0])).not.toContain('branch');
  });
});

describe('parseLine: Codex', () => {
  it('приводит реплики и мышление к той же форме', async () => {
    const f = put('codex-basic.jsonl', [
      xMeta('2026-09-14T11:00:00.000Z'),
      xMessage('msg_d', 'developer', '<permissions instructions>', '2026-09-14T11:00:01.000Z', 1),
      xMessage('msg_u', 'user', 'собери плагин', '2026-09-14T11:00:02.000Z', 2),
      {
        timestamp: '2026-09-14T11:00:03.000Z',
        ordinal: 3,
        type: 'response_item',
        payload: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'план такой' }] },
      },
      {
        timestamp: '2026-09-14T11:00:04.000Z',
        ordinal: 4,
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc_1',
          name: 'exec_command',
          arguments: '{"cmd":"npm test","workdir":"/w"}',
          call_id: 'call_1',
        },
      },
      {
        timestamp: '2026-09-14T11:00:05.000Z',
        ordinal: 5,
        type: 'response_item',
        payload: { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'ok' },
      },
      { timestamp: '2026-09-14T11:00:06.000Z', ordinal: 6, type: 'token_usage_record', payload: { total: 1 } },
      { timestamp: '2026-09-14T11:00:07.000Z', ordinal: 7, type: 'event_msg', payload: { type: 'token_count' } },
      xMessage('msg_a', 'assistant', 'готово', '2026-09-14T11:00:08.000Z', 8),
    ]);
    const p = page(await readFeed(f, 'codex'));
    expect(p.entries.map((e) => e.kind)).toEqual(['human', 'thinking', 'tool', 'agent']);
    expect(p.entries[0]).toEqual({ id: 'msg_u', at: Date.parse('2026-09-14T11:00:02.000Z'), kind: 'human', text: 'собери плагин' });
    expect(p.entries[1].text).toBe('план такой');
    expect(p.entries[2]).toMatchObject({ tool: 'exec_command', text: 'exec_command npm test' });
    expect(p.entries[3].id).toBe('msg_a');
  });

  it('вехи Codex — те же виды, что у Claude', async () => {
    const f = put('codex-notes.jsonl', [
      xMeta('2026-09-14T11:01:00.000Z'),
      {
        timestamp: '2026-09-14T11:01:01.000Z',
        ordinal: 1,
        type: 'compacted',
        payload: { message: 'история свёрнута', replacement_history: [] },
      },
      {
        timestamp: '2026-09-14T11:01:02.000Z',
        ordinal: 2,
        type: 'event_msg',
        payload: { type: 'error', message: 'stream disconnected' },
      },
      {
        timestamp: '2026-09-14T11:01:03.000Z',
        ordinal: 3,
        type: 'response_item',
        payload: { type: 'custom_tool_call', id: 'ctc_1', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /w/a.ts' },
      },
    ]);
    const p = page(await readFeed(f, 'codex'));
    expect(p.entries.map((e) => [e.kind, e.note ?? e.tool])).toEqual([
      ['note', 'compacted'],
      ['note', 'error'],
      ['tool', 'apply_patch'],
    ]);
    expect(p.entries[1].text).toBe('stream disconnected');
  });

  it('аргумент массивом даёт ту же подпись, что и строкой', () => {
    const shell = JSON.stringify({
      timestamp: '2026-09-14T11:03:00.000Z',
      ordinal: 1,
      type: 'response_item',
      payload: {
        type: 'function_call',
        id: 'fc_2',
        name: 'shell',
        arguments: '{"command":["bash","-lc","ls -la /w"],"workdir":"/w"}',
        call_id: 'call_2',
      },
    });
    expect(parseLine(shell, 'codex')).toMatchObject({
      kind: 'tool',
      tool: 'shell',
      text: 'shell bash -lc ls -la /w',
    });
    const long = JSON.stringify({
      timestamp: '2026-09-14T11:03:01.000Z',
      ordinal: 2,
      type: 'response_item',
      payload: {
        type: 'function_call',
        id: 'fc_3',
        name: 'shell',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'echo ' + 'a'.repeat(500)] }),
      },
    });
    // Подпись, а не содержимое: склейка режется тем же пределом в 200 знаков.
    const arg = (parseLine(long, 'codex') as { text: string }).text.slice('shell '.length);
    expect(arg.length).toBe(201);
    expect(arg.startsWith('bash -lc echo aaa')).toBe(true);
  });

  it('берёт порядковый номер записи, когда идентификатора у неё нет', () => {
    const line = JSON.stringify({
      timestamp: '2026-09-14T11:02:00.000Z',
      ordinal: 42,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'без id' }] },
    });
    expect(parseLine(line, 'codex')).toMatchObject({ id: '42', kind: 'agent', text: 'без id' });
  });
});

describe('readFeed: хвост и целость страницы', () => {
  it('без курсора отдаёт весь короткий файл с краями bof и eof', async () => {
    const f = put('tail-small.jsonl', [
      cHuman('u1', 'раз', '2026-09-14T12:00:00.000Z'),
      cAssistant('a1', [{ type: 'text', text: 'два' }], '2026-09-14T12:00:01.000Z'),
    ]);
    const p = page(await readFeed(f, 'claude'));
    const st = fs.statSync(f);
    expect(p.agent).toBe('claude');
    expect(p.entries.map((e) => e.text)).toEqual(['раз', 'два']);
    expect(p.bof).toBe(true);
    expect(p.eof).toBe(true);
    expect(p.head).toBe(`${st.ino}:0`);
    expect(p.tail).toBe(`${st.ino}:${st.size}`);
  });

  it('битая строка пропускается, счётчик растёт, остальная страница цела', async () => {
    const f = put('broken.jsonl', [
      cHuman('u1', 'раз', '2026-09-14T12:01:00.000Z'),
      '{"type":"user","message":{"role":"user","content":"обрыв',
      'не json вовсе',
      cHuman('u2', 'два', '2026-09-14T12:01:02.000Z'),
    ]);
    const p = page(await readFeed(f, 'claude'));
    expect(p.entries.map((e) => e.text)).toEqual(['раз', 'два']);
    expect(p.skipped).toBe(2);
  });

  it('не считает пропущенной недописанную последнюю строку живого файла', async () => {
    const f = put('growing.jsonl', [cHuman('u1', 'раз', '2026-09-14T12:02:00.000Z')]);
    fs.appendFileSync(f, '{"type":"user","message":{"role":"user","content":"пиш');
    const p = page(await readFeed(f, 'claude'));
    expect(p.entries.map((e) => e.text)).toEqual(['раз']);
    expect(p.skipped).toBe(0);
    expect(p.eof).toBe(true);
  });

  it('нет файла — отказ прежним словом определителя', async () => {
    const r = await readFeed(path.join(dir, 'no-such.jsonl'), 'claude');
    expect(r).toMatchObject({ ok: false, reason: 'no-transcript' });
  });
});

describe('readFeed: курсоры и подкачка', () => {
  /** Файл из n реплик человека: «e1»…«en», по секунде на реплику. */
  const many = (name: string, n: number): string =>
    put(
      name,
      Array.from({ length: n }, (_, i) =>
        cHuman(`u${i + 1}`, `e${i + 1}`, `2026-09-14T13:00:${String(i).padStart(2, '0')}.000Z`),
      ),
    );

  it('без курсора отдаёт последние limit записей, а не начало файла', async () => {
    const f = many('cursor-tail.jsonl', 9);
    const p = page(await readFeed(f, 'claude', { limit: 3 }));
    expect(p.entries.map((e) => e.text)).toEqual(['e7', 'e8', 'e9']);
    expect(p.bof).toBe(false);
    expect(p.eof).toBe(true);
  });

  it('before доходит до начала файла страницами, без дублей и пропусков', async () => {
    const f = many('cursor-before.jsonl', 9);
    const a = page(await readFeed(f, 'claude', { limit: 3 }));
    const b = page(await readFeed(f, 'claude', { limit: 3, before: a.head }));
    const c = page(await readFeed(f, 'claude', { limit: 3, before: b.head }));
    expect(b.entries.map((e) => e.text)).toEqual(['e4', 'e5', 'e6']);
    expect(c.entries.map((e) => e.text)).toEqual(['e1', 'e2', 'e3']);
    expect(b.bof).toBe(false);
    expect(c.bof).toBe(true);
    expect(c.eof).toBe(false);
  });

  it('after отдаёт только появившееся после курсора', async () => {
    const f = many('cursor-after.jsonl', 3);
    const a = page(await readFeed(f, 'claude', { limit: 3 }));
    const idle = page(await readFeed(f, 'claude', { after: a.tail }));
    expect(idle.entries).toEqual([]);
    expect(idle.eof).toBe(true);
    fs.appendFileSync(
      f,
      JSON.stringify(cHuman('u4', 'e4', '2026-09-14T13:00:03.000Z')) +
        '\n' +
        JSON.stringify(cHuman('u5', 'e5', '2026-09-14T13:00:04.000Z')) +
        '\n',
    );
    const next = page(await readFeed(f, 'claude', { after: a.tail }));
    expect(next.entries.map((e) => e.text)).toEqual(['e4', 'e5']);
    expect(next.eof).toBe(true);
  });

  it('курсор переживает дописывание файла', async () => {
    const f = many('cursor-append.jsonl', 6);
    const a = page(await readFeed(f, 'claude', { limit: 3 }));
    fs.appendFileSync(f, JSON.stringify(cHuman('u7', 'e7', '2026-09-14T13:00:06.000Z')) + '\n');
    const back = page(await readFeed(f, 'claude', { limit: 3, before: a.head }));
    expect(back.entries.map((e) => e.text)).toEqual(['e1', 'e2', 'e3']);
  });

  it('around отдаёт половину лимита до записи и половину после', async () => {
    const f = many('cursor-around.jsonl', 9);
    const a = page(await readFeed(f, 'claude', { limit: 3 }));
    const round = page(await readFeed(f, 'claude', { limit: 4, around: a.head }));
    expect(round.entries.map((e) => e.text)).toEqual(['e5', 'e6', 'e7', 'e8']);
    expect(round.bof).toBe(false);
    expect(round.eof).toBe(false);
  });

  it('around не отдаёт больше лимита, когда половины не хватает на обе стороны', async () => {
    const f = many('cursor-around-one.jsonl', 9);
    const a = page(await readFeed(f, 'claude', { limit: 3 }));
    const round = page(await readFeed(f, 'claude', { limit: 1, around: a.head }));
    expect(round.entries.map((e) => e.text)).toEqual(['e7']);
  });

  it('курсор от другого файла — отказ cursor-stale, а не чужая беседа', async () => {
    const f = many('cursor-stale.jsonl', 3);
    const st = fs.statSync(f);
    const alien = `${st.ino + 1}:0`;
    expect(await readFeed(f, 'claude', { after: alien })).toMatchObject({
      ok: false,
      reason: 'cursor-stale',
    });
    expect(await readFeed(f, 'claude', { before: 'какая-то ерунда' })).toMatchObject({
      ok: false,
      reason: 'cursor-stale',
    });
    expect(await readFeed(f, 'claude', { around: `${st.ino}:${st.size + 1}` })).toMatchObject({
      ok: false,
      reason: 'cursor-stale',
    });
  });
});

describe('readFeed: пределы', () => {
  it('режет текст записи по 64 КиБ и помечает обрезку', async () => {
    const f = put('limit-text.jsonl', [
      cHuman('u1', 'коротко', '2026-09-14T14:00:00.000Z'),
      cHuman('u2', 'x'.repeat(20_000), '2026-09-14T14:00:01.000Z'),
      cHuman('u3', 'x'.repeat(70_000), '2026-09-14T14:00:02.000Z'),
    ]);
    const p = page(await readFeed(f, 'claude'));
    expect(p.entries[0].truncated).toBeUndefined();
    // Реплика человека едет целиком: 99-й процентиль живых реплик — 7,8 КиБ.
    expect(p.entries[1].truncated).toBeUndefined();
    expect(p.entries[1].text.length).toBe(20_000);
    expect(p.entries[2].truncated).toBe(true);
    expect(Buffer.byteLength(p.entries[2].text)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(p.entries[2].text)).toBeGreaterThan(60 * 1024);
    expect(p.entries[2].text.startsWith('xxx')).toBe(true);
  });

  it('по умолчанию отдаёт 200 записей, а сверх 1000 не отдаёт никогда', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) =>
      cHuman(`u${i + 1}`, `e${i + 1} ${'п'.repeat(100)}`, '2026-09-14T14:01:00.000Z'),
    );
    const f = put('limit-count.jsonl', lines);
    expect(fs.statSync(f).size).toBeGreaterThan(256 * 1024);
    const byDefault = page(await readFeed(f, 'claude'));
    expect(byDefault.entries.length).toBe(200);
    expect(byDefault.entries[0].text.startsWith('e2801 ')).toBe(true);
    const asked = page(await readFeed(f, 'claude', { limit: 5000 }));
    expect(asked.entries.length).toBe(1000);
    expect(asked.entries[0].text.startsWith('e2001 ')).toBe(true);
    expect(asked.bof).toBe(false);
    expect(asked.eof).toBe(true);
  });

  it('на строке длиннее потолка окна страница пуста, но курсор идёт дальше', async () => {
    // Строка длиннее 4 МиБ в окно не помещается никогда; на живых данных такая есть
    // (запись сжатия Codex 4,19 МБ). Лента обязана перешагнуть её, а не встать.
    const giant = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5 * 1024 * 1024) }],
      },
      toolUseResult: { stdout: 'x' },
      uuid: 'big',
      timestamp: '2026-09-14T14:03:02.000Z',
    };
    const f = put('window-cap.jsonl', [
      cHuman('u1', 'e1', '2026-09-14T14:03:00.000Z'),
      cHuman('u2', 'e2', '2026-09-14T14:03:01.000Z'),
      giant,
      cHuman('u3', 'e3', '2026-09-14T14:03:03.000Z'),
      cHuman('u4', 'e4', '2026-09-14T14:03:04.000Z'),
    ]);
    const at = (cursor: string): number => Number(cursor.split(':')[1]);
    const a = page(await readFeed(f, 'claude', { limit: 2 }));
    expect(a.entries.map((e) => e.text)).toEqual(['e3', 'e4']);
    const b = page(await readFeed(f, 'claude', { limit: 2, before: a.head }));
    expect(b.entries).toEqual([]);
    expect(at(b.head)).toBeLessThan(at(a.head));
    expect(b.bof).toBe(false);
    const c = page(await readFeed(f, 'claude', { limit: 2, before: b.head }));
    expect(c.entries.map((e) => e.text)).toEqual(['e1', 'e2']);
    expect(c.bof).toBe(true);
  });

  it('шаг вперёд через строку длиннее окна не выдумывает битых строк', async () => {
    // Та же строка-переросток, что и в проверке назад, но ветка чтения вперёд своя:
    // курсор после шага стоит в середине строки, и её обрывок — не битая строка файла.
    const giant = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't2', content: 'x'.repeat(5 * 1024 * 1024) }],
      },
      toolUseResult: { stdout: 'x' },
      uuid: 'big2',
      timestamp: '2026-09-14T14:04:02.000Z',
    };
    const f = put('window-cap-fwd.jsonl', [
      cHuman('u1', 'e1', '2026-09-14T14:04:00.000Z'),
      cHuman('u2', 'e2', '2026-09-14T14:04:01.000Z'),
      giant,
      cHuman('u3', 'e3', '2026-09-14T14:04:03.000Z'),
      cHuman('u4', 'e4', '2026-09-14T14:04:04.000Z'),
    ]);
    const ino = fs.statSync(f).ino;
    const at = (cursor: string): number => Number(cursor.split(':')[1]);
    const first = page(await readFeed(f, 'claude', { limit: 2, after: `${ino}:0` }));
    expect(first.entries.map((e) => e.text)).toEqual(['e1', 'e2']);
    const stuck = page(await readFeed(f, 'claude', { limit: 2, after: first.tail }));
    expect(stuck.entries).toEqual([]);
    expect(at(stuck.tail)).toBeGreaterThan(at(first.tail));
    expect(stuck.skipped).toBe(0);
    expect(stuck.eof).toBe(false);
    const resumed = page(await readFeed(f, 'claude', { limit: 2, after: stuck.tail }));
    expect(resumed.entries.map((e) => e.text)).toEqual(['e3', 'e4']);
    expect(resumed.skipped).toBe(0);
    expect(resumed.eof).toBe(true);
  });

  it('ответ не перерастает 1 МиБ: отдаёт, что успело, и курсор на продолжение', async () => {
    const lines = Array.from({ length: 300 }, (_, i) =>
      cHuman(`u${i + 1}`, `e${i + 1} ${'y'.repeat(9000)}`, '2026-09-14T14:02:00.000Z'),
    );
    const f = put('limit-bytes.jsonl', lines);
    const p = page(await readFeed(f, 'claude'));
    const bytes = p.entries.reduce((n, e) => n + Buffer.byteLength(e.text), 0);
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(p.entries.length).toBeGreaterThan(100);
    expect(p.entries.length).toBeLessThan(200);
    expect(p.entries[p.entries.length - 1].text.startsWith('e300 ')).toBe(true);
    // Курсор головы продолжает ленту ровно там, где страница оборвалась.
    const prev = page(await readFeed(f, 'claude', { limit: 1, before: p.head }));
    const firstShown = Number(p.entries[0].text.slice(1, p.entries[0].text.indexOf(' ')));
    expect(prev.entries[0].text.startsWith(`e${firstShown - 1} `)).toBe(true);
  });
});
