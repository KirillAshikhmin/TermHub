// Обёртка агента над tmux: список/создание/убийство сессий, перечисление
// каталогов под корнями и поллинг колокольчиков (bell). Все вызовы tmux — через
// execFile (без shell). В тестах используется изолированный сокет (socketName → -L).

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SessionInfo } from '@termhub/protocol';

const POLL_INTERVAL_MS = 2000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

/** Форматы вывода tmux (поля разделены табом). */
const SESSION_FORMAT =
  '#{session_name}\t#{session_path}\t#{session_activity}\t#{session_attached}\t#{pane_title}';
const PANE_FORMAT = '#{session_name}\t#{pane_current_command}\t#{window_bell_flag}';

/** Брайлевый спиннер в начале pane_title = Claude работает; текст после него —
 *  задача (для пуша «сессия: задача»). ✳ (ожидание) НЕ считаем звонком: это
 *  дефолтное состояние idle-сессии, висит даже на свежей, где ничего не вводили. */
const TITLE_WORKING_RE = /^\s*[⠀-⣿]/u;

/** Команды-оболочки: их не считаем «командой сессии» (см. выбор command). */
const SHELL_COMMANDS = new Set(['zsh', 'bash', 'sh', '-zsh', 'login']);

/** Имя сессии: буквы/цифры/подчёркивание, дефис; 1–40 символов. Точка/двоеточие
 *  ЗАПРЕЩЕНЫ: tmux трактует их как разделители target (`session:window.pane`) — сессию
 *  с точкой в имени потом не адресовать (attach/kill по `-t` не находят её). */
const NAME_RE = /^[\w-]{1,40}$/;
/** Имя каталога: ровно одно имя, без слэша, NUL и управляющих символов (таб/перевод строки). */
const DIR_RE = /^[^/\0\t\n\r]+$/;

/** Допустимые пресеты создаваемой сессии. */
const PRESETS = new Set(['zsh', 'claude']);

/** Результат tmux-вызова с exit-кодом и stderr (для распознавания «no server»). */
interface TmuxError extends Error {
  code?: number | string;
  stderr?: string;
}

function isNoServerError(err: unknown): boolean {
  const e = err as TmuxError;
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  return e.code === 1 && /no server running|error connecting|no such file or directory/i.test(stderr);
}

/** Разбивает вывод tmux на непустые строки. */
function nonEmptyLines(out: string): string[] {
  return out.split('\n').filter((l) => l.length > 0);
}

/** Собирает SessionInfo[] из вывода list-sessions и list-panes. */
export function parseListOutput(sessionsOut: string, panesOut: string): SessionInfo[] {
  const commandsBySession = new Map<string, string[]>();
  const bellBySession = new Map<string, boolean>();
  for (const line of nonEmptyLines(panesOut)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    // name = первое поле, bell = последнее, command = всё между ними (склеено табом обратно —
    // единственное поле, способное содержать таб, это command).
    const name = parts[0]!;
    const bellFlag = parts[parts.length - 1];
    const command = parts.slice(1, -1).join('\t');
    const commands = commandsBySession.get(name) ?? [];
    commands.push(command);
    commandsBySession.set(name, commands);
    bellBySession.set(name, (bellBySession.get(name) ?? false) || bellFlag === '1');
  }

  const result: SessionInfo[] = [];
  for (const line of nonEmptyLines(sessionsOut)) {
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    // name = первое поле; title, attached, activity = три последних; path = всё между
    // ними (склеено табом обратно — единственное поле, способное содержать таб, это
    // session_path; в заголовке табов нет).
    const name = parts[0]!;
    const title = parts[parts.length - 1]!;
    const attached = parts[parts.length - 2]!;
    const activity = parts[parts.length - 3]!;
    const sessionPath = parts.slice(1, -3).join('\t');
    const commands = commandsBySession.get(name) ?? [];
    const command = commands.find((c) => c.length > 0 && !SHELL_COMMANDS.has(c)) ?? 'zsh';
    result.push({
      name,
      path: sessionPath,
      command,
      activityTs: Number(activity) * 1000,
      attached: Number(attached),
      bell: bellBySession.get(name) ?? false,
      title,
    });
  }
  return result;
}

