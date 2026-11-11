// Память сессии: сколько оперативной памяти занимают процессы, запущенные в её панелях, —
// оболочка, агент и всё, что они породили. Сумма RSS по дереву процессов от корней панелей.
//
// Это оценка сверху, а не точный счёт: RSS включает общие страницы (библиотеки, отображённые
// файлы), и у каждого процесса они посчитаны заново. Для вопроса «какая сессия съела память»
// этого хватает; точного «сколько освободится» она не обещает.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { findSessionId, isExistingSessionName, SESSION_ID_FORMAT } from './tmux-session.js';
import { runTmux, isNoServerError } from './tmux-run.js';

const exec = promisify(execFile);

export interface MemoryRow {
  pid: number;
  ppid: number;
  /** Резидентная память, КиБ (так её печатает ps). */
  rssKb: number;
}

/** Источники — шов для тестов: живой tmux и живой ps подменяются здесь. */
export interface MemorySources {
  socketName?: string;
  /** PID корневых процессов всех панелей сессии; сессии нет — пустой список. */
  panePids(session: string): Promise<number[]>;
  processTable(): Promise<MemoryRow[]>;
}

const TMUX_TIMEOUT_MS = 3000;
/** Таблица процессов общая для всех сессий: окно расхода спрашивает их подряд, и ps на
 *  каждую был бы лишним. */
const TABLE_TTL_MS = 2000;
let cached: { at: number; rows: Promise<MemoryRow[]> } | undefined;

/** Разбор `ps -axo pid=,ppid=,rss=`; строки не того вида пропускаются. */
export function parseProcessTable(stdout: string): MemoryRow[] {
  const rows: MemoryRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]) });
  }
  return rows;
}

async function defaultProcessTable(): Promise<MemoryRow[]> {
  const now = Date.now();
  if (cached && now - cached.at < TABLE_TTL_MS) return cached.rows;
  const rows = exec('ps', ['-axo', 'pid=,ppid=,rss='], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  }).then(({ stdout }) => parseProcessTable(stdout));
  cached = { at: now, rows };
  // Сбой ps не должен жить в кэше до конца срока.
  rows.catch(() => {
    if (cached?.rows === rows) cached = undefined;
  });
  return rows;
}

/** Имя сначала разрешается в ID — как у ленты: tmux трактует `=$0:` как ID, а не как имя. */
async function defaultPanePids(session: string, socketName?: string): Promise<number[]> {
  try {
    const list = await runTmux(['list-sessions', '-F', SESSION_ID_FORMAT], { socketName, timeoutMs: TMUX_TIMEOUT_MS });
    const id = findSessionId(list, session);
    const out = await runTmux(['list-panes', '-s', '-t', `${id}:`, '-F', '#{pane_pid}'], {
      socketName,
      timeoutMs: TMUX_TIMEOUT_MS,
    });
    return out
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch (err) {
    if (isNoServerError(err)) return [];
    throw err;
  }
}

/** Сумма RSS по дереву процессов от корней, в байтах. Процесс считается один раз, даже
 *  если достижим от двух корней; цикл в таблице обход не зацикливает. */
export function treeRss(rows: MemoryRow[], roots: number[]): number {
  const children = new Map<number, MemoryRow[]>();
  const byPid = new Map<number, MemoryRow>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const seen = new Set<number>();
  const stack = [...roots];
  let kb = 0;
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    kb += byPid.get(pid)?.rssKb ?? 0;
    for (const child of children.get(pid) ?? []) stack.push(child.pid);
  }
  return kb * 1024;
}

/** Память сессии в байтах; undefined — посчитать не удалось или такой сессии нет. Не
 *  бросает: расход по сессии полезен и без этой цифры. */
export async function sessionMemory(session: string, sources?: Partial<MemorySources>): Promise<number | undefined> {
  if (!isExistingSessionName(session)) return undefined;
  const socketName = sources?.socketName;
  try {
    const roots = await (sources?.panePids ?? ((s: string) => defaultPanePids(s, socketName)))(session);
    if (roots.length === 0) return undefined;
    const rows = await (sources?.processTable ?? defaultProcessTable)();
    return treeRss(rows, roots);
  } catch {
    return undefined;
  }
}
