// Обёртка агента над tmux: список/создание/убийство сессий, перечисление
// каталогов под корнями и поллинг колокольчиков (bell). Все вызовы tmux — через общий
// runTmux (execFile, без shell). В тестах используется изолированный сокет (socketName → -L).

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SessionInfo } from '@termhub/protocol';
import { sessionWorking, sessionTitleText } from '@termhub/protocol';
import { isBuildSessionName } from './gradle.js';
import { runTmux, isNoServerError, type TmuxError } from './tmux-run.js';

const POLL_INTERVAL_MS = 2000;

/** Форматы вывода tmux (поля разделены табом). */
const SESSION_FORMAT =
  '#{session_name}\t#{session_path}\t#{session_activity}\t#{session_attached}\t#{pane_title}';
const PANE_FORMAT = '#{session_name}\t#{pane_current_command}\t#{window_bell_flag}';

// «Работает ли» определяется общим с вебом правилом (protocol/session-title):
// индикатор в начале pane_title, кроме ✳. Своя копия регулярки тут уже приводила
// к расхождению — Claude Code сменил спиннер, и агент с вебом сломались порознь.
// ✳ (ожидание) НЕ считаем звонком: это дефолтное состояние idle-сессии, висит
// даже на свежей, где ничего не вводили.

/** Команды-оболочки: их не считаем «командой сессии» (см. выбор command). */
const SHELL_COMMANDS = new Set(['zsh', 'bash', 'sh', '-zsh', 'login']);

/** Имя сессии: буквы/цифры/подчёркивание, дефис; 1–40 символов. Точка/двоеточие
 *  ЗАПРЕЩЕНЫ: tmux трактует их как разделители target (`session:window.pane`) — сессию
 *  с точкой в имени потом не адресовать (attach/kill по `-t` не находят её). */
const NAME_RE = /^[\w-]{1,40}$/;
/** Имя каталога: ровно одно имя, без слэша, NUL и управляющих символов (таб/перевод строки). */
const DIR_RE = /^[^/\0\t\n\r]+$/;

/** Имя сессии, которое TermHub умеет СОЗДАВАТЬ (строгий контракт create/kill/rename). */
export function isCreatableSessionName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Имя УЖЕ существующей сессии — для ссылки на неё (гостевой scope, WS-апгрейд).
 *  Шире, чем контракт создания: сессии, заведённые пользователем через `tm`, берут имя
 *  из каталога и могут содержать точку («v1.1») — на такие тоже надо уметь ссылаться.
 *  В tmux имя уходит только с точным префиксом «=», поэтому разделители target не опасны;
 *  отсекаем пустое, слишком длинное и управляющие символы. */
export function isExistingSessionName(name: string): boolean {
  return name.length > 0 && name.length <= 40 && !/[\u0000-\u001f\u007f]/.test(name);
}

/** Предел длины имени сессии (тот же, что в NAME_RE). */
const NAME_MAX = 40;
/** Потолок перебора числовых суффиксов в pickFreeName — практически недостижим. */
const MAX_NAME_PROBES = 10_000;

/** Свободное имя по базе: сама база, если не занята, иначе `<база><n>` для n = 1, 2, … —
 *  первое незанятое (дыры заполняются). Суффикс клеится без разделителя, база при нужде
 *  обрезается, чтобы уложиться в NAME_MAX; цифры на конце базы не разбираются (`v2` → `v21`). */
export function pickFreeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 1; n <= MAX_NAME_PROBES; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, NAME_MAX - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`No free session name for «${base}»: all numbered variants up to ${MAX_NAME_PROBES} are taken`);
}

/** Допустимые пресеты создаваемой сессии. «zsh» — просто оболочка, остальные
 *  запускают одноимённую команду поверх неё (см. create). */
export const SESSION_PRESETS = ['zsh', 'claude', 'codex'] as const;
export type SessionPreset = (typeof SESSION_PRESETS)[number];
const PRESETS = new Set<string>(SESSION_PRESETS);

/** Сырой формат «только имя» — для подбора свободного имени (см. takenNames). */
const NAME_ONLY_FORMAT = '#{session_name}';
/** Сколько раз create с autoName переигрывает «duplicate session» от tmux (гонка двух создающих). */
const DUPLICATE_RETRIES = 5;

