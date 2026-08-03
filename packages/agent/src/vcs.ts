// VCS-браузер: лог коммитов, детали коммита с диффами и создание коммита для
// git / svn / mercurial в пределах корней сессий. Безопасность — как в files.ts:
// realpath-проверка (путь внутри корня) + все команды через execFile БЕЗ shell
// (анти-RCE), пути передаём после `--`, ревизии валидируем. Репозиторий ищем по
// маркеру (.git/.hg/.svn) вверх от выбранной папки, но не выше корня-whitelist.

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  RepoBranches,
  RepoCommitDetail,
  RepoCommitRef,
  RepoFileChange,
  RepoLog,
  RepoStatus,
  VcsKind,
} from '@termhub/protocol';

const exec = promisify(execFile);

const LOG_LIMIT = 200; // сколько последних коммитов отдаём в логе
const MAX_BUF = 16 * 1024 * 1024; // потолок вывода одной команды (большие диффы)

/** Флаги, гасящие исполнение кода из конфига ПРОСМАТРИВАЕМОГО репозитория. Идут перед
 *  подкомандой (`git -c … status`) и имеют приоритет над `.git/config`, поэтому чужой
 *  репозиторий не может подсунуть свою команду:
 *   • core.fsmonitor  — иначе git запускает указанный в конфиге бинарь на каждый status;
 *   • core.hooksPath  — уводит хуки в никуда (никакие pre/post-хуки не выполняются);
 *   • protocol.ext.allow — запрещает remote-транспорт `ext::<команда>` при fetch/log;
 *   • core.pager/editor — никакого интерактива и запуска внешних программ. */
const GIT_HARDENING = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'core.pager=cat',
  '-c',
  'core.editor=true',
];
const US = '\x1f'; // разделитель полей в шаблонах вывода (unit separator)

/** Разобранный VCS-контекст: тип и корень рабочей копии (cwd для команд). */
interface VcsCtx {
  vcs: VcsKind;
  top: string;
}

/** Существует ли путь (файл/каталог/симлинк). */
async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Распаковка XML-сущностей (для svn --xml). */
function unxml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Ревизия из нашего же лога — но валидируем защитно: без ведущего «-» и мусора. */
function checkRev(rev: string): void {
  if (!rev || rev.startsWith('-') || !/^[\w./~^@:+-]{1,120}$/.test(rev)) {
    throw new Error('Invalid revision');
  }
}

/** Имя ветки: без ведущего «-» (анти-опция), допустимый набор (в т.ч. «/» для feature/*). */
function checkBranch(name: string): void {
  if (!name || name.startsWith('-') || !/^[\w./-]{1,200}$/.test(name)) {
    throw new Error('Invalid branch name');
  }
}

/** Путь файла для pathspec: относительный, без побега и ведущего «-» (мы всё
 *  равно ставим `--`, но проверим). */
function checkFile(file: string): void {
  if (!file || file.startsWith('-') || file.includes('\0') || file.split('/').includes('..')) {
    throw new Error('Invalid file path');
  }
  // Абсолютный путь = побег из корней: `git diff --no-index -- /dev/null <abs>` работает
  // вне репозитория и напечатал бы содержимое ЛЮБОГО файла ФС (~/.termhub/identity.json,
  // ~/.ssh/id_rsa) мимо whitelist корней. Pathspec обязан быть относительным.
  if (path.isAbsolute(file)) throw new Error('Invalid file path');
}

/** Требует, чтобы `file` (относительный) после резолва симлинков лежал внутри `top`.
 *  Нужен там, где git согласен работать вне репозитория (`--no-index`). */
async function assertInsideRepo(top: string, file: string): Promise<void> {
  const realTop = await fsp.realpath(top);
  const abs = path.resolve(realTop, file);
  const real = await fsp.realpath(abs).catch(() => abs);
  if (real !== realTop && !real.startsWith(realTop + path.sep)) throw new Error('File outside repository');
}

