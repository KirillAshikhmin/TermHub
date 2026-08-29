import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { openPathOnHost } from '../src/host-open.js';

function fakeSpawn(exit: { code: number | null; signal?: NodeJS.Signals | null } = { code: 0 }) {
  const child = new EventEmitter() as ChildProcess;
  const spawn = vi.fn(() => child) as unknown as typeof nodeSpawn;
  queueMicrotask(() => child.emit('exit', exit.code, exit.signal ?? null));
  return { child, spawn };
}

describe('openPathOnHost', () => {
  it.each([
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
  ] as const)('%s: передаёт абсолютный путь отдельным argv без shell', async (platform, command) => {
    const { spawn } = fakeSpawn();

    await openPathOnHost('/tmp/name; touch PWNED', { platform, spawn });

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(command, ['/tmp/name; touch PWNED'], {
      shell: false,
      stdio: 'ignore',
    });
  });

  it('отклоняет неподдерживаемую ОС до запуска процесса', async () => {
    const { spawn } = fakeSpawn();

    await expect(openPathOnHost('/tmp/a.txt', { platform: 'win32', spawn })).rejects.toThrow(/not supported/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('возвращает spawn error вызывающему коду', async () => {
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.fn(() => child) as unknown as typeof nodeSpawn;
    const opened = openPathOnHost('/tmp/a.txt', { platform: 'darwin', spawn });
    child.emit('error', new Error('ENOENT'));

    await expect(opened).rejects.toThrow('ENOENT');
  });

  it('отклоняет ненулевой exit code', async () => {
    const { spawn } = fakeSpawn({ code: 7 });

    await expect(openPathOnHost('/tmp/a.txt', { platform: 'linux', spawn })).rejects.toThrow('exit code 7');
  });
});
