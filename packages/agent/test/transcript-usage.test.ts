// Расход из транскрипта: подложенные файлы, ни живых агентов, ни tmux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearUsageCache, dayKey, readUsage } from '../src/transcript-usage.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-usage-'));
  clearUsageCache();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse('2026-09-14T10:00:00.000Z');
const iso = (ms: number): string => new Date(T0 + ms).toISOString();

function claudeLine(ms: number, id: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { id, usage } });
}
function codexLine(ms: number, total: Record<string, number>): string {
  return JSON.stringify({
    timestamp: iso(ms),
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total } },
  });
}

describe('readUsage', () => {
  it('Claude: одно сообщение на нескольких строках считается один раз', async () => {
    const file = path.join(dir, 'c.jsonl');
    const u = { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 7 };
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', timestamp: iso(0), message: { content: 'привет' } }),
        claudeLine(1000, 'msg_1', u),
        claudeLine(1500, 'msg_1', u),
        claudeLine(60_000, 'msg_2', { input_tokens: 1, output_tokens: 3 }),
        'битая строка "usage"',
        '',
      ].join('\n'),
    );
    const res = await readUsage(file, 'claude', T0);
    expect(res).toMatchObject({
      ok: true,
      agent: 'claude',
      total: { input: 3, cached: 100, cacheWrite: 10, output: 10, turns: 2, activeMs: 60_000 },
      started: T0,
      last: T0 + 60_000,
    });
  });

  it('пауза длиннее пяти минут — простой, а не работа; «сегодня» — локальный день', async () => {
    const file = path.join(dir, 'c.jsonl');
    const day = 24 * 3600 * 1000;
    fs.writeFileSync(
      file,
      [
        claudeLine(0, 'a', { output_tokens: 5 }),
        claudeLine(10 * 60_000, 'b', { output_tokens: 6 }), // через 10 минут — простой
        claudeLine(2 * day, 'c', { output_tokens: 9 }),
        claudeLine(2 * day + 30_000, 'd', { output_tokens: 1 }),
        '',
      ].join('\n'),
    );
    const res = await readUsage(file, 'claude', T0 + 2 * day);
    if (!res.ok) throw new Error(res.detail);
    expect(res.total.output).toBe(21);
    expect(res.total.activeMs).toBe(30_000);
    expect(res.today).toMatchObject({ output: 10, turns: 2, activeMs: 30_000 });
    expect(dayKey(T0)).not.toBe(dayKey(T0 + 2 * day));
  });

  it('Codex: расход — разность нарастающих итогов, повтор события ничего не добавляет', async () => {
    const file = path.join(dir, 'x.jsonl');
    fs.writeFileSync(
      file,
      [
        codexLine(0, { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 }),
        codexLine(1000, { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 }),
        codexLine(2000, { input_tokens: 3000, cached_input_tokens: 2500, output_tokens: 80 }),
        '',
      ].join('\n'),
    );
    const res = await readUsage(file, 'codex', T0);
    expect(res).toMatchObject({ ok: true, total: { input: 500, cached: 2500, output: 80, turns: 2 } });
  });

  it('дочитывает только хвост: недописанная строка ждёт следующего раза', async () => {
    const file = path.join(dir, 'c.jsonl');
    const half = claudeLine(2000, 'b', { output_tokens: 4 });
    fs.writeFileSync(file, `${claudeLine(0, 'a', { output_tokens: 5 })}\n${half.slice(0, 20)}`);
    expect(await readUsage(file, 'claude', T0)).toMatchObject({ total: { output: 5, turns: 1 } });
    fs.appendFileSync(file, `${half.slice(20)}\n`);
    expect(await readUsage(file, 'claude', T0)).toMatchObject({ total: { output: 9, turns: 2 } });
    // Файл заменён другим под тем же путём — счёт начинается заново.
    fs.rmSync(file);
    fs.writeFileSync(file, `${claudeLine(0, 'z', { output_tokens: 1 })}\n`);
    expect(await readUsage(file, 'claude', T0)).toMatchObject({ total: { output: 1, turns: 1 } });
  });

  it('файла нет — причина словом ленты, а не исключение', async () => {
    expect(await readUsage(path.join(dir, 'none.jsonl'), 'claude')).toMatchObject({ ok: false, reason: 'no-transcript' });
  });
});

describe('readUsage — занятость контекста (G03)', () => {
  it('Claude: занято по usage последнего ответа; служебные и боковые записи не в счёт; предела нет', async () => {
    const file = path.join(dir, 'ctx-c.jsonl');
    const line = (ms: number, id: string, model: string, usage: Record<string, number>, extra: object = {}): string =>
      JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { id, model, usage }, ...extra });
    fs.writeFileSync(
      file,
      [
        line(0, 'a', 'claude-x', { input_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 5, output_tokens: 9 }),
        line(1000, 'b', 'claude-x', { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 7 }),
        line(2000, 'c', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
        line(3000, 'd', 'claude-x', { input_tokens: 900, output_tokens: 1 }, { isSidechain: true }),
        '',
      ].join('\n'),
    );
    const res = await readUsage(file, 'claude', T0);
    if (!res.ok) throw new Error(res.detail);
    expect(res.context).toEqual({ used: 112 });
    // Прежние поля расхода на месте и считаются по-прежнему.
    expect(res.total).toMatchObject({ input: 907, cached: 150, cacheWrite: 15, output: 17, turns: 4 });
  });

  it('Claude: беседа без ответов — поля context нет', async () => {
    const file = path.join(dir, 'ctx-none.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: iso(0), message: { content: 'привет' } }) + '\n');
    const res = await readUsage(file, 'claude', T0);
    if (!res.ok) throw new Error(res.detail);
    expect(res.context).toBeUndefined();
  });

  it('Codex: занято — last_token_usage, предел — model_context_window из той же записи', async () => {
    const file = path.join(dir, 'ctx-x.jsonl');
    const count = (ms: number, info: object): string =>
      JSON.stringify({ timestamp: iso(ms), type: 'event_msg', payload: { type: 'token_count', info } });
    fs.writeFileSync(
      file,
      [
        count(0, {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
          last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          model_context_window: 258400,
        }),
        count(1000, null as never),
        count(2000, {
          total_token_usage: { input_tokens: 400, cached_input_tokens: 300, output_tokens: 30 },
          last_token_usage: { input_tokens: 300, output_tokens: 20, total_tokens: 320 },
          model_context_window: 258400,
        }),
        '',
      ].join('\n'),
    );
    const res = await readUsage(file, 'codex', T0);
    if (!res.ok) throw new Error(res.detail);
    expect(res.context).toEqual({ used: 320, limit: 258400 });
  });

  it('Codex: окна в записи нет — предел берётся из профиля по модели из turn_context', async () => {
    const file = path.join(dir, 'ctx-x2.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: iso(0), type: 'turn_context', payload: { model: 'gpt-6-astra' } }),
        JSON.stringify({
          timestamp: iso(1000),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { input_tokens: 50, output_tokens: 5 },
              last_token_usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
            },
          },
        }),
        '',
      ].join('\n'),
    );
    const res = await readUsage(file, 'codex', T0);
    if (!res.ok) throw new Error(res.detail);
    expect(res.context).toEqual({ used: 55, limit: 258400 });
  });
});