/** Статус git-porcelain XY → односимвольный код для UI. */
function gitStatusCode(xy: string): string {
  const x = xy[0] ?? ' ';
  const y = xy[1] ?? ' ';
  if (x === '?' || y === '?') return '?';
  const c = x !== ' ' && x !== '?' ? x : y; // приоритет индексу, иначе рабочему дереву
  return c === ' ' ? 'M' : c;
}

export class VcsService {
  private readonly roots: string[];

  constructor(opts: { roots: string[] }) {
    this.roots = opts.roots;
  }

  /** Резолв (root, subpath) в реальный путь внутри корня (+ сам realRoot). */
  private async resolve(root: string, subpath: string): Promise<{ dir: string; realRoot: string }> {
    if (!this.roots.includes(root)) throw new Error('Unknown root');
    const realRoot = await fsp.realpath(root);
    const dir = await fsp.realpath(path.resolve(realRoot, subpath));
    if (dir !== realRoot && !dir.startsWith(realRoot + path.sep)) {
      throw new Error('Path outside root');
    }
    return { dir, realRoot };
  }

  /** Ищем маркер репозитория вверх от dir, но не выше realRoot. */
  private async detectAt(dir: string, realRoot: string): Promise<VcsCtx | null> {
    let cur = dir;
    for (;;) {
      if (await exists(path.join(cur, '.git'))) return { vcs: 'git', top: cur };
      if (await exists(path.join(cur, '.hg'))) return { vcs: 'hg', top: cur };
      if (await exists(path.join(cur, '.svn'))) return { vcs: 'svn', top: cur };
      if (cur === realRoot) break; // не выходим за пределы whitelist-корня
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  }

  private async ctx(root: string, subpath: string): Promise<VcsCtx | null> {
    const { dir, realRoot } = await this.resolve(root, subpath);
    return this.detectAt(dir, realRoot);
  }

  /** Запуск VCS-CLI в каталоге top без shell; stdout строкой. */
  private async run(top: string, cmd: string, args: string[]): Promise<string> {
    // Просмотр ЧУЖОГО репозитория не должен выполнять его код: конфиг репозитория может
    // задать fsmonitor/хуки/ext-транспорт, и обычная `git status` запустила бы команду
    // из `.git/config`. Гасим все такие рычаги флагами `-c` (они старше конфига репо).
    const full = cmd === 'git' ? [...GIT_HARDENING, ...args] : args;
    const { stdout } = await exec(cmd, full, {
      cwd: top,
      maxBuffer: MAX_BUF,
      windowsHide: true,
      // Никакого интерактива: не спрашивать пароль/редактор, не звать pager.
      // launchd даёт скудный PATH (/usr/bin:/bin:…) — git там есть, а svn/hg из
      // Homebrew нет; дополняем типовыми путями, иначе detect молча вернёт пусто.
      env: {
        ...process.env,
        PATH: `${process.env.PATH ?? ''}:/usr/local/bin:/opt/homebrew/bin`,
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        HGPLAIN: '1',
      },
    });
    return stdout;
  }

  /** Как run, но при ненулевом коде возвращает частичный stdout (для diff). */
  private async runAllowFail(top: string, cmd: string, args: string[]): Promise<string> {
    try {
      return await this.run(top, cmd, args);
    } catch (e) {
      const err = e as { stdout?: string };
      if (typeof err.stdout === 'string') return err.stdout;
      throw e;
    }
  }

  // ── Публичные операции ────────────────────────────────────────────────

  /** Тип VCS + текущая ревизия (HEAD) + последние коммиты (vcs=null — не репозиторий).
   *  fetch=true — сперва стянуть список коммитов с сервера (git fetch / hg pull;
   *  svn лог и так серверный). */
  async log(root: string, subpath: string, fetch = false): Promise<RepoLog> {
    const ctx = await this.ctx(root, subpath);
    if (!ctx) return { vcs: null, head: '', commits: [] };
    try {
      if (fetch) await this.fetchRemote(ctx);
      const [commits, head] =
        ctx.vcs === 'git'
          ? await Promise.all([this.gitLog(ctx.top), this.gitHead(ctx.top)])
          : ctx.vcs === 'hg'
            ? await Promise.all([this.hgLog(ctx.top), this.hgHead(ctx.top)])
            : await Promise.all([this.svnLog(ctx.top), this.svnHead(ctx.top)]);
      if (ctx.vcs !== 'git') return { vcs: ctx.vcs, head, commits };
      // Лог идёт по всем веткам, поэтому без явной отметки непонятно, где ты стоишь;
      // ahead/behind отвечают на вопрос «надо ли пушить или тянуть».
      const [branch, tracking] = await Promise.all([this.gitCurrentBranch(ctx.top), this.gitAheadBehind(ctx.top)]);
      return { vcs: ctx.vcs, head, commits, branch, ahead: tracking.ahead, behind: tracking.behind };
    } catch {
      // Репозиторий есть, но лога нет (пустой репо / нет доступа к серверу svn).
      return { vcs: ctx.vcs, head: '', commits: [] };
    }
  }

  /** Стянуть данные с сервера (для «Обновить»): git fetch / hg pull; svn не нужен. */
  private async fetchRemote(ctx: VcsCtx): Promise<void> {
    if (ctx.vcs === 'git') await this.runAllowFail(ctx.top, 'git', ['fetch', '--all', '--quiet']);
    else if (ctx.vcs === 'hg') await this.runAllowFail(ctx.top, 'hg', ['pull']);
  }

  /** Стянуть изменения из удалённого репозитория в рабочую копию (pull ↓). */
  async pull(root: string, subpath: string): Promise<void> {
    const ctx = await this.ctx(root, subpath);
    if (!ctx) throw new Error('Not a repository');
    try {
      if (ctx.vcs === 'git') await this.run(ctx.top, 'git', ['pull', '--ff-only']);
      else if (ctx.vcs === 'hg') await this.run(ctx.top, 'hg', ['pull', '-u']);
      else await this.run(ctx.top, 'svn', ['update', '--accept', 'postpone']);
    } catch (e) {
      throw cleanErr(e);
    }
  }

  /** Отправить локальные коммиты в удалённый репозиторий (push ↑). */
  async push(root: string, subpath: string): Promise<void> {
    const ctx = await this.ctx(root, subpath);
    if (!ctx) throw new Error('Not a repository');
    if (ctx.vcs === 'svn') throw new Error('SVN: commit goes to the server immediately — push not needed');
    try {
      await this.run(ctx.top, ctx.vcs === 'git' ? 'git' : 'hg', ['push']);
    } catch (e) {
      throw cleanErr(e);
    }
  }

  /** Ветки: текущая + список. */
  async branches(root: string, subpath: string): Promise<RepoBranches> {
    const ctx = await this.ctx(root, subpath);
    if (!ctx) return { vcs: null, current: '', branches: [] };
    try {
      const data =
        ctx.vcs === 'git'
          ? await this.gitBranches(ctx.top)
          : ctx.vcs === 'hg'
            ? await this.hgBranches(ctx.top)
            : await this.svnBranches(ctx.top);
      return { vcs: ctx.vcs, ...data };
    } catch {
      return { vcs: ctx.vcs, current: '', branches: [] };
    }
  }

  /** Переключиться на ветку. */
  async checkout(root: string, subpath: string, branch: string): Promise<void> {
    checkBranch(branch);
    const ctx = await this.ctx(root, subpath);
    if (!ctx) throw new Error('Not a repository');
    try {
      if (ctx.vcs === 'git') await this.run(ctx.top, 'git', ['switch', branch]);
      else if (ctx.vcs === 'hg') await this.run(ctx.top, 'hg', ['update', branch]);
      else await this.run(ctx.top, 'svn', ['switch', `^/${branch}`]);
    } catch (e) {
      throw cleanErr(e);
    }
  }

  /** Создать и переключиться на новую ветку (git/hg). */
  async createBranch(root: string, subpath: string, name: string): Promise<void> {
    checkBranch(name);
    const ctx = await this.ctx(root, subpath);
    if (!ctx) throw new Error('Not a repository');
    if (ctx.vcs === 'svn') throw new Error('SVN: branches are created by copying on the server');
    try {
      if (ctx.vcs === 'git') await this.run(ctx.top, 'git', ['switch', '-c', name]);
      else await this.run(ctx.top, 'hg', ['branch', name]);
    } catch (e) {
      throw cleanErr(e);
    }
  }

  /** Удалить ветку (git). */
  async deleteBranch(root: string, subpath: string, name: string): Promise<void> {
    checkBranch(name);
    const ctx = await this.ctx(root, subpath);
    if (!ctx) throw new Error('Not a repository');
    if (ctx.vcs !== 'git') throw new Error('Branch deletion is only supported for git');
    try {
      await this.run(ctx.top, 'git', ['branch', '-d', name]);
    } catch (e) {
      throw cleanErr(e);
    }
  }

  /** Детали коммита: метаданные, полное сообщение, список изменённых файлов. */
  async show(root: string, subpath: string, rev: string): Promise<RepoCommitDetail> {
    checkRev(rev);
    const ctx = await this.ctx(root, subpath);
    if (!ctx) throw new Error('Not a repository');
    return ctx.vcs === 'git'
      ? this.gitShow(ctx.top, rev)
      : ctx.vcs === 'hg'
        ? this.hgShow(ctx.top, rev)
        : this.svnShow(ctx.top, rev);
  }

  /** Рабочие изменения (для диалога коммита). */
  async status(root: string, subpath: string): Promise<RepoStatus> {
    const ctx = await this.ctx(root, subpath);
    if (!ctx) return { vcs: null, files: [] };
    const files =
      ctx.vcs === 'git'
        ? await this.gitStatus(ctx.top)
        : ctx.vcs === 'hg'
          ? await this.hgStatus(ctx.top)
          : await this.svnStatus(ctx.top);
    return { vcs: ctx.vcs, files };
  }

  /** Дифф файла: рабочий (rev пуст) или внутри коммита rev. */
  async diff(root: string, subpath: string, file: string, rev?: string): Promise<string> {
    checkFile(file);
    if (rev) checkRev(rev);
    const ctx = await this.ctx(root, subpath);
    if (!ctx) throw new Error('Not a repository');
    if (ctx.vcs === 'git') return this.gitDiff(ctx.top, file, rev);
    if (ctx.vcs === 'hg') return this.hgDiff(ctx.top, file, rev);
    return this.svnDiff(ctx.top, file, rev);
  }

  /** Закоммитить выбранные файлы с сообщением. */
  async commit(root: string, subpath: string, files: string[], message: string): Promise<void> {
    if (!files.length) throw new Error('No files selected');
    if (!message.trim()) throw new Error('Empty commit message');
    for (const f of files) checkFile(f);
    const ctx = await this.ctx(root, subpath);
    if (!ctx) throw new Error('Not a repository');
    if (ctx.vcs === 'git') return this.gitCommit(ctx.top, files, message);
    if (ctx.vcs === 'hg') return this.hgCommit(ctx.top, files, message);
    return this.svnCommit(ctx.top, files, message);
  }

  /** Содержимое рабочего файла для просмотра в диалоге коммита (текст; бинарь/крупный — ошибка). */
  async cat(root: string, subpath: string, file: string): Promise<string> {
    checkFile(file);
    const ctx = await this.ctx(root, subpath);
    if (!ctx) throw new Error('Not a repository');
    const realTop = await fsp.realpath(ctx.top);
    const abs = path.resolve(realTop, file);
    const real = await fsp.realpath(abs).catch(() => abs);
    if (real !== realTop && !real.startsWith(realTop + path.sep)) throw new Error('File outside repository');
    const stat = await fsp.stat(real);
    if (!stat.isFile()) throw new Error('Not a file');
    if (stat.size > 2 * 1024 * 1024) throw new Error('File too large to view');
    const buf = await fsp.readFile(real);
    for (let i = 0; i < Math.min(buf.length, 8192); i += 1) if (buf[i] === 0) throw new Error('Binary file');
    return buf.toString('utf8');
  }

  // ── git ───────────────────────────────────────────────────────────────

  private async gitLog(top: string): Promise<RepoCommitRef[]> {
    const out = await this.run(top, 'git', [
      'log',
      '--all', // все ветки, включая remote-tracking (после fetch) — виден внешний репо
      // Топологический порядок обязателен для графа: по умолчанию git сортирует по
      // дате, и коммиты параллельных веток чередуются — линии выходят спутанными.
      '--topo-order',
      '-n',
      String(LOG_LIMIT),
      `--pretty=format:%H${US}%h${US}%an${US}%at${US}%P${US}%D${US}%s`,
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        // %s идёт последним: тема может содержать что угодно, кроме перевода строки,
        // поэтому режем на фиксированное число полей и остаток отдаём теме.
        const parts = line.split(US);
        const [rev, short, author, at, parents, decor] = parts;
        return {
          rev: rev!,
          short: short ?? rev!,
          author: author ?? '',
          date: Number(at) * 1000,
          parents: (parents ?? '').split(' ').filter(Boolean),
          refs: parseDecoration(decor ?? ''),
          subject: parts.slice(6).join(US),
        };
      });
  }

  /** Имя текущей ветки; пусто в detached HEAD (git печатает «HEAD»). */
  private async gitCurrentBranch(top: string): Promise<string> {
    const name = (await this.runAllowFail(top, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name === 'HEAD' ? '' : name;
  }

  /** Насколько текущая ветка впереди/позади своего upstream. null — upstream не задан
   *  (или его не удалось прочитать), и тогда сравнивать попросту не с чем. */
  private async gitAheadBehind(top: string): Promise<{ ahead: number | null; behind: number | null }> {
    const out = (await this.runAllowFail(top, 'git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).trim();
    const [behind, ahead] = out.split(/\s+/).map(Number);
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return { ahead: null, behind: null };
    return { ahead: ahead!, behind: behind! };
  }

  private async gitHead(top: string): Promise<string> {
    return (await this.runAllowFail(top, 'git', ['rev-parse', 'HEAD'])).trim();
  }

  private async gitBranches(top: string): Promise<{ current: string; branches: string[] }> {
    const current = (await this.runAllowFail(top, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const out = await this.run(top, 'git', ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
    const set = new Set<string>();
    for (const line of out.split('\n')) {
      const ref = line.trim();
      if (ref.startsWith('refs/heads/')) set.add(ref.slice(11));
      else if (ref.startsWith('refs/remotes/')) {
        const name = ref.slice(13).slice(ref.slice(13).indexOf('/') + 1); // origin/foo → foo
        if (name && name !== 'HEAD') set.add(name);
      }
    }
    if (current && current !== 'HEAD') set.add(current);
    return { current, branches: [...set].sort() };
  }

  private async gitShow(top: string, rev: string): Promise<RepoCommitDetail> {
    const meta = await this.run(top, 'git', ['show', '-s', `--format=%H${US}%h${US}%an${US}%at${US}%B`, rev]);
    const parts = meta.split(US);
    const files = await this.run(top, 'git', ['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', rev]);
    return {
      rev: parts[0] ?? rev,
      short: parts[1] ?? rev,
      author: parts[2] ?? '',
      date: Number(parts[3]) * 1000,
      message: parts.slice(4).join(US).trim(),
      files: parseNameStatus(files),
    };
  }

  private async gitStatus(top: string): Promise<RepoFileChange[]> {
    const out = await this.run(top, 'git', ['status', '--porcelain=v1', '--untracked-files=all']);
    const result: RepoFileChange[] = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const xy = line.slice(0, 2);
      let file = line.slice(3);
      const arrow = file.indexOf(' -> '); // переименование: old -> new
      if (arrow >= 0) file = file.slice(arrow + 4);
      result.push({ path: file, status: gitStatusCode(xy) });
    }
    return result;
  }

  private async gitDiff(top: string, file: string, rev?: string): Promise<string> {
    if (rev) {
      return this.runAllowFail(top, 'git', ['show', '--no-color', '--format=', rev, '--', file]);
    }
    const tracked = await this.runAllowFail(top, 'git', ['diff', '--no-color', 'HEAD', '--', file]);
    if (tracked.trim()) return tracked;
    // Пусто → возможно, файл новый (untracked): показываем как полное добавление.
    // `--no-index` работает и ВНЕ репозитория, поэтому путь обязан быть внутри `top`
    // (checkFile уже отверг абсолютные и «..», здесь — защита от симлинка наружу).
    await assertInsideRepo(top, file);
    return this.runAllowFail(top, 'git', ['diff', '--no-color', '--no-index', '--', '/dev/null', file]);
  }

  private async gitCommit(top: string, files: string[], message: string): Promise<void> {
    await this.run(top, 'git', ['add', '-A', '--', ...files]); // стейджим adds/mods/dels выбранных
    await this.run(top, 'git', ['commit', '-m', message, '--', ...files]); // коммитим только их
  }

  // ── mercurial ──────────────────────────────────────────────────────────

  private async hgLog(top: string): Promise<RepoCommitRef[]> {
    const tpl = `{node}${US}{node|short}${US}{author}${US}{date|hgdate}${US}{desc|firstline}\n`;
    const out = await this.run(top, 'hg', ['log', '-l', String(LOG_LIMIT), '--template', tpl]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [rev, short, author, hgdate, subject] = line.split(US);
        return { rev: rev!, short: short ?? rev!, author: author ?? '', date: Number((hgdate ?? '').split(' ')[0]) * 1000, subject: subject ?? '' };
      });
  }

  private async hgHead(top: string): Promise<string> {
    return (await this.runAllowFail(top, 'hg', ['log', '-r', '.', '--template', '{node}'])).trim();
  }

  private async hgBranches(top: string): Promise<{ current: string; branches: string[] }> {
    const current = (await this.runAllowFail(top, 'hg', ['branch'])).trim();
    const out = await this.run(top, 'hg', ['branches', '--template', '{branch}\n']);
    return { current, branches: out.split('\n').map((s) => s.trim()).filter(Boolean) };
  }

  private async hgShow(top: string, rev: string): Promise<RepoCommitDetail> {
    const tpl = `{node}${US}{node|short}${US}{author}${US}{date|hgdate}${US}{desc}`;
    const meta = await this.run(top, 'hg', ['log', '-r', rev, '--template', tpl]);
    const parts = meta.split(US);
    const files = await this.run(top, 'hg', ['status', '--change', rev]);
    return {
      rev: parts[0] ?? rev,
      short: parts[1] ?? rev,
      author: parts[2] ?? '',
      date: Number((parts[3] ?? '').split(' ')[0]) * 1000,
      message: (parts[4] ?? '').trim(),
      files: parseStatusLines(files),
    };
  }

  private async hgStatus(top: string): Promise<RepoFileChange[]> {
    return parseStatusLines(await this.run(top, 'hg', ['status']));
  }

  private async hgDiff(top: string, file: string, rev?: string): Promise<string> {
    const args = ['diff'];
    if (rev) args.push('-c', rev);
    args.push('--', file);
    return this.runAllowFail(top, 'hg', args);
  }

  private async hgCommit(top: string, files: string[], message: string): Promise<void> {
    // Новые файлы нужно addremove; для уже отслеживаемых hg add — безвредный no-op.
    await this.runAllowFail(top, 'hg', ['add', '--', ...files]);
    await this.run(top, 'hg', ['commit', '-m', message, '--', ...files]);
  }

  // ── svn ─────────────────────────────────────────────────────────────────

  private async svnLog(top: string): Promise<RepoCommitRef[]> {
    const out = await this.run(top, 'svn', ['log', '--xml', '-l', String(LOG_LIMIT)]);
    const entries = [...out.matchAll(/<logentry[^>]*revision="(\d+)"[^>]*>([\s\S]*?)<\/logentry>/g)];
    return entries.map(([, rev, body]) => {
      const author = unxml(/<author>([\s\S]*?)<\/author>/.exec(body ?? '')?.[1] ?? '');
      const date = /<date>([\s\S]*?)<\/date>/.exec(body ?? '')?.[1] ?? '';
      const msg = unxml(/<msg>([\s\S]*?)<\/msg>/.exec(body ?? '')?.[1] ?? '');
      return { rev: rev!, short: `r${rev}`, author, date: Date.parse(date) || 0, subject: msg.split('\n')[0] ?? '' };
    });
  }

  private async svnHead(top: string): Promise<string> {
    return (await this.runAllowFail(top, 'svn', ['info', '--show-item', 'revision'])).trim();
  }

  /** База рабочей копии в репозитории (relative-url): ^/ → '', ^/trunk → /trunk. */
  private async svnBase(top: string): Promise<string> {
    const rel = (await this.runAllowFail(top, 'svn', ['info', '--show-item', 'relative-url'])).trim();
    return rel.replace(/^\^/, '').replace(/\/$/, '');
  }

  /** svn best-effort: текущая ветка = relative-url; список — trunk + ^/branches/*. */
  private async svnBranches(top: string): Promise<{ current: string; branches: string[] }> {
    const current = (await this.runAllowFail(top, 'svn', ['info', '--show-item', 'relative-url']))
      .trim()
      .replace(/^\^\/?/, '');
    const branches: string[] = ['trunk'];
    try {
      const out = await this.run(top, 'svn', ['ls', '^/branches']);
      for (const b of out.split('\n').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)) {
        branches.push(`branches/${b}`);
      }
    } catch {
      // нет layout ^/branches — только trunk (или ничего полезного)
    }
    return { current: current || 'trunk', branches };
  }

  private async svnShow(top: string, rev: string): Promise<RepoCommitDetail> {
    const out = await this.run(top, 'svn', ['log', '-r', rev, '-v', '--xml']);
    const body = /<logentry[\s\S]*?<\/logentry>/.exec(out)?.[0] ?? '';
    const author = unxml(/<author>([\s\S]*?)<\/author>/.exec(body)?.[1] ?? '');
    const date = /<date>([\s\S]*?)<\/date>/.exec(body)?.[1] ?? '';
    const msg = unxml(/<msg>([\s\S]*?)<\/msg>/.exec(body)?.[1] ?? '');
    // Пути в логе репо-относительные (лид. «/», возможно с базой ветки) — приводим к
    // wc-относительным, иначе svn diff -c их не находит («Нет изменений» на всё).
    const base = await this.svnBase(top);
    const files: RepoFileChange[] = [
      ...body.matchAll(/<path[^>]*action="([A-Z])"[^>]*>([\s\S]*?)<\/path>/g),
    ].map(([, action, p]) => ({
      path: svnToWc(unxml((p ?? '').trim()), base),
      status: action === 'A' ? 'A' : action === 'D' ? 'D' : 'M',
    }));
    return { rev, short: `r${rev}`, author, date: Date.parse(date) || 0, message: msg, files };
  }

  private async svnStatus(top: string): Promise<RepoFileChange[]> {
    const out = await this.run(top, 'svn', ['status']);
    const result: RepoFileChange[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const code = line[0] ?? ' ';
      const file = line.slice(8).trim();
      if (!file) continue;
      result.push({ path: file, status: code === '?' ? '?' : code === ' ' ? 'M' : code });
    }
    return result;
  }

  private async svnDiff(top: string, file: string, rev?: string): Promise<string> {
    const args = ['diff', '--internal-diff'];
    if (rev) args.push('-c', rev);
    args.push('--', file);
    return this.runAllowFail(top, 'svn', args);
  }

  private async svnCommit(top: string, files: string[], message: string): Promise<void> {
    await this.runAllowFail(top, 'svn', ['add', '--parents', '--', ...files]); // новые файлы
    await this.run(top, 'svn', ['commit', '-m', message, '--', ...files]);
  }
}

/** Диспетчер действий репозитория — единая точка для server.ts и relay-link.ts.
 *  Принимает распарсенное JSON-тело (поля не доверенные — коэрцируем). */
export async function runRepoAction(vcs: VcsService, req: Record<string, unknown>): Promise<unknown> {
  const root = String(req.root ?? '');
  const sub = String(req.path ?? '');
  switch (String(req.action ?? '')) {
    case 'log':
      return vcs.log(root, sub, Boolean(req.fetch));
    case 'show':
      return vcs.show(root, sub, String(req.rev ?? ''));
    case 'status':
      return vcs.status(root, sub);
    case 'diff':
      return vcs.diff(root, sub, String(req.file ?? ''), req.rev ? String(req.rev) : undefined);
    case 'cat':
      return vcs.cat(root, sub, String(req.file ?? ''));
    case 'pull':
      return vcs.pull(root, sub);
    case 'push':
      return vcs.push(root, sub);
    case 'branches':
      return vcs.branches(root, sub);
    case 'checkout':
      return vcs.checkout(root, sub, String(req.branch ?? ''));
    case 'create-branch':
      return vcs.createBranch(root, sub, String(req.branch ?? ''));
    case 'delete-branch':
      return vcs.deleteBranch(root, sub, String(req.branch ?? ''));
    case 'commit':
      return vcs.commit(
        root,
        sub,
        Array.isArray(req.files) ? req.files.map(String) : [],
        String(req.message ?? ''),
      );
    default:
      throw new Error('Unknown repository action');
  }
}

/** Разбирает %D («HEAD -> main, origin/main, tag: v1») в список меток.
 *  «HEAD ->» срезаем: это не имя ссылки, а указание, куда смотрит HEAD, и в списке
 *  меток оно выглядело бы отдельной несуществующей веткой. */
export function parseDecoration(decor: string): string[] {
  const out: string[] = [];
  for (const raw of decor.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const arrow = item.indexOf('-> ');
    out.push(arrow >= 0 ? item.slice(arrow + 3).trim() : item);
  }
  return [...new Set(out)].filter(Boolean);
}

/** svn: репо-относительный путь (/base/apps/x) → wc-относительный (apps/x). */
function svnToWc(repoPath: string, base: string): string {
  const p = repoPath.startsWith('/') ? repoPath : `/${repoPath}`;
  if (base && (p === base || p.startsWith(`${base}/`))) return p.slice(base.length + 1);
  return p.replace(/^\/+/, '');
}

/** Компактное сообщение об ошибке команды (первые строки stderr) — для pull/push. */
function cleanErr(e: unknown): Error {
  const err = e as { stderr?: string; message?: string };
  const raw = (err.stderr || err.message || '').toString().trim();
  return new Error(raw.split('\n').slice(0, 3).join(' ') || 'command failed');
}

/** git diff-tree --name-status → список изменений (R100\told\tnew → new, 'R'). */
function parseNameStatus(out: string): RepoFileChange[] {
  const result: RepoFileChange[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const cols = line.split('\t');
    const status = (cols[0] ?? '')[0] ?? 'M';
    const file = cols[cols.length - 1] ?? '';
    if (file) result.push({ path: file, status });
  }
  return result;
}

/** hg/svn «X path» → список изменений (первый символ — статус). */
function parseStatusLines(out: string): RepoFileChange[] {
  const result: RepoFileChange[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const code = line[0] ?? ' ';
    const file = line.slice(2).trim();
    if (!file) continue;
    result.push({ path: file, status: code === '?' ? '?' : code });
  }
  return result;
}
