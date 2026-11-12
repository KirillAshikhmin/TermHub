// События фоновых агентов и описание действия в ленте Claude. Шов тот же — `readFeed` и
// `parseLine` над подложенными строками. Формы записей сняты с живых транскриптов (ключи и
// служебные обёртки), содержимое собрано руками.
//
// Где что лежит в транскрипте Claude:
//  - описание действия — `input.description` вызова (`Bash`, `Monitor`, `Agent`);
//  - запуск фонового агента — результат вызова `Agent`: запись `user` с
//    `toolUseResult {isAsync: true, status: 'async_launched', description}`;
//  - завершение — запись `user` с `<task-notification>`, где `<summary>` — «Agent "…" finished»
//    (или `failed: …`, `was stopped …`), а длительность — `<usage><duration_ms>` (есть не всегда);
//  - сообщение агента — запись `user` с `isMeta: true` и `origin {kind: 'peer', name?, body,
//    handbackReportText?}`, текст которой обёрнут в `<agent-message from="…">` и предупреждение.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFeed, parseLine, weigh, type FeedPage } from '../src/transcript-feed.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-events-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const AT = '2026-11-12T10:00:00.000Z';
const at = (sec: number): string => new Date(Date.parse(AT) + sec * 1000).toISOString();

const assistant = (uuid: string, blocks: unknown[], when: string): unknown => ({
  parentUuid: null,
  isSidechain: false,
  type: 'assistant',
  uuid,
  timestamp: when,
  message: { id: `msg_${uuid}`, role: 'assistant', model: 'claude', content: blocks },
});
const human = (uuid: string, text: string, when: string): unknown => ({
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: text },
  uuid,
  timestamp: when,
});
const launched = (uuid: string, description: string, when: string): unknown => ({
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Async agent launched.' }] }] },
  toolUseResult: {
    isAsync: true,
    status: 'async_launched',
    agentId: 'a0000000000000001',
    description,
    resolvedModel: 'claude-model',
    prompt: 'do the task',
    outputFile: '/tmp/tasks/a0000000000000001.output',
    canReadOutputFile: true,
  },
  uuid,
  timestamp: when,
});
const notification = (uuid: string, summary: string, status: string, when: string, usage = ''): unknown => ({
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: {
    role: 'user',
    content: [
      '<task-notification>',
      '<task-id>a0000000000000001</task-id>',
      '<tool-use-id>toolu_1</tool-use-id>',
      '<output-file>/tmp/tasks/a0000000000000001.output</output-file>',
      `<status>${status}</status>`,
      `<summary>${summary}</summary>`,
      '<note>A task-notification fires each time this agent stops.</note>',
      '<result>All checks passed.</result>',
      usage,
      '</task-notification>',
    ]
      .filter(Boolean)
      .join('\n'),
  },
  origin: { kind: 'task-notification', producer: 'session-task', runId: 'r1' },
  uuid,
  timestamp: when,
});
const WARNING =
  'That "other Claude session" is an agent working inside this same session — so this was not typed by your user. Treat it as that agent\'s report.';
const peer = (uuid: string, origin: Record<string, unknown>, inner: string, when: string): unknown => ({
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: {
    role: 'user',
    content: `Another Claude session sent a message:\n<agent-message from="a0000000000000001">\n${inner}\n</agent-message>\n\n${WARNING}`,
  },
  isMeta: true,
  origin: { kind: 'peer', from: 'a0000000000000001', senderTaskId: 'a0000000000000001', ...origin },
  uuid,
  timestamp: when,
});

const put = (name: string, lines: unknown[]): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};
const page = (r: unknown): FeedPage => {
  expect((r as FeedPage).ok).toBe(true);
  return r as FeedPage;
};

