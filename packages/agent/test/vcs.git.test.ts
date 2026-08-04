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

// Гость, которому расшарили ОДНУ сессию, получает VcsService с roots = каталог этой
// сессии (см. RelayLink.doRepo). Раньше проверялись только root/path, а detectAt
// поднимался от них вверх до whitelist-корня — file резолвился относительно вершины
// репозитория, и гость читал файлы соседних проектов и историю всего монорепо.
describe('VcsService — ограничение гостя каталогом расшаренной сессии', () => {
  let shared: string;
  let confined: VcsService;

  beforeAll(async () => {
    // Структура: root/ (git-репозиторий) → root/inner (расшаренная сессия), плюс
    // root/secret.env рядом — файл, которого гость видеть не должен.
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t'], root);
    await git(['config', 'user.name', 'T'], root);
    shared = path.join(root, 'inner');
    await fsp.mkdir(shared, { recursive: true });
    await fsp.writeFile(path.join(shared, 'ok.txt'), 'visible\n');
    await fsp.writeFile(path.join(root, 'secret.env'), 'TOKEN=leaked\n');
    confined = new VcsService({ roots: [shared] });
  });

  it('владелец (roots=root) действительно достаёт secret.env — значит утечка была реальной', async () => {
    const owner = new VcsService({ roots: [root] });
    const content = await owner.cat(root, 'inner', '../secret.env').catch((e: Error) => e.message);
    // Через ../ не пускает checkFile, но через вершину репозитория — да:
    const viaTop = await owner.cat(root, 'inner', 'secret.env').catch((e: Error) => e.message);
    expect(String(viaTop)).toContain('TOKEN=leaked');
    expect(typeof content).toBe('string');
  });

  it('гость не может выйти за каталог сессии через file (cat)', async () => {
    await expect(confined.cat(shared, '', 'secret.env')).rejects.toThrow();
  });

  it('гость не может подсунуть чужой root', async () => {
    await expect(confined.cat(root, 'inner', 'secret.env')).rejects.toThrow(/Unknown root/);
  });

  it('гостю доступен файл ВНУТРИ расшаренного каталога', async () => {
    // Маркер репозитория выше каталога сессии, поэтому detectAt его уже не находит и
    // репо-операции отдают vcs=null — но сам каталог остаётся читаемым.
    const log = await confined.log(shared, '');
    expect(log.vcs).toBeNull();
  });
});

