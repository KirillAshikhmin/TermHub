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

  it('dirs() перечисляет подкаталоги корня', async () => {
    const dirs = await svc.dirs();
    expect(dirs).toEqual([{ root, dirs: ['projectA'] }]);
  });
});

// Альтернативный экран выключается на сокете агента: у того буфера нет истории, и панель
// с Claude Code оставалась без прокрутки. Свой сокет (и свой kill-server) — дефолтный
// сервер владельца не трогаем ни в проверке, ни в коде.
describe.skipIf(!tmuxAvailable)('alternate-screen off — реальный tmux (изолированный сокет)', () => {
  const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;
  let root: string;

  /** Значение глобальной опции на сокете (сервер обязан быть живым). */
  function shownOption(): string {
    return execFileSync('tmux', ['-L', socketName, 'show-options', '-g', 'alternate-screen'], {
      encoding: 'utf8',
    }).trim();
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-altscreen-'));
    fs.mkdirSync(path.join(root, 'projectA'));
  });

  afterAll(() => {
    try {
      execFileSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // сервер мог не подниматься — не ошибка
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('сервера нет → старт не падает, опция приезжает с первой же сессией', async () => {
    const svc = new SessionService({ roots: [root], socketName });
    // Сервера на сокете ещё нет (tmux не держит его без сессий) — это штатно.
    await expect(svc.disableAlternateScreen()).resolves.toBeUndefined();
    expect(await svc.list()).toEqual([]);

    await svc.create({ name: 'alt', root, dir: 'projectA', preset: 'zsh' });
    expect(shownOption()).toBe('alternate-screen off');
    expect((await svc.list()).map((s) => s.name)).toEqual(['alt']);
  });

  it('сервер уже живёт → опция ставится прямо на старте агента', async () => {
    // Возвращаем дефолт и поднимаем «новый агент» на том же живом сервере.
    execFileSync('tmux', ['-L', socketName, 'set-option', '-g', 'alternate-screen', 'on']);
    expect(shownOption()).toBe('alternate-screen on');

    await new SessionService({ roots: [root], socketName }).disableAlternateScreen();
    expect(shownOption()).toBe('alternate-screen off');
  });

  it('сервер умер вместе с последней сессией → на новом опция ставится заново, а не теряется', async () => {
    const svc = new SessionService({ roots: [root], socketName });
    await svc.disableAlternateScreen(); // сервер жив (сессия alt) — опция легла
    expect(shownOption()).toBe('alternate-screen off');

    await svc.kill('alt');
    // Последняя сессия ушла — сервер умер и унёс глобальную опцию с собой; агент узнаёт
    // об этом из ответа tmux и снова считает опцию невыставленной.
    expect(await svc.list()).toEqual([]);

    await svc.create({ name: 'again', root, dir: 'projectA', preset: 'zsh' });
    // На новом сервере дефолт — «on»: «off» здесь значит, что агент поставил опцию заново.
    expect(shownOption()).toBe('alternate-screen off');
  });
});
