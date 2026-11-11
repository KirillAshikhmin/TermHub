// Память сессии: tmux и ps подменены — проверяется счёт по дереву процессов.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { sessionUsage } from '../src/session-feed.js';
import { parseProcessTable, sessionMemory, treeRss, type MemoryRow } from '../src/session-memory.js';

const ROWS: MemoryRow[] = [
  { pid: 1, ppid: 0, rssKb: 10 },
  { pid: 100, ppid: 1, rssKb: 1000 }, // оболочка панели
  { pid: 101, ppid: 100, rssKb: 2000 }, // агент
  { pid: 102, ppid: 101, rssKb: 500 }, // его подпроцесс
  { pid: 200, ppid: 1, rssKb: 4000 }, // чужая сессия
  { pid: 300, ppid: 1, rssKb: 300 }, // вторая панель той же сессии
];

describe('память сессии', () => {
  it('разбирает вывод ps и пропускает строки не того вида', () => {
    expect(parseProcessTable('  100     1   1000\n101 100 2000\nmusor\n\n')).toEqual([
      { pid: 100, ppid: 1, rssKb: 1000 },
      { pid: 101, ppid: 100, rssKb: 2000 },
    ]);
  });

  it('сумма по дереву от корней панелей, в байтах; чужие процессы не в счёт', () => {
    expect(treeRss(ROWS, [100])).toBe(3500 * 1024);
    expect(treeRss(ROWS, [100, 300])).toBe(3800 * 1024);
    // Корень и его же потомок как второй корень — процесс считается один раз.
    expect(treeRss(ROWS, [100, 101])).toBe(3500 * 1024);
    expect(treeRss(ROWS, [999])).toBe(0);
  });

  it('цикл в таблице обход не зацикливает', () => {
    const loop: MemoryRow[] = [
      { pid: 1, ppid: 2, rssKb: 1 },
      { pid: 2, ppid: 1, rssKb: 2 },
    ];
    expect(treeRss(loop, [1])).toBe(3 * 1024);
  });

  it('нет сессии или сбой обхода — «не посчитать», а не исключение', async () => {
    const table = async (): Promise<MemoryRow[]> => ROWS;
    expect(await sessionMemory('work', { panePids: async () => [100, 300], processTable: table })).toBe(3800 * 1024);
    expect(await sessionMemory('gone', { panePids: async () => [], processTable: table })).toBeUndefined();
    expect(
      await sessionMemory('work', {
        panePids: async () => {
          throw new Error('tmux died');
        },
        processTable: table,
      }),
    ).toBeUndefined();
  });

  it('расход несёт память и в отказе: у сессии без агента токенов нет, а память есть', async () => {
    const res = await sessionUsage('work', {
      activePane: async () => 'work:@0.%0',
      resolve: async () => ({ ok: false, reason: 'no-agent', detail: 'pane runs zsh' }),
      memory: async () => 123456,
    });
    expect(res).toEqual({ ok: false, reason: 'no-agent', detail: 'pane runs zsh', memory: 123456 });
    // Память не посчиталась — поля нет вовсе, тело отказа прежнее.
    const bare = await sessionUsage('work', {
      activePane: async () => 'work:@0.%0',
      resolve: async () => ({ ok: false, reason: 'no-agent', detail: 'pane runs zsh' }),
      memory: async () => undefined,
    });
    expect(bare).toEqual({ ok: false, reason: 'no-agent', detail: 'pane runs zsh' });
  });

  it('проверки Guardian потока Codex едут отдельным полем и в расход беседы не входят', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-reviews-'));
    const count = (total: number): string =>
      JSON.stringify({
        timestamp: '2026-11-12T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, output_tokens: 10 } } },
      }) + '\n';
    const main = path.join(dir, 'main.jsonl');
    const r1 = path.join(dir, 'r1.jsonl');
    const r2 = path.join(dir, 'r2.jsonl');
    fs.writeFileSync(main, count(1000));
    fs.writeFileSync(r1, count(200));
    fs.writeFileSync(r2, count(300));
    const sources = {
      activePane: async () => 'work:@0.%0',
      resolve: async () => ({ ok: true as const, agent: 'codex' as const, files: [main], complete: true, live: true }),
      memory: async () => undefined,
    };
    try {
      const res = await sessionUsage('work', {
        ...sources,
        codexReviews: async () => [r1, r2, path.join(dir, 'gone.jsonl')],
      });
      if (!res.ok) throw new Error(res.detail);
      expect(res.total.input).toBe(1000);
      expect(res.reviews?.count).toBe(2);
      expect(res.reviews?.total.input).toBe(500);
      expect(res.reviews?.total.output).toBe(20);
      // Проверок нет или их подсчёт сорвался — поля нет, расход сессии на месте.
      const none = await sessionUsage('work', { ...sources, codexReviews: async () => [] });
      expect(none.ok && none.reviews).toBeUndefined();
      const broken = await sessionUsage('work', {
        ...sources,
        codexReviews: async () => {
          throw new Error('db locked');
        },
      });
      expect(broken.ok && broken.total.input).toBe(1000);
      expect(broken.ok && broken.reviews).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
