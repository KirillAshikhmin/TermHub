// Единый обработчик экшенов вкладки Gradle: один и тот же код обслуживает LAN
// (POST /api/gradle) и relay (кадры Gradle/GradleResult) — вторая реализация
// разъехалась бы в правах и проверках путей. Здесь же живут две вещи, которых нет
// в gradle.ts: резолв корня сессии с realpath-проверкой на вхождение в whitelist
// корней (gradle.ts принимает папку на веру) и права гостя (§7 спецификации).
// Резолв корня нужен экшенам, которые ЧИТАЮТ проект и запускают в нём команду
// (detect/tasks/configs/run); статус и стоп работают с tmux-сессией по имени.

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GradleAction } from '@termhub/protocol';
import type { DeviceScope } from './config.js';
import type { SessionService } from './sessions.js';
import {
  detectProject,
  isInsideRoot,
  listRunConfigs,
  listTasks,
  runStatus,
  startRun,
  stopRun,
} from './gradle.js';

export interface GradleActionDeps {
  sessions: SessionService;
  /** Whitelist корней сессий (config.sessionRoots). Пустой — не разрешено ничего. */
  roots: string[];
  /** Изолированный сокет tmux (в проде — config.TMUX_SOCKET). */
  socketName?: string;
  /** Ограничение гостя; undefined — владелец (в LAN владелец всегда). */
  scope?: DeviceScope;
}

/** Экшены только на чтение — гостю доступны при scope.files. Тип элементов сверяет
 *  набор с контрактом (`GradleAction`), `ReadonlySet<string>` — пускает сырой ввод в has(). */
const READ_ACTIONS: ReadonlySet<string> = new Set<GradleAction>(['detect', 'tasks', 'configs', 'status']);
/** Экшены, запускающие и прерывающие сборку, — гостю только при scope.write. */
const WRITE_ACTIONS: ReadonlySet<string> = new Set<GradleAction>(['run', 'stop']);

/** Причина отказа realpath словами: по «нет такой папки», «в пути файл» и «нет прав»
 *  пользователь идёт в разные места, а один общий текст отправлял бы всех к правам. */
const REALPATH_CAUSES: Record<string, string> = {
  ENOENT: 'not found',
  ENOTDIR: 'is not a directory',
  ELOOP: 'has too many symbolic links',
  ENAMETOOLONG: 'path is too long',
  EACCES: 'is not readable',
  EPERM: 'is not readable',
};

/** realpath с честной причиной отказа: «нет такой папки», «папка вне корня» и «нет
 *  прав» — разные ошибки, и лечатся они по-разному. Незнакомый код errno не выдаём
 *  за отказ в правах, а называем как есть. */
async function realDir(target: string, what: string): Promise<string> {
  try {
    return await fsp.realpath(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    const cause = REALPATH_CAUSES[code];
    throw new Error(cause ? `${what} ${cause}` : `${what} cannot be resolved (${code || (err as Error).message})`);
  }
}

/** Реальный каталог сессии по её имени — только резолв, без разрешений. */
async function sessionDir(deps: GradleActionDeps, session: string): Promise<string> {
  const list = await deps.sessions.list();
  const info = list.find((x) => x.name === session);
  if (!info) throw new Error('Session not found');
  return await realDir(info.path, 'Session directory');
}

/** Разрешение на каталог: он обязан лежать внутри одного из whitelist-корней (как в
 *  files.ts). Пустой список корней не разрешает ничего (fail-closed). */
async function authorizeDir(deps: GradleActionDeps, real: string): Promise<string> {
  for (const root of deps.roots) {
    const realRoot = await fsp.realpath(root).catch(() => null);
    if (realRoot && isInsideRoot(realRoot, real)) return real;
  }
  throw new Error('Session directory outside allowed roots');
}

/** Корень Gradle-проекта = каталог сессии, разрешённый whitelist'ом: symlink и «..»
 *  внутри имени каталога иначе увели бы запуск сборки в произвольную папку машины. */
async function allowedSessionRoot(deps: GradleActionDeps, session: string): Promise<string> {
  return await authorizeDir(deps, await sessionDir(deps, session));
}

/** Папка запуска: `subdir` относительно корня, тоже через realpath (`externalProjectPath`
 *  конфигурации и подпапка из UI приходят снаружи). Пустой subdir — сам корень. */
async function resolveRunDir(root: string, subdir: string): Promise<string> {
  if (subdir.length === 0) return root;
  const real = await realDir(path.resolve(root, subdir), 'Run directory');
  if (!isInsideRoot(root, real)) throw new Error('Run directory outside session root');
  return real;
}

/** Выполняет экшен вкладки Gradle. Бросает при неизвестном экшене, выходе за корни
 *  и нехватке прав — вызывающий превращает ошибку в 400 (LAN) или в поле `error`
 *  кадра GradleResult (relay). */
export async function runGradleAction(deps: GradleActionDeps, req: Record<string, unknown>): Promise<unknown> {
  const action = String(req.action ?? '');
  const session = String(req.session ?? '');
  if (!READ_ACTIONS.has(action) && !WRITE_ACTIONS.has(action))
    throw new Error(`Unknown gradle action: ${action}`);

  const scope = deps.scope;
  if (scope) {
    // Гость видит только свою расшаренную сессию — чужую не читает и не собирает.
    if (session !== scope.session) throw new Error('session not shared');
    if (WRITE_ACTIONS.has(action)) {
      if (!scope.write) throw new Error('no write permission');
    } else if (!scope.files) {
      throw new Error('no files permission');
    }
  }

  const socketName = deps.socketName;
  // Статус и стоп адресуют сборочную tmux-сессию по имени рабочей и каталога не
  // касаются вовсе: папку могли переименовать или удалить прямо во время сборки —
  // остановить её при этом всё равно надо. Резолв корня остаётся там, где от него
  // зависит, ЧТО и ГДЕ исполнится: detect/tasks/configs/run.
  if (action === 'status') return await runStatus({ session, socketName });
  if (action === 'stop') return await stopRun({ session, socketName });

  const root = await allowedSessionRoot(deps, session);
  switch (action) {
    case 'detect':
      return await detectProject(root);
    case 'tasks':
      return await listTasks(root, { refresh: req.refresh === true });
    case 'configs':
      return await listRunConfigs(root);
    default: {
      // run: корень проекта и папка запуска передаются РАЗНЫМИ — wrapper живёт только
      // в корне многомодульной сборки, а запуск идёт в подпапке (см. §6).
      const dir = await resolveRunDir(root, String(req.subdir ?? ''));
      return await startRun({
        session,
        socketName,
        root,
        dir,
        tasks: Array.isArray(req.tasks) ? req.tasks.map(String) : [],
        args: Array.isArray(req.args) ? req.args.map(String) : [],
        force: req.force === true,
      });
    }
  }
}