/** «duplicate session: <имя>» — tmux отказал в new-session, потому что имя уже занято. */
function isDuplicateSessionError(err: unknown): boolean {
  const e = err as TmuxError;
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  return e.code === 1 && /duplicate session/i.test(stderr);
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
    return runTmux(args, { socketName: this.socketName });
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
    // Сборочные сессии Gradle наружу не отдаём: иначе они полезли бы в дашборд,
    // в полосу вкладок и в поллинг звонков. Attach на них при этом работает —
    // WS-роут проверяет имя, а не список.
    return parseListOutput(sessionsOut, panesOut).filter((s) => !isBuildSessionName(s.name));
  }

  /** Все занятые имена на сокете. Нарочно сырой list-sessions, а не list(): тот прячет
   *  сборочные сессии Gradle (их имена тоже заняты) и зря дёргает list-panes.
   *  «No server running» — пустой список: самую первую сессию создают до старта сервера. */
  private async takenNames(): Promise<Set<string>> {
    try {
      return new Set(nonEmptyLines(await this.tmux(['list-sessions', '-F', NAME_ONLY_FORMAT])));
    } catch (err) {
      if (isNoServerError(err)) return new Set();
      throw err;
    }
  }

  /** Создаёт сессию и возвращает её фактическое имя. С `autoName` (имя не вводили, оно
   *  взято из каталога) занятое имя нумеруется: MyProject → MyProject1, MyProject2…;
   *  без него имя берётся как есть, и отказ tmux на дубле уходит наружу, как раньше. */
  async create(req: {
    name: string;
    root: string;
    dir: string;
    preset: SessionPreset;
    autoName?: boolean;
  }): Promise<{ name: string }> {
    if (!NAME_RE.test(req.name))
      throw new Error(`Invalid session name «${req.name}»: letters, digits, «_», «-» allowed, 1–40 characters`);
    if (!PRESETS.has(req.preset))
      throw new Error(`Invalid preset «${req.preset}»: expected one of ${SESSION_PRESETS.join(', ')}`);
    if (!this.roots.includes(req.root))
      throw new Error(`Unknown root «${req.root}»`);
    if (!DIR_RE.test(req.dir) || req.dir === '.' || req.dir === '..')
      throw new Error(`Invalid directory «${req.dir}»: expected a single subdirectory name without «/» or «..»`);

    const dirPath = path.join(req.root, req.dir);
    let isDir = false;
    try {
      isDir = (await fsp.stat(dirPath)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new Error(`Directory «${req.dir}» not found in root ${req.root}`);

    // Пресет уже сверен с whitelist выше, поэтому произвольная команда сюда не пройдёт.
    // Codex overrides передаются как argv конкретного процесса: shell нет,
    // глобальный ~/.codex/config.toml не читается и не изменяется.
    const newSession = (name: string) => {
      const args = ['new-session', '-d', '-s', name, '-c', dirPath];
      if (req.preset === 'claude') args.push('claude');
      if (req.preset === 'codex') {
        args.push(
          'codex',
          '-c', 'tui.animations=false',
          '-c', 'tui.terminal_title=["activity","thread-title"]',
          // Inline вместо альтернативного экрана: только так у сессии Codex остаётся
          // история, которую можно листать (иначе её не бывает вовсе).
          '--no-alt-screen',
        );
      }
      return this.tmux(args);
    };

    if (!req.autoName) {
      await newSession(req.name);
      return { name: req.name };
    }

    const taken = await this.takenNames();
    for (let attempt = 0; attempt < DUPLICATE_RETRIES; attempt++) {
      const candidate = pickFreeName(req.name, taken);
      try {
        await newSession(candidate);
        return { name: candidate };
      } catch (err) {
        // Между чтением списка и new-session имя мог занять кто-то ещё (второе устройство,
        // `tm` в терминале): tmux отвечает «duplicate session» — считаем имя занятым и берём
        // следующий номер. Любая другая ошибка — не гонка, уходит наружу сразу.
        if (!isDuplicateSessionError(err)) throw err;
        taken.add(candidate);
      }
    }
    throw new Error(`Could not create session for «${req.name}»: name kept colliding after ${DUPLICATE_RETRIES} attempts`);
  }

  async kill(name: string): Promise<void> {
    if (!NAME_RE.test(name))
      throw new Error(`Invalid session name «${name}»: letters, digits, «_», «-» allowed, 1–40 characters`);
    // Префикс «=» отключает fuzzy-матчинг tmux (иначе -t матчит по префиксу).
    await this.tmux(['kill-session', '-t', `=${name}`]);
  }

  async rename(oldName: string, newName: string): Promise<void> {
    for (const n of [oldName, newName])
      if (!NAME_RE.test(n))
        throw new Error(`Invalid session name «${n}»: letters, digits, «_», «-» allowed, 1–40 characters`);
    // Префикс «=» — точное совпадение старого имени (как в kill); tmux сохраняет
    // сессию (pty/attach живут), меняется только имя.
    await this.tmux(['rename-session', '-t', `=${oldName}`, newName]);
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
      // Пока сессия работает — запоминаем задачу из заголовка для тела пуша.
      // Индикатор срезаем тем же общим правилом, что и веб: захардкоженный глиф
      // тут уже переживал смену спиннера в Claude Code и оставлял его в тексте.
      if (sessionWorking(s.title)) {
        const task = sessionTitleText(s.title);
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