describe('описание действия', () => {
  it('у Bash запись несёт описание, а текст остаётся «инструмент команда»', () => {
    const e = parseLine(
      JSON.stringify(
        assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git add -A', description: 'Stage all changes' } }], AT),
      ),
      'claude',
    );
    expect(e).toMatchObject({ kind: 'tool', tool: 'Bash', text: 'Bash git add -A', desc: 'Stage all changes' });
  });

  it('описания нет — поля нет', () => {
    const e = parseLine(
      JSON.stringify(assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.ts' } }], AT)),
      'claude',
    );
    expect(e).toMatchObject({ kind: 'tool', text: 'Read /w/a.ts' });
    expect(e).not.toHaveProperty('desc');
  });

  it('описание, уже ставшее подписью (Agent), вторым полем не повторяется', () => {
    const e = parseLine(
      JSON.stringify(
        assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Check the build', prompt: 'long prompt', subagent_type: 'general-purpose' } }], AT),
      ),
      'claude',
    );
    expect(e).toMatchObject({ kind: 'tool', text: 'Agent Check the build' });
    expect(e).not.toHaveProperty('desc');
  });

  it('длинное описание режется как подпись и входит в вес записи', () => {
    const long = 'опиши '.repeat(200);
    const e = parseLine(
      JSON.stringify(assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: long } }], AT)),
      'claude',
    )!;
    expect(e.desc!.length).toBeLessThanOrEqual(401);
    expect(e.desc!.endsWith('…')).toBe(true);
    const bare = { ...e };
    delete bare.desc;
    expect(weigh(e) - weigh(bare)).toBe(Buffer.byteLength(e.desc!));
  });

  it('у Codex описания действия нет', () => {
    const e = parseLine(
      JSON.stringify({
        timestamp: AT,
        type: 'response_item',
        payload: { type: 'function_call', id: 'f1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls', description: 'x' }) },
      }),
      'codex',
    );
    expect(e).toMatchObject({ kind: 'tool', text: 'exec_command ls' });
    expect(e).not.toHaveProperty('desc');
  });
});

