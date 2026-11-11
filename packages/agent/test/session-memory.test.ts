// Память сессии: tmux и ps подменены — проверяется счёт по дереву процессов.
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
});
