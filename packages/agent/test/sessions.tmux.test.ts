import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionService } from '../src/sessions.js';

/** Доступен ли tmux в песочнице (иначе describe пропускается). */
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

describe.skipIf(!tmuxAvailable)('SessionService — реальный tmux (изолированный сокет)', () => {
  const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;
  let root: string;
  let projectDir: string;
  let svc: SessionService;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-tmux-'));
    fs.mkdirSync(path.join(root, 'projectA'));
    // Сравниваем по realpath: tmux может отдавать путь как есть или разрешив симлинки.
    projectDir = path.join(root, 'projectA');
    svc = new SessionService({ roots: [root], socketName });
  });

  afterAll(() => {
    try {
      execFileSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // сервер мог не подниматься — не ошибка
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('пустой сервер → list() = []', async () => {
    expect(await svc.list()).toEqual([]);
  });

  it('create → list видит имя/каталог, kill → пусто', async () => {
    await svc.create({ name: 'main', root, dir: 'projectA', preset: 'zsh' });

    const listed = await svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('main');
    expect(fs.realpathSync(listed[0].path)).toBe(fs.realpathSync(projectDir));
    expect(listed[0].attached).toBe(0);
    expect(listed[0].bell).toBe(false);
    expect(listed[0].activityTs).toBeGreaterThan(0);

    await svc.kill('main');
    expect(await svc.list()).toEqual([]);
  });

  it('dirs() перечисляет подкаталоги корня', async () => {
    const dirs = await svc.dirs();
    expect(dirs).toEqual([{ root, dirs: ['projectA'] }]);
  });
});