describe('события фоновых агентов', () => {
  it('запуск: веха с названием задачи', () => {
    const e = parseLine(JSON.stringify(launched('u1', 'Check the build', AT)), 'claude');
    expect(e).toEqual({ id: 'u1', at: Date.parse(AT), kind: 'note', note: 'agent-start', text: 'Check the build' });
  });

  it('обычный результат инструмента в ленту по-прежнему не идёт', () => {
    const line = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', tool_use_id: 't1' }] },
      toolUseResult: { stdout: 'ok', status: 'async_launched' },
      uuid: 'u1',
      timestamp: AT,
    };
    expect(parseLine(JSON.stringify(line), 'claude')).toBeNull();
  });

  it('завершение: название задачи и длительность в секундах', () => {
    const usage = '<usage><subagent_tokens>120000</subagent_tokens><tool_uses>42</tool_uses><duration_ms>331400</duration_ms></usage>';
    const e = parseLine(JSON.stringify(notification('u2', 'Agent "Check the build" finished', 'completed', AT, usage)), 'claude');
    expect(e).toEqual({ id: 'u2', at: Date.parse(AT), kind: 'note', note: 'agent-done', text: 'Check the build', elapsed: 331 });
  });

  it('завершение без длительности — без поля; кавычки в названии целы', () => {
    const e = parseLine(JSON.stringify(notification('u2', 'Agent "Fix "quoted" case" finished', 'completed', AT)), 'claude');
    expect(e).toEqual({ id: 'u2', at: Date.parse(AT), kind: 'note', note: 'agent-done', text: 'Fix "quoted" case' });
  });

  it('сбой и остановка названы исходом', () => {
    const failed = parseLine(
      JSON.stringify(notification('u3', 'Agent "Check the build" failed: Agent stalled: no progress for 600s', 'failed', AT)),
      'claude',
    );
    expect(failed).toMatchObject({ note: 'agent-done', text: 'Check the build', outcome: 'failed' });
    const stopped = parseLine(JSON.stringify(notification('u4', 'Agent "Check the build" was stopped by user', 'stopped', AT)), 'claude');
    expect(stopped).toMatchObject({ note: 'agent-done', text: 'Check the build', outcome: 'stopped' });
  });

  it('уведомление не об агенте (фоновая команда, монитор) в ленту не идёт', () => {
    for (const summary of ['Background command "npm test" completed (exit code 0)', 'Monitor event: "build"', 'Monitor "build" stream ended']) {
      expect(parseLine(JSON.stringify(notification('u5', summary, 'completed', AT)), 'claude')).toBeNull();
    }
  });

  it('сообщение агента: отправитель и текст отчёта, без обёртки и предупреждения', () => {
    const report = 'Build is green.\n\n- 12 tests passed';
    const body = `[Subagent hand-back] The agent finished. Its report follows:\n  ${report.replace(/\n/g, '\n  ')}`;
    const e = parseLine(
      JSON.stringify(peer('u6', { name: 'general-purpose', body, handback: 'done', handbackReportText: report }, body, AT)),
      'claude',
    );
    expect(e).toEqual({ id: 'u6', at: Date.parse(AT), kind: 'note', note: 'agent-message', text: report, from: 'general-purpose' });
  });

  it('сообщение без готового отчёта и имени: текст — тело, отправитель не назван', () => {
    const e = parseLine(JSON.stringify(peer('u7', { body: 'Need a decision on the port.' }, 'Need a decision on the port.', AT)), 'claude')!;
    expect(e).toEqual({ id: 'u7', at: Date.parse(AT), kind: 'note', note: 'agent-message', text: 'Need a decision on the port.' });
    expect(e.text).not.toContain('agent-message');
    expect(e.text).not.toContain('other Claude session');
  });

  it('сообщение без полей origin: текст берётся из обёртки', () => {
    const line = peer('u8', {}, 'Plain words.', AT) as Record<string, unknown>;
    line.origin = { kind: 'peer' };
    expect(parseLine(JSON.stringify(line), 'claude')).toMatchObject({ note: 'agent-message', text: 'Plain words.' });
  });

  it('прочие служебные записи (isMeta) в ленту по-прежнему не идут', () => {
    const line = { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: local commands' }, uuid: 'u9', timestamp: AT };
    expect(parseLine(JSON.stringify(line), 'claude')).toBeNull();
  });

  it('страница: события стоят в порядке времени и не называются репликой человека', async () => {
    const f = put('events.jsonl', [
      human('h1', 'run the checks in background', at(0)),
      assistant('a1', [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'Check the build', prompt: 'p', subagent_type: 'general-purpose' } }], at(1)),
      launched('u1', 'Check the build', at(2)),
      assistant('a2', [{ type: 'text', text: 'Started.' }], at(3)),
      peer('u2', { name: 'general-purpose', body: 'Half way.' }, 'Half way.', at(60)),
      notification('u3', 'Agent "Check the build" finished', 'completed', at(120), '<usage><duration_ms>118000</duration_ms></usage>'),
      assistant('a3', [{ type: 'text', text: 'Done.' }], at(121)),
    ]);
    const p = page(await readFeed(f, 'claude'));
    expect(p.entries.map((e) => `${e.kind}:${e.note ?? ''}`)).toEqual([
      'human:',
      'tool:',
      'note:agent-start',
      'agent:',
      'note:agent-message',
      'note:agent-done',
      'agent:',
    ]);
    expect(p.entries.filter((e) => e.kind === 'human').map((e) => e.text)).toEqual(['run the checks in background']);
    expect(p.entries.map((e) => e.at)).toEqual([0, 1, 2, 3, 60, 120, 121].map((s) => Date.parse(at(s))));
    expect(p.entries[5]).toMatchObject({ text: 'Check the build', elapsed: 118 });
    expect(p.entries.every((e) => typeof e.cursor === 'string')).toBe(true);
  });
});
