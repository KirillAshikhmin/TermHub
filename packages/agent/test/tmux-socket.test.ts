// Шов: помощник тестов с живым tmux — после него на диске не остаётся файла сокета.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { killTmuxServer, tmuxSocketPath } from './tmux-socket.js';

function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasTmux())('killTmuxServer — сервер погашен, файла сокета нет', () => {
  it('после kill-server файл сокета удалён; повторный вызов и сокет без сервера — не ошибка', () => {
    const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;
    execFileSync('tmux', ['-L', socketName, 'new-session', '-d', '-s', 'probe', 'cat'], { stdio: 'ignore' });
    expect(fs.existsSync(tmuxSocketPath(socketName))).toBe(true);
    killTmuxServer(socketName);
    expect(fs.existsSync(tmuxSocketPath(socketName))).toBe(false);
    expect(() => execFileSync('tmux', ['-L', socketName, 'list-sessions'], { stdio: 'ignore' })).toThrow();
    killTmuxServer(socketName);
  });

  it('имя не тестового сокета отклоняется: рабочий сервер помощником не погасить', () => {
    expect(() => killTmuxServer('termhub')).toThrow(/not a test tmux socket/);
    expect(() => killTmuxServer('default')).toThrow(/not a test tmux socket/);
  });
});
