// Исход действия: поле `result` записи `tool` страницы ленты и `result` подробностей.
// Строки собраны вручную по замеру форм (Claude: is_error + «Exit code N», interrupted
// в toolUseResult; Codex: «Exit code: N» / «Process exited with code N», metadata.exit_code).
// Цветов ANSI в выводе обоих агентов в транскриптах нет — тут их и не проверяем.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readDetail, readFeed, type FeedEntry, type FeedPage } from '../src/transcript-feed.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-result-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (name: string, lines: unknown[]): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};
const at = (n: number): string => `2026-11-12T10:00:${String(n).padStart(2, '0')}.000Z`;

const cCall = (uuid: string, id: string, n: number): unknown => ({
  type: 'assistant',
  uuid,
  timestamp: at(n),
  message: { id: `m-${uuid}`, role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'make' } }] },
});
const cResult = (uuid: string, id: string, n: number, block: object, meta: object = { stdout: '' }): unknown => ({
  type: 'user',
  uuid,
  timestamp: at(n),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, ...block }] },
  toolUseResult: meta,
});
const xCall = (id: string, callId: string, n: number): unknown => ({
  timestamp: at(n),
  type: 'response_item',
  payload: { id, type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'make'] }), call_id: callId },
});
const xOut = (callId: string, output: string, n: number): unknown => ({
  timestamp: at(n),
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: callId, output },
});

async function tools(file: string, agent: 'claude' | 'codex'): Promise<FeedEntry[]> {
  const res = (await readFeed(file, agent)) as FeedPage;
  return res.entries.filter((e) => e.kind === 'tool');
}

describe('исход действия в странице ленты', () => {
  it('Claude: выполнено, ошибка с кодом, ошибка без кода, прервано', async () => {
    const file = put('claude.jsonl', [
      cCall('a1', 't1', 1),
      cResult('r1', 't1', 2, { content: 'ok' }),
      cCall('a2', 't2', 3),
      cResult('r2', 't2', 4, { content: 'Exit code 2\nboom', is_error: true }),
      cCall('a3', 't3', 5),
      cResult('r3', 't3', 6, { content: 'denied', is_error: true }),
      cCall('a4', 't4', 7),
      cResult('r4', 't4', 8, { content: 'x', is_error: true }, { interrupted: true }),
    ]);
    expect((await tools(file, 'claude')).map((e) => e.result)).toEqual([
      { state: 'done' },
      { state: 'failed', exit: 2 },
      { state: 'failed' },
      { state: 'stopped' },
    ]);
  });

  it('Claude: вызов без результата в конце файла выполняется', async () => {
    const file = put('claude-run.jsonl', [cCall('a1', 't1', 1)]);
    expect((await tools(file, 'claude'))[0]!.result).toEqual({ state: 'running' });
  });

  it('Codex: код из «Exit code:», «Process exited with code» и metadata.exit_code', async () => {
    const file = put('codex.jsonl', [
      xCall('p1', 'c1', 1),
      xOut('c1', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nfine', 2),
      xCall('p2', 'c2', 3),
      xOut('c2', 'Chunk ID: ab12\nWall time: 0.0 seconds\nProcess exited with code 1\nOutput:\nbad', 4),
      xCall('p3', 'c3', 5),
      xOut('c3', JSON.stringify({ output: 'bad', metadata: { exit_code: 127 } }), 6),
      xCall('p4', 'c4', 7),
      xOut('c4', 'Chunk ID: cd34\nWall time: 1.0 seconds\nProcess running with session ID 42\nOutput:\n', 8),
    ]);
    expect((await tools(file, 'codex')).map((e) => e.result)).toEqual([
      { state: 'done' },
      { state: 'failed', exit: 1 },
      { state: 'failed', exit: 127 },
      { state: 'running' },
    ]);
  });

  it('результата нет в окне, а файл дальше: поля нет — неизвестно, а не «выполняется»', async () => {
    const file = put('mid.jsonl', [cCall('a1', 't1', 1), cResult('r1', 't1', 2, { content: 'ok' })]);
    // Окно «до» строки результата: вызов в нём есть, результат остался за краем.
    const all = (await readFeed(file, 'claude')) as FeedPage;
    const ino = all.head.split(':')[0];
    const resultAt = Buffer.byteLength(fs.readFileSync(file, 'utf8').split('\n')[0]!) + 1;
    const page = (await readFeed(file, 'claude', { before: `${ino}:${resultAt}` })) as FeedPage;
    expect(page.eof).toBe(false);
    expect(page.entries[0]!.result).toBeUndefined();
  });
});

describe('исход в подробностях', () => {
  it('ошибка и прерывание называются, успех и выполнение — отсутствием поля', async () => {
    const file = put('detail.jsonl', [
      cCall('a1', 't1', 1),
      cResult('r1', 't1', 2, { content: 'Exit code 3\nno', is_error: true }),
      cCall('a2', 't2', 3),
      cResult('r2', 't2', 4, { content: 'ok' }),
      cCall('a3', 't3', 5),
    ]);
    const [bad, good, run] = await tools(file, 'claude');
    expect(await readDetail(file, 'claude', bad!.cursor!)).toMatchObject({ ok: true, result: { state: 'failed', exit: 3 } });
    expect(await readDetail(file, 'claude', good!.cursor!)).not.toHaveProperty('result');
    expect(await readDetail(file, 'claude', run!.cursor!)).toMatchObject({ pending: true });
  });
});
