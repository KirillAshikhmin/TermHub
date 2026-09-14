// Шов: поиск активной панели на НАСТОЯЩЕМ tmux. В соседнем session-feed.test.ts панель
// подменена всегда, поэтому цель `display-message` там не проверяет никто — а именно она
// и развалилась на живых данных: tmux 3.7b не считает сессией цель без двоеточия и
// отвечает пустым форматом «:.» при коде 0, так что лента не отдавалась ни по одной
// сессии владельца.
//
// Здесь подменены только дом, определитель и файл беседы; панель называет живой tmux на
// СВОЁМ сокете (-L termhub-feed-<uniq>, kill-server в teardown). Рабочего сокета проекта
// тест не касается ничем.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionFeed, type SessionFeedSources } from '../src/session-feed.js';

/** Доступен ли tmux. Пропускать шов нельзя: без tmux панели не найти вовсе, и молча
 *  снятый шов вернул бы прогон в то же состояние, в котором находку и не заметили. */
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}
const NO_TMUX = 'tmux не найден: шов «панель живой сессии» не проверен — без tmux ленту не по чему искать';

/** Вид адреса панели из спецификации: сессия:@окно.%панель. */
const PANE_FORM = /^[^:]+:@\d+\.%\d+$/;

describe('sessionFeed — активная панель на настоящем tmux', () => {
  const socketName = `termhub-feed-${crypto.randomBytes(4).toString('hex')}`;
  const session = 'feedwork';
  const texts = ['привет', 'как дела'];
  let home: string;
  let file: string;

  function tmux(args: string[]): string {
    // stderr гасим: teardown зовёт kill-server, которого может уже не быть.
    return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** Адрес активной панели глазами самого tmux, но ДРУГОЙ командой: обход всех панелей
   *  с пометками «окно активно» и «панель активна». Считать ожидаемое тем же
   *  display-message, что и код, значило бы сверять код с самим собой. */
  function activeOf(name: string): string {
    const rows = tmux(['list-panes', '-a', '-F', '#{session_name}:#{window_id}.#{pane_id} #{window_active}#{pane_active}']);
    return (
      rows
        .split('\n')
        .filter((row) => row.endsWith(' 11'))
        .map((row) => row.slice(0, row.indexOf(' ')))
        .find((address) => address.startsWith(`${name}:`)) ?? ''
    );
  }

  /** Источники: панель ищет настоящий tmux, подменены дом и определитель. Адреса, которые
   *  лента отдала определителю, копятся в `seen` — по ним и видно, что нашлось. */
  const sources = (seen: string[]): Partial<SessionFeedSources> => ({
    home,
    socketName,
    resolve: async (pane) => {
      seen.push(pane);
      return { ok: true, agent: 'claude', files: [file], complete: true, live: true };
    },
  });

  beforeAll(() => {
    if (!tmuxAvailable) throw new Error(NO_TMUX);
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-feed-tmux-'));
    // Файл беседы Claude из реплик человека: строки собраны вручную, чужого не копируем.
    file = path.join(home, 'claude-live.jsonl');
    const lines = texts.map((text, i) =>
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: text },
        uuid: `u${i + 1}`,
        timestamp: new Date(Date.UTC(2026, 8, 14, 10, i)).toISOString(),
        cwd: home,
        sessionId: 's',
      }),
    );
    fs.writeFileSync(file, lines.join('\n') + '\n');
    tmux(['new-session', '-d', '-s', session, '-c', home]);
  });

  afterAll(() => {
    try {
      tmux(['kill-server']);
    } catch {
      // сервер мог не подниматься — не ошибка
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('tmux доступен — иначе шов проверять нечем', () => {
    expect(tmuxAvailable, NO_TMUX).toBe(true);
  });

  it('по имени живой сессии находит её панель и отдаёт страницу ленты, а не отказ', async () => {
    const seen: string[] = [];
    const r = await sessionFeed(session, {}, sources(seen));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(PANE_FORM);
    // Та самая панель, которую активной считает сам tmux, — а не просто что-то похожее.
    expect(seen[0]).toBe(activeOf(session));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.text)).toEqual(texts);
  });

  it('берёт активную панель активного окна, а не первое окно сессии', async () => {
    // У всех живых сессий владельца по одному окну, поэтому «активная» и «первая» там
    // совпадают — а контракт модуля именно «панель, куда смотрит хозяин».
    const wide = 'feedwide';
    tmux(['new-session', '-d', '-s', wide, '-c', home]);
    const first = activeOf(wide);
    tmux(['new-window', '-t', `=${wide}:`, '-c', home]);
    tmux(['split-window', '-t', `=${wide}:`, '-c', home]);
    const active = activeOf(wide);
    expect(active).not.toBe(first);

    const seen: string[] = [];
    const r = await sessionFeed(wide, {}, sources(seen));

    expect(seen).toEqual([active]);
    expect(r.ok).toBe(true);
  });

  it('имя-префикс живой сессии — отказ, а не её беседа', async () => {
    // Без `=` tmux берёт однозначный префикс: запрос ленты по имени умершей сессии
    // молча отдал бы беседу соседней, живой. Отказ должен дойти до клиента причиной,
    // а определителю не уходить вовсе — ни чужого адреса, ни пустого «:.».
    const seen: string[] = [];
    const r = await sessionFeed(session.slice(0, -1), {}, sources(seen));

    expect(seen).toEqual([]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('lookup-failed');
  });
});
