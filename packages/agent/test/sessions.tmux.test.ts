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

  it('трижды create с autoName → main, main1, main2; повтор без autoName → ошибка', async () => {
    const req = { name: 'main', root, dir: 'projectA', preset: 'zsh' as const };
    expect(await svc.create({ ...req, autoName: true })).toEqual({ name: 'main' });
    expect(await svc.create({ ...req, autoName: true })).toEqual({ name: 'main1' });
    expect(await svc.create({ ...req, autoName: true })).toEqual({ name: 'main2' });
    // Живой отказ tmux на дубле — та самая форма ошибки, которую распознаёт агент: exit 1
    // и «duplicate session» в stderr (а не просто любое исключение с этими словами).
    await expect(svc.create(req)).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/duplicate session/) });
    const names = execFileSync('tmux', ['-L', socketName, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(names).toEqual(['main', 'main1', 'main2']);
  });

  it('kill dotted session removes only the exact name and preserves neighbours', async () => {
    for (const name of ['sprut', 'sprut.app', 'sprut.app1', 'sprut.app10']) {
      execFileSync('tmux', ['-L', socketName, 'new-session', '-d', '-s', name]);
    }
    await svc.kill('sprut.app1');
    const remaining = (await svc.list()).map((session) => session.name);
    expect(remaining).not.toContain('sprut.app1');
    for (const name of ['sprut', 'sprut.app', 'sprut.app10']) expect(remaining).toContain(name);
    await expect(svc.kill('sprut.app1')).rejects.toThrow();
    expect((await svc.list()).map((session) => session.name)).toEqual(remaining);
  });

  it.each([';', 'foo;', 'foo;;', 'foo; kill-server', '_gradle_user', 'with space', 'проект 🚀', 'x'.repeat(80), '.', '..', 'a:b', 'a/b', 'a%20b', '[ab]*?', '#hash', '=equal', '$1', '@1', '-flag'])('literal rename/kill preserves neighbours: %s', async (name) => {
    const before = (await svc.list()).map((s) => s.name);
    execFileSync('tmux', ['-L', socketName, 'new-session', '-d', '-s', name.replaceAll('#', '##').replace(/;$/, '\\;')]);
    expect((await svc.list()).map((s) => s.name)).toContain(name);
    const renamed = name + '.renamed#h;';
    await svc.rename(name, renamed);
    expect((await svc.list()).map((s) => s.name)).toContain(renamed);
    await svc.kill(renamed);
    await expect(svc.kill(name)).rejects.toThrow();
    expect((await svc.list()).map((s) => s.name)).toEqual(before);
  });

  it('existing backslashes can be addressed by their actual tmux label', async () => {
    const before = (await svc.list()).map((s) => s.name);
    execFileSync('tmux', ['-L', socketName, 'new-session', '-d', '-s', 'back\\slash']);
    const name = (await svc.list()).find((s) => !before.includes(s.name))!.name;
    await svc.kill(name);
    expect((await svc.list()).map((s) => s.name)).toEqual(before);
  });

  it('dirs() перечисляет подкаталоги корня', async () => {
    const dirs = await svc.dirs();
    expect(dirs).toEqual([{ root, dirs: ['projectA'] }]);
  });
});