/** Обёртка над tmux-сессиями. */
export class SessionService {
  private readonly roots: string[];
  private readonly socketName?: string;
  private readonly bellCallbacks: Array<(session: string, task: string) => void> = [];
  private readonly prevBell = new Map<string, boolean>();
  /** Последняя задача сессии (текст из брайлевого заголовка) — для тела пуша. */
  private readonly lastTask = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: { roots: string[]; socketName?: string }) {
    this.roots = opts.roots;
    this.socketName = opts.socketName;
  }

  /** Запускает tmux с изолированным сокетом (если задан) и возвращает stdout. */
  private tmux(args: string[]): Promise<string> {
    const full = this.socketName ? ['-L', this.socketName, ...args] : args;
    return new Promise((resolve, reject) => {
      execFile('tmux', full, { encoding: 'utf8', maxBuffer: EXEC_MAX_BUFFER }, (err, stdout, stderr) => {
        if (err) {
          (err as TmuxError).stderr = stderr;
          reject(err);
          return;
        }
        resolve(stdout);
      });
    });
  }

  async list(): Promise<SessionInfo[]> {
    let sessionsOut: string;
    try {
      sessionsOut = await this.tmux(['list-sessions', '-F', SESSION_FORMAT]);
    } catch (err) {
      if (isNoServerError(err)) return [];
      throw err;
    }
    let panesOut = '';
    try {
      panesOut = await this.tmux(['list-panes', '-a', '-F', PANE_FORMAT]);
    } catch (err) {
      if (!isNoServerError(err)) throw err;
    }
    return parseListOutput(sessionsOut, panesOut);
  }

  async create(req: { name: string; root: string; dir: string; preset: 'zsh' | 'claude' }): Promise<void> {
    if (!NAME_RE.test(req.name))
      throw new Error(`Недопустимое имя сессии «${req.name}»: разрешены буквы, цифры, «_», «.», «-», 1–40 символов`);
    if (!PRESETS.has(req.preset)) throw new Error(`Недопустимый пресет «${req.preset}»: ожидается «zsh» или «claude»`);
    if (!this.roots.includes(req.root))
      throw new Error(`Неизвестный корень каталогов «${req.root}»`);
    if (!DIR_RE.test(req.dir) || req.dir === '.' || req.dir === '..')
      throw new Error(`Недопустимый каталог «${req.dir}»: ожидается одно имя подкаталога без «/» и «..»`);

    const dirPath = path.join(req.root, req.dir);
    let isDir = false;
    try {
      isDir = (await fsp.stat(dirPath)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new Error(`Каталог «${req.dir}» не найден в корне ${req.root}`);

    const args = ['new-session', '-d', '-s', req.name, '-c', dirPath];
    if (req.preset === 'claude') args.push('claude');
    await this.tmux(args);
  }

  async kill(name: string): Promise<void> {
    if (!NAME_RE.test(name))
      throw new Error(`Недопустимое имя сессии «${name}»: разрешены буквы, цифры, «_», «.», «-», 1–40 символов`);
    // Префикс «=» отключает fuzzy-матчинг tmux (иначе -t матчит по префиксу).
    await this.tmux(['kill-session', '-t', `=${name}`]);
  }

  async dirs(): Promise<{ root: string; dirs: string[] }[]> {
    const result: { root: string; dirs: string[] }[] = [];
    for (const root of this.roots) {
      let dirs: string[] = [];
      try {
        const entries = await fsp.readdir(root, { withFileTypes: true });
        dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
          .sort();
      } catch (err) {
        // Только «каталога нет» (ENOENT) — легитимно пустой список. Прочие ошибки
        // (EACCES, ENOTDIR …) не маскируем под «нет каталога», а пробрасываем.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        dirs = [];
      }
      result.push({ root, dirs });
    }
    return result;
  }

  /** Подписка на колокольчик: cb вызывается при переходе bell false→true у сессии. */
  onBell(cb: (session: string, task: string) => void): void {
    this.bellCallbacks.push(cb);
  }

  startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollBell(), POLL_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stopPolling(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Один цикл поллинга: эмитит колокольчики по переходу false→true. */
  private async pollBell(): Promise<void> {
    let sessions: SessionInfo[];
    try {
      sessions = await this.list();
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const s of sessions) {
      seen.add(s.name);
      // Пока сессия работает (брайлевый заголовок) — запоминаем задачу для пуша.
      if (TITLE_WORKING_RE.test(s.title)) {
        const task = s.title.replace(/^\s*[⠀-⣿]\s*/u, '').trim();
        if (task) this.lastTask.set(s.name, task);
      }
      const prev = this.prevBell.get(s.name) ?? false;
      if (s.bell && !prev) {
        const task = this.lastTask.get(s.name) ?? '';
        for (const cb of this.bellCallbacks) cb(s.name, task);
      }
      this.prevBell.set(s.name, s.bell);
    }
    for (const name of [...this.prevBell.keys()])
      if (!seen.has(name)) {
        this.prevBell.delete(name);
        this.lastTask.delete(name);
      }
  }
}