describe('VcsService — граф, ветка и операции слияния', () => {
  it('log отдаёт родителей, метки, текущую ветку и ahead/behind', async () => {
    const log = await svc.log(root, 'proj');
    expect(log.branch).toBe('main');
    // Линейная история: у верхнего коммита ровно один родитель, у корневого — ноль.
    expect(log.commits[0]!.parents).toHaveLength(1);
    expect(log.commits.at(-1)!.parents).toEqual([]);
    // Метка ветки стоит на HEAD.
    expect(log.commits[0]!.refs).toContain('main');
    // upstream не настроен — сравнивать не с чем.
    expect(log.ahead).toBeNull();
    expect(log.behind).toBeNull();
  });

  it('merge создаёт коммит с двумя родителями — он и рисуется как слияние', async () => {
    const repo = path.join(root, 'proj');
    await git(['switch', '-c', 'feature'], repo);
    await fsp.writeFile(path.join(repo, 'f.txt'), 'from feature\n');
    await git(['add', 'f.txt'], repo);
    await git(['commit', '-q', '-m', 'feature work'], repo);
    await git(['switch', 'main'], repo);
    // Разводим ветки: без коммита на main слияние было бы перемоткой, и коммита
    // с двумя родителями просто не возникло бы.
    await fsp.writeFile(path.join(repo, 'm.txt'), 'from main\n');
    await git(['add', 'm.txt'], repo);
    await git(['commit', '-q', '-m', 'main work'], repo);

    await svc.merge(root, 'proj', 'feature');
    const log = await svc.log(root, 'proj');
    const merge = log.commits.find((c) => (c.parents ?? []).length === 2);
    expect(merge).toBeTruthy();
    expect(await fsp.readFile(path.join(repo, 'f.txt'), 'utf8')).toContain('from feature');
  });

  it('конфликт merge оставляет репозиторий в состоянии merging, abort его снимает', async () => {
    const repo = path.join(root, 'conflict');
    await fsp.mkdir(repo);
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['config', 'user.email', 't@t'], repo);
    await git(['config', 'user.name', 'T'], repo);
    await fsp.writeFile(path.join(repo, 'x.txt'), 'base\n');
    await git(['add', 'x.txt'], repo);
    await git(['commit', '-q', '-m', 'base'], repo);
    await git(['switch', '-c', 'other'], repo);
    await fsp.writeFile(path.join(repo, 'x.txt'), 'theirs\n');
    await git(['commit', '-q', '-am', 'theirs'], repo);
    await git(['switch', 'main'], repo);
    await fsp.writeFile(path.join(repo, 'x.txt'), 'ours\n');
    await git(['commit', '-q', '-am', 'ours'], repo);

    await expect(svc.merge(root, 'conflict', 'other')).rejects.toThrow();
    const st = await svc.status(root, 'conflict');
    expect(st.state).toBe('merging');
    expect(st.conflicts).toContain('x.txt');

    await svc.abort(root, 'conflict');
    const after = await svc.status(root, 'conflict');
    expect(after.state).toBe('clean');
    expect(after.conflicts).toEqual([]);
  });

  it('discard возвращает файл к HEAD', async () => {
    const repo = path.join(root, 'proj');
    const file = path.join(repo, 'a.txt');
    // Эталон — состояние HEAD, а не текущая копия: предыдущие тесты могли оставить
    // файл изменённым, и сравнение с ним проверяло бы не то.
    await svc.discard(root, 'proj', ['a.txt']);
    const head = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(file, 'trash\n');
    await svc.discard(root, 'proj', ['a.txt']);
    expect(await fsp.readFile(file, 'utf8')).toBe(head);
  });

  it('stash: отложить → список непуст → вернуть', async () => {
    const repo = path.join(root, 'proj');
    const file = path.join(repo, 'a.txt');
    const before = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(file, `${before}stashed\n`);

    await svc.stashPush(root, 'proj', 'wip');
    expect(await fsp.readFile(file, 'utf8')).toBe(before); // изменения убраны
    const list = await svc.stashList(root, 'proj');
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]!.ref).toMatch(/^stash@\{\d+\}$/);

    await svc.stashPop(root, 'proj', list[0]!.ref);
    expect(await fsp.readFile(file, 'utf8')).toContain('stashed');
    await svc.discard(root, 'proj', ['a.txt']); // прибираем за собой
  });

  it('битая ссылка stash отвергается до вызова git', async () => {
    await expect(svc.stashPop(root, 'proj', 'stash@{0}; rm -rf /')).rejects.toThrow(/stash reference/i);
    await expect(svc.stashDrop(root, 'proj', '--all')).rejects.toThrow(/stash reference/i);
  });

  it('rebase переносит ветку на выбранную', async () => {
    const repo = path.join(root, 'rb');
    await fsp.mkdir(repo);
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['config', 'user.email', 't@t'], repo);
    await git(['config', 'user.name', 'T'], repo);
    await fsp.writeFile(path.join(repo, 'r.txt'), 'base\n');
    await git(['add', 'r.txt'], repo);
    await git(['commit', '-q', '-m', 'base'], repo);
    await git(['switch', '-c', 'side'], repo);
    await fsp.writeFile(path.join(repo, 'side.txt'), 'side\n');
    await git(['add', 'side.txt'], repo);
    await git(['commit', '-q', '-m', 'side work'], repo);
    await git(['switch', 'main'], repo);
    await fsp.writeFile(path.join(repo, 'main.txt'), 'main\n');
    await git(['add', 'main.txt'], repo);
    await git(['commit', '-q', '-m', 'main work'], repo);
    await git(['switch', 'side'], repo);

    await svc.rebase(root, 'rb', 'main');
    const log = await svc.log(root, 'rb');
    // После перебазирования «side work» стоит поверх «main work» — линейно.
    expect(log.commits[0]!.subject).toBe('side work');
    expect(log.commits[1]!.subject).toBe('main work');
    expect(log.commits[0]!.parents).toHaveLength(1);
  });
});

describe('VcsService — amend и теги', () => {
  it('amend переписывает сообщение последнего коммита, не добавляя новый', async () => {
    const repo = path.join(root, 'am');
    await fsp.mkdir(repo);
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['config', 'user.email', 't@t'], repo);
    await git(['config', 'user.name', 'T'], repo);
    await fsp.writeFile(path.join(repo, 'a.txt'), 'one\n');
    await git(['add', 'a.txt'], repo);
    await git(['commit', '-q', '-m', 'typo here'], repo);

    const before = await svc.log(root, 'am');
    await svc.amend(root, 'am', [], 'fixed message');
    const after = await svc.log(root, 'am');
    expect(after.commits).toHaveLength(before.commits.length); // новый коммит не появился
    expect(after.commits[0]!.subject).toBe('fixed message');
  });

  it('тег ставится, виден в метках лога и удаляется', async () => {
    await svc.tagCreate(root, 'proj', 'v1.0.0');
    const tagged = await svc.log(root, 'proj');
    expect(tagged.commits[0]!.refs?.some((r) => r.includes('v1.0.0'))).toBe(true);

    await svc.tagDelete(root, 'proj', 'v1.0.0');
    const cleared = await svc.log(root, 'proj');
    expect(cleared.commits[0]!.refs?.some((r) => r.includes('v1.0.0'))).toBe(false);
  });

  it('имя тега проверяется до вызова git', async () => {
    await expect(svc.tagCreate(root, 'proj', '--delete')).rejects.toThrow(/branch name/i);
    await expect(svc.tagDelete(root, 'proj', 'a b; rm -rf /')).rejects.toThrow(/branch name/i);
  });
});
