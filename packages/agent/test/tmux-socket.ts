// Общий помощник тестов, поднимающих свой сервер tmux на отдельном сокете: гасит сервер и
// убирает файл сокета. tmux сам файл не удаляет, и каждый прогон оставлял бы по файлу
// `termhub-test-*` на тест в каталоге сокетов.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Где tmux держит сокет с этим именем (`-L`): `$TMUX_TMPDIR` или `/tmp`, каталог `tmux-<uid>`. */
export function tmuxSocketPath(socketName: string): string {
  return path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${os.userInfo().uid}`, socketName);
}

/** `kill-server` на сокете теста и удаление его файла. Сервера или файла уже нет — не ошибка.
 *  Только для сокетов тестов: имя рабочего сокета сюда не передавать. */
export function killTmuxServer(socketName: string): void {
  if (!/^termhub-(?:test|feed)-[\w-]+$/.test(socketName)) {
    throw new Error(`not a test tmux socket: ${socketName}`);
  }
  try {
    execFileSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* сервера уже нет */
  }
  fs.rmSync(tmuxSocketPath(socketName), { force: true });
}
