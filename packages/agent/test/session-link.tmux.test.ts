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

describe.skipIf(!tmuxAvailable)('SessionLink — настоящий tmux -CC (изолированный сокет)', () => {
  // Свой сокет на прогон: дефолтный tmux-сервер и сессии пользователя не трогаем.
  const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;
  const MARKER = 'live-seam-marker';
  let root: string;

  function tmux(args: string[]): string {
    return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8' });
  }

  function capturePane(): string {
    return tmux(['capture-pane', '-p', '-t', 'live']);
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-link-'));
    tmux(['new-session', '-d', '-s', 'live', '-c', root]);
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
    tmux(['send-keys', '-t', 'live', `echo ${MARKER}`, 'Enter']);
    expect(await waitFor(() => capturePane().includes(MARKER), 5000)).toBe(true);

    const logs: string[] = [];
    const link = open('live', {
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
});
