// Подробности действия: readDetail() над подложенными файлами во временном каталоге.
// Формы строк — по замеру docs/native-agent-ui.ru.md («Ответы на "не удалось выяснить"»):
// Claude — tool_use.id ↔ tool_result.tool_use_id, toolUseResult.structuredPatch; Codex —
// call_id у вызова и у его вывода. Строки собраны вручную, чужих бесед здесь нет.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readDetail, readFeed, type FeedEntry, type FeedPage } from '../src/transcript-feed.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-detail-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (name: string, lines: unknown[]): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
};

/** Страница ленты, а из неё — запись по имени инструмента: курсор берётся тем же путём,
 *  каким его берёт клиент. */
async function entryOf(file: string, agent: 'claude' | 'codex', tool: string): Promise<FeedEntry> {
  const res = (await readFeed(file, agent)) as FeedPage;
  expect(res.ok).toBe(true);
  const found = res.entries.find((e) => e.tool === tool);
  expect(found).toBeDefined();
  return found!;
}

const at = (n: number): string => `2026-11-12T10:00:${String(n).padStart(2, '0')}.000Z`;

const call = (uuid: string, id: string, name: string, input: unknown, n: number): unknown => ({
  type: 'assistant',
  uuid,
  timestamp: at(n),
  message: { id: `m-${uuid}`, role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (uuid: string, id: string, content: unknown, n: number, extra: object = {}): unknown => ({
  type: 'user',
  uuid,
  timestamp: at(n),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  toolUseResult: { stdout: 'x' },
  ...extra,
});
const human = (uuid: string, text: string, n: number): unknown => ({
  type: 'user',
  uuid,
  timestamp: at(n),
  message: { role: 'user', content: text },
});

describe('readDetail — Claude', () => {
  it('Bash: команда целиком и вывод; запись ленты помечена признаком подробностей', async () => {
    const file = put('bash.jsonl', [
      human('u0', 'прогони тесты', 0),
      call('a1', 'toolu_1', 'Bash', { command: 'npm test\nnpm run lint', description: 'run' }, 1),
      result('r1', 'toolu_1', '3 passed\n0 failed', 2),
    ]);
    const entry = await entryOf(file, 'claude', 'Bash');
    expect(entry.detail).toBe(true);
    expect(await readDetail(file, 'claude', entry.cursor!)).toEqual({
      ok: true,
      input: 'npm test\nnpm run lint',
      output: '3 passed\n0 failed',
    });
  });

  it('вывод берётся блоками text, если content — список', async () => {
    const file = put('bash-blocks.jsonl', [
      call('a1', 'toolu_1', 'Bash', { command: 'ls' }, 1),
      result('r1', 'toolu_1', [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], 2),
    ]);
    const entry = await entryOf(file, 'claude', 'Bash');
    expect(await readDetail(file, 'claude', entry.cursor!)).toMatchObject({ ok: true, output: 'one\ntwo' });
  });

  it('Edit: diff по строкам из structuredPatch, без ввода и вывода', async () => {
    const file = put('edit.jsonl', [
      call('a1', 'toolu_e', 'Edit', { file_path: '/w/a.ts', old_string: 'b', new_string: 'c' }, 1),
      result('r1', 'toolu_e', 'The file /w/a.ts has been updated.', 2, {
        toolUseResult: {
          filePath: '/w/a.ts',
          oldString: 'b',
          newString: 'c',
          structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', ' d'] }],
        },
      }),
    ]);
    const entry = await entryOf(file, 'claude', 'Edit');
    expect(await readDetail(file, 'claude', entry.cursor!)).toEqual({
      ok: true,
      diff: [
        {
          path: '/w/a.ts',
          lines: [
            { t: ' ', s: 'a' },
            { t: '-', s: 'b' },
            { t: '+', s: 'c' },
            { t: ' ', s: 'd' },
          ],
        },
      ],
    });
  });

  it('Write нового файла: structuredPatch пуст — все строки содержимого добавленные', async () => {
    const file = put('write.jsonl', [
      call('a1', 'toolu_w', 'Write', { file_path: '/w/new.txt', content: 'x\ny\n' }, 1),
      result('r1', 'toolu_w', 'File created', 2, {
        toolUseResult: { type: 'create', filePath: '/w/new.txt', content: 'x\ny\n', structuredPatch: [], originalFile: null },
      }),
    ]);
    const entry = await entryOf(file, 'claude', 'Write');
    expect(await readDetail(file, 'claude', entry.cursor!)).toEqual({
      ok: true,
      diff: [
        {
          path: '/w/new.txt',
          lines: [
            { t: '+', s: 'x' },
            { t: '+', s: 'y' },
          ],
        },
      ],
    });
  });

  it('без результата действие названо pending, ввод при этом отдаётся', async () => {
    const file = put('pending.jsonl', [call('a1', 'toolu_p', 'Bash', { command: 'sleep 60' }, 1)]);
    const entry = await entryOf(file, 'claude', 'Bash');
    expect(await readDetail(file, 'claude', entry.cursor!)).toEqual({ ok: true, input: 'sleep 60', pending: true });
  });

  it('результат лежит через чужие строки, а чужой результат не подходит', async () => {
    const file = put('far.jsonl', [
      call('a1', 'toolu_1', 'Bash', { command: 'first' }, 1),
      call('a2', 'toolu_2', 'Bash', { command: 'second' }, 2),
      result('r2', 'toolu_2', 'out-two', 3),
      human('u1', 'между делом', 4),
      result('r1', 'toolu_1', 'out-one', 5),
    ]);
    const first = ((await readFeed(file, 'claude')) as FeedPage).entries.find((e) => e.text === 'Bash first')!;
    expect(await readDetail(file, 'claude', first.cursor!)).toMatchObject({ output: 'out-one' });
  });

  it('вывод длиннее 64 КиБ обрезан с пометкой truncated', async () => {
    const file = put('big.jsonl', [
      call('a1', 'toolu_b', 'Bash', { command: 'yes' }, 1),
      result('r1', 'toolu_b', 'я'.repeat(50000), 2),
    ]);
    const entry = await entryOf(file, 'claude', 'Bash');
    const res = await readDetail(file, 'claude', entry.cursor!);
    expect(res).toMatchObject({ ok: true, truncated: true });
    const output = (res as { output: string }).output;
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64 * 1024);
    expect(output.length).toBeGreaterThan(30000);
    expect(output.includes('�')).toBe(false);
  });

  it('несколько инструментов в одной строке: у каждого свой курсор и свои подробности', async () => {
    const file = put('many.jsonl', [
      {
        type: 'assistant',
        uuid: 'm1',
        timestamp: at(1),
        message: {
          id: 'm-m1',
          role: 'assistant',
          model: 'm',
          content: [
            { type: 'text', text: 'Смотрю оба места.' },
            { type: 'tool_use', id: 'tu-a', name: 'Bash', input: { command: 'ls src' } },
            { type: 'tool_use', id: 'tu-b', name: 'Bash', input: { command: 'cat README.md' } },
            { type: 'tool_use', id: 'tu-c', name: 'Read', input: { file_path: '/p/a.ts' } },
          ],
        },
      },
      result('r-b', 'tu-b', 'readme text', 2),
      result('r-a', 'tu-a', 'a.ts\nb.ts', 3),
      result('r-c', 'tu-c', 'file body', 4),
    ]);
    const page = (await readFeed(file, 'claude')) as FeedPage;
    const tools = page.entries.filter((e) => e.kind === 'tool');
    expect(tools).toHaveLength(3);
    const cursors = tools.map((e) => e.cursor!);
    expect(new Set(cursors).size).toBe(3);
    // Первый инструмент и текст строки держат прежний курсор строки.
    expect(cursors[0]).toBe(page.entries[0]!.cursor);
    expect(cursors[0]).toMatch(/^\d+:\d+$/);
    expect(await readDetail(file, 'claude', cursors[0]!)).toMatchObject({ ok: true, input: 'ls src', output: 'a.ts\nb.ts' });
    expect(await readDetail(file, 'claude', cursors[1]!)).toMatchObject({
      ok: true,
      input: 'cat README.md',
      output: 'readme text',
    });
    expect(await readDetail(file, 'claude', cursors[2]!)).toMatchObject({ ok: true, output: 'file body' });
    // Курсор любого из них годится для прыжка: страница вокруг — та же строка целиком.
    const around = (await readFeed(file, 'claude', { around: cursors[2]! })) as FeedPage;
    expect(around.ok).toBe(true);
    expect(around.entries.filter((e) => e.kind === 'tool').map((e) => e.cursor)).toEqual(cursors);
    // Инструмента с таким номером в строке нет — курсор не на действии.
    expect(await readDetail(file, 'claude', `${cursors[0]}#7`)).toMatchObject({ ok: false, reason: 'cursor-stale' });
  });

  it('курсор не на действии, чужой файл и середина строки — cursor-stale', async () => {
    const file = put('stale.jsonl', [human('u0', 'привет', 0), call('a1', 'toolu_1', 'Bash', { command: 'ls' }, 1)]);
    const page = (await readFeed(file, 'claude')) as FeedPage;
    const hum = page.entries.find((e) => e.kind === 'human')!;
    expect(await readDetail(file, 'claude', hum.cursor!)).toMatchObject({ ok: false, reason: 'cursor-stale' });
    const other = put('stale-other.jsonl', [human('u0', 'другой файл', 0)]);
    const act = page.entries.find((e) => e.kind === 'tool')!;
    expect(await readDetail(other, 'claude', act.cursor!)).toMatchObject({ ok: false, reason: 'cursor-stale' });
    const [ino, off] = act.cursor!.split(':');
    expect(await readDetail(file, 'claude', `${ino}:${Number(off) + 3}`)).toMatchObject({ ok: false, reason: 'cursor-stale' });
    expect(await readDetail(file, 'claude', 'мусор')).toMatchObject({ ok: false, reason: 'cursor-stale' });
    expect(await readDetail(path.join(dir, 'nope.jsonl'), 'claude', act.cursor!)).toMatchObject({
      ok: false,
      reason: 'no-transcript',
    });
  });
});

const xCall = (id: string, payload: object, n: number): unknown => ({
  timestamp: at(n),
  type: 'response_item',
  payload: { id, ...payload },
});

describe('readDetail — Codex', () => {
  it('shell: команда из массива и вывод из JSON-обёртки', async () => {
    const file = put('codex-shell.jsonl', [
      xCall('p1', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'] }), call_id: 'call_1' }, 1),
      {
        timestamp: at(2),
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ output: 'a.txt\n', metadata: { exit_code: 0 } }) },
      },
    ]);
    const entry = await entryOf(file, 'codex', 'shell');
    expect(entry.detail).toBe(true);
    expect(await readDetail(file, 'codex', entry.cursor!)).toEqual({ ok: true, input: 'ls -la', output: 'a.txt\n' });
  });

  it('exec-скрипт: команды достаются из скрипта, вывод — обычным текстом', async () => {
    const script = 'const r = await tools.exec_command({cmd:"git status",workdir:"/w"});';
    const file = put('codex-exec.jsonl', [
      xCall('p1', { type: 'custom_tool_call', name: 'exec', input: script, call_id: 'call_2' }, 1),
      { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_2', output: 'On branch main' } },
    ]);
    const entry = await entryOf(file, 'codex', 'exec');
    expect(await readDetail(file, 'codex', entry.cursor!)).toEqual({ ok: true, input: 'git status', output: 'On branch main' });
  });

  it('apply_patch: diff по файлам из текста патча', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: /w/a.ts',
      '@@ function a',
      ' keep',
      '-old',
      '+new',
      '*** Add File: /w/b.txt',
      '+hello',
      '*** End Patch',
    ].join('\n');
    const file = put('codex-patch.jsonl', [
      xCall('p1', { type: 'custom_tool_call', name: 'apply_patch', input: patch, call_id: 'call_3' }, 1),
      { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_3', output: 'Success. Updated the following files:\nM /w/a.ts' } },
    ]);
    const entry = await entryOf(file, 'codex', 'apply_patch');
    expect(await readDetail(file, 'codex', entry.cursor!)).toEqual({
      ok: true,
      diff: [
        {
          path: '/w/a.ts',
          lines: [
            { t: ' ', s: 'keep' },
            { t: '-', s: 'old' },
            { t: '+', s: 'new' },
          ],
        },
        { path: '/w/b.txt', lines: [{ t: '+', s: 'hello' }] },
      ],
    });
  });

  it('без вывода — pending', async () => {
    const file = put('codex-pending.jsonl', [
      xCall('p1', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['sleep', '9'] }), call_id: 'call_4' }, 1),
    ]);
    const entry = await entryOf(file, 'codex', 'shell');
    expect(await readDetail(file, 'codex', entry.cursor!)).toEqual({ ok: true, input: 'sleep 9', pending: true });
  });
});
