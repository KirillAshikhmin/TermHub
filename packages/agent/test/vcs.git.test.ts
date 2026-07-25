// VcsService — git-адаптер на настоящем временном репозитории. svn/hg не тестируем
// (не гарантированы в CI); проверяем самый ходовой бэкенд + безопасность.

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VcsService, runRepoAction } from '../src/vcs.js';

const exec = promisify(execFile);

let root = '';
let repo = '';
let svc: VcsService;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t',
};
const git = (args: string[], cwd: string): Promise<unknown> => exec('git', args, { cwd, env: GIT_ENV });

beforeAll(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'th-vcs-')));
  repo = path.join(root, 'proj');
  await fsp.mkdir(repo);
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 't@t'], repo);
  await git(['config', 'user.name', 'T'], repo);
  await fsp.writeFile(path.join(repo, 'a.txt'), 'hello\n');
  await git(['add', 'a.txt'], repo);
  await git(['commit', '-q', '-m', 'first commit'], repo);
  await fsp.writeFile(path.join(repo, 'a.txt'), 'hello\nworld\n');
  await git(['commit', '-q', '-am', 'second commit'], repo);
  svc = new VcsService({ roots: [root] });
});

afterAll(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

describe('VcsService — git', () => {
  it('detect + log: тип git, коммиты по убыванию', async () => {
    const log = await svc.log(root, 'proj');
    expect(log.vcs).toBe('git');
    expect(log.commits.length).toBe(2);
    expect(log.commits[0]!.subject).toBe('second commit');
    expect(log.commits[1]!.subject).toBe('first commit');
    expect(log.commits[0]!.rev).toMatch(/^[0-9a-f]{40}$/);
    expect(log.commits[0]!.date).toBeGreaterThan(0);
    expect(log.head).toMatch(/^[0-9a-f]{40}$/); // текущий HEAD
    expect(log.commits[0]!.rev).toBe(log.head); // HEAD = верхний коммит
  });

  it('не репозиторий → vcs=null', async () => {
    await fsp.mkdir(path.join(root, 'plain'));
    const log = await svc.log(root, 'plain');
    expect(log.vcs).toBeNull();
    expect(log.commits).toEqual([]);
  });

  it('show: сообщение + список изменённых файлов', async () => {
    const log = await svc.log(root, 'proj');
    const detail = await svc.show(root, 'proj', log.commits[0]!.rev);
    expect(detail.message).toBe('second commit');
    expect(detail.files.some((f) => f.path === 'a.txt' && f.status === 'M')).toBe(true);
  });

  it('diff внутри коммита показывает добавленную строку', async () => {
    const log = await svc.log(root, 'proj');
    const d = await svc.diff(root, 'proj', 'a.txt', log.commits[0]!.rev);
    expect(d).toContain('+world');
  });

  it('status + рабочий diff + коммит только выбранного файла', async () => {
    await fsp.writeFile(path.join(repo, 'a.txt'), 'hello\nworld\nmore\n');
    await fsp.writeFile(path.join(repo, 'b.txt'), 'new file\n');

    const st = await svc.status(root, 'proj');
    expect(st.files.find((f) => f.path === 'a.txt')?.status).toBe('M');
    expect(st.files.find((f) => f.path === 'b.txt')?.status).toBe('?');

    expect(await svc.diff(root, 'proj', 'a.txt')).toContain('+more');
    expect(await svc.diff(root, 'proj', 'b.txt')).toContain('+new file'); // новый файл

    await svc.commit(root, 'proj', ['b.txt'], 'add b');
    const st2 = await svc.status(root, 'proj');
    expect(st2.files.some((f) => f.path === 'b.txt')).toBe(false); // b закоммичен
    expect(st2.files.find((f) => f.path === 'a.txt')?.status).toBe('M'); // a ещё изменён
    expect((await svc.log(root, 'proj')).commits[0]!.subject).toBe('add b');
  });

  it('cat: содержимое рабочего файла (текст)', async () => {
    const text = await svc.cat(root, 'proj', 'a.txt');
    expect(text).toContain('hello');
  });

  it('branches: список/текущая, создание+переключение, удаление', async () => {
    let b = await svc.branches(root, 'proj');
    expect(b.vcs).toBe('git');
    expect(b.current).toBe('main');
    expect(b.branches).toContain('main');

    await svc.createBranch(root, 'proj', 'feature/x');
    b = await svc.branches(root, 'proj');
    expect(b.current).toBe('feature/x');
    expect(b.branches).toContain('feature/x');

    await svc.checkout(root, 'proj', 'main');
    expect((await svc.branches(root, 'proj')).current).toBe('main');

    await svc.deleteBranch(root, 'proj', 'feature/x');
    expect((await svc.branches(root, 'proj')).branches).not.toContain('feature/x');
  });

  it('анти-инъекция: имя ветки-опция отклоняется', async () => {
    await expect(svc.checkout(root, 'proj', '--foo')).rejects.toThrow();
  });

  it('анти-инъекция: побег за корень отклоняется', async () => {
    await expect(svc.log(root, '../..')).rejects.toThrow();
  });

  it('анти-инъекция: ревизия-опция отклоняется', async () => {
    await expect(svc.show(root, 'proj', '--output=/tmp/x')).rejects.toThrow();
  });

  it('анти-инъекция: абсолютный путь файла в diff отклоняется (побег из корней)', async () => {
    // Раньше `git diff --no-index -- /dev/null <abs>` печатал содержимое ЛЮБОГО файла ФС
    // мимо whitelist корней: checkFile отсекал только «..» и ведущий «-».
    const secret = path.join(os.tmpdir(), `termhub-secret-${process.pid}.txt`);
    fs.writeFileSync(secret, 'TOP-SECRET-KEY-MATERIAL\n');
    try {
      await expect(runRepoAction(svc, { action: 'diff', root, path: 'proj', file: secret })).rejects.toThrow();
      // И через прямой метод — тоже.
      await expect(svc.diff(root, 'proj', secret)).rejects.toThrow();
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  it('git-хардненинг: враждебный core.fsmonitor из конфига репозитория не выполняется', async () => {
    const marker = path.join(os.tmpdir(), `termhub-fsmonitor-${process.pid}.flag`);
    fs.rmSync(marker, { force: true });
    const repo = path.join(root, 'proj');
    // Конфиг репозитория просит git запускать нашу «полезную нагрузку» на каждый status.
    execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', `touch ${marker}`]);
    try {
      await svc.status(root, 'proj').catch(() => undefined);
      expect(fs.existsSync(marker)).toBe(false); // хардненинг погасил fsmonitor
    } finally {
      execFileSync('git', ['-C', repo, 'config', '--unset', 'core.fsmonitor']);
      fs.rmSync(marker, { force: true });
    }
  });
});
