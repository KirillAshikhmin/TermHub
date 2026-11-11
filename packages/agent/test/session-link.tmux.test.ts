import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from '../src/session-link.js';

// Живой шов: единственный тест, который видит НАСТОЯЩЕЕ начало потока `tmux -CC`.
// Синтетические байты в session-link.test.ts подделывают приветствие без обёртки iTerm2,
// и ровно поэтому набор пропустил дефект, из-за которого control mode не включался ни разу.

/** Доступен ли tmux (иначе describe пропускается). */
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await delay(100);
  }
  return pred();
}

describe.skipIf(!tmuxAvailable).each(['live', 'sprut.app'])('SessionLink — настоящий tmux -CC: %s (изолированный сокет)', (sessionName) => {
  // Свой сокет на прогон: дефолтный tmux-сервер и сессии пользователя не трогаем.
  const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;
  const MARKER = 'live-seam-marker';
  let root: string;

  function tmux(args: string[]): string {
    return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8' });
  }

  function capturePane(): string {
    return tmux(['capture-pane', '-p', '-t', `=${sessionName}:`]);
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-link-'));
    tmux(['new-session', '-d', '-s', sessionName, '-c', root]);
  });

  afterAll(() => {
    try {
      tmux(['kill-server']);
    } catch {
      // сервер мог уже не работать
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('подключение идёт control mode, и снимок экрана непустой', async () => {
    // Метку печатает сама сессия — снимок обязан её увидеть.
    tmux(['send-keys', '-t', `=${sessionName}:`, `echo ${MARKER}`, 'Enter']);
    expect(await waitFor(() => capturePane().includes(MARKER), 5000)).toBe(true);

    const logs: string[] = [];
    const link = open(sessionName, {
      socketName,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      log: (message) => logs.push(message),
    });
    try {
      const mode = await link.ready;
      // Откат означает, что начало потока снова не опознано: причина будет в логе.
      expect(mode, `выбран режим ${mode}; лог: ${logs.join(' | ')}`).toBe('control');

      const snapshot = await link.snapshot(50);
      expect(snapshot.length).toBeGreaterThan(0);
      expect(new TextDecoder().decode(snapshot)).toContain(MARKER);
    } finally {
      link.dispose();
    }
  }, 30000);

  it('снимок возвращает курсор и режимы панели: приложение их включило до подключения', async () => {
    // Приложение ставит курсор в (6, 1), включает клавиши курсора и ждёт.
    tmux(['send-keys', '-t', `=${sessionName}:`, "clear; printf '\\033[?1h\\033[2;7H'; sleep 30", 'Enter']);
    const cursor = (): string => tmux(['display-message', '-p', '-t', `=${sessionName}:`, '#{cursor_x},#{cursor_y},#{keypad_cursor_flag}']).trim();
    expect(await waitFor(() => cursor() === '6,1,1', 5000), `курсор панели: ${cursor()}`).toBe(true);

    const sizes: string[] = [];
    const link = open(sessionName, {
      socketName,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      onPaneSize: (cols, rows) => sizes.push(`${cols}x${rows}`),
      log: () => {},
    });
    try {
      expect(await link.ready).toBe('control');
      const text = new TextDecoder().decode(await link.snapshot(50));
      const rows = Number(tmux(['display-message', '-p', '-t', `=${sessionName}:`, '#{pane_height}']).trim());
      // Курсор — относительно конца снимка: вверх до строки 1, вправо на 6 столбцов.
      expect(text).toContain(`\x1b[0m\r\x1b[${rows - 2}A\x1b[6C`);
      expect(text).toContain('\x1b[?1h');
      expect(sizes.at(-1)).toBe(`80x${rows}`);
    } finally {
      link.dispose();
    }
  }, 30000);

  it('размер забирает клиент, который попросил последним, и его экран пересобирается', async () => {
    const paneSize = (): string => tmux(['display-message', '-p', '-t', `=${sessionName}:`, '#{pane_width}x#{pane_height}']).trim();
    const dataA: string[] = [];
    const dec = new TextDecoder();
    const open1 = (cols: number, rows: number, onData: (b: Uint8Array) => void = () => {}) =>
      open(sessionName, { socketName, cols, rows, onData, onExit: () => {}, log: () => {} });
    const a = open1(100, 30, (b) => dataA.push(dec.decode(b)));
    let b: ReturnType<typeof open1> | undefined;
    try {
      expect(await a.ready).toBe('control');
      expect(await waitFor(() => paneSize() === '100x30', 15000), `панель: ${paneSize()}`).toBe(true);
      // Второй клиент подключился позже — tmux отдаёт размер ему.
      b = open1(60, 20);
      expect(await b.ready).toBe('control');
      expect(await waitFor(() => paneSize() === '60x20', 15000), `панель: ${paneSize()}`).toBe(true);
      // Человек вернулся к первому: без перехвата его просьбу tmux не слушает вовсе.
      dataA.length = 0;
      a.resize(100, 30);
      expect(await waitFor(() => paneSize() === '100x30', 15000), `панель: ${paneSize()}`).toBe(true);
      // Его экран после смены размера нарисован заново: стирание и картинка панели.
      expect(await waitFor(() => dataA.join('').includes('\x1b[H\x1b[2J'), 15000)).toBe(true);
    } finally {
      a.dispose();
      b?.dispose();
    }
  }, 90000);
});
