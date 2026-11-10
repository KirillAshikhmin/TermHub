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
