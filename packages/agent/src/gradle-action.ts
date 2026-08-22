// Единый обработчик экшенов вкладки Gradle: один и тот же код обслуживает LAN
// (POST /api/gradle) и relay (кадры Gradle/GradleResult) — вторая реализация
// разъехалась бы в правах и проверках путей. Здесь же живут две вещи, которых нет
// в gradle.ts: резолв корня сессии с realpath-проверкой на вхождение в whitelist
// корней (gradle.ts принимает папку на веру) и права гостя (§7 спецификации).

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DeviceScope } from './config.js';
import type { SessionService } from './sessions.js';
import { detectProject, listRunConfigs, listTasks, runStatus, startRun, stopRun } from './gradle.js';

export interface GradleActionDeps {
  sessions: SessionService;
  /** Whitelist корней сессий (config.sessionRoots). Пустой — не разрешено ничего. */
  roots: string[];
  /** Изолированный сокет tmux (в проде — config.TMUX_SOCKET). */
  socketName?: string;
  /** Ограничение гостя; undefined — владелец (в LAN владелец всегда). */
  scope?: DeviceScope;
}

/** Экшены только на чтение — гостю доступны при scope.files. */
const READ_ACTIONS = new Set(['detect', 'tasks', 'configs', 'status']);
/** Экшены, запускающие и прерывающие сборку, — гостю только при scope.write. */
const WRITE_ACTIONS = new Set(['run', 'stop']);

/** realpath с честной причиной отказа: «нет такой папки» и «папка вне корня» — разные
 *  ошибки, и пользователь по ним идёт в разные места (опечатка против прав). */
async function realDir(target: string, what: string): Promise<string> {
  try {
    return await fsp.realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${what} not found`);
    throw new Error(`${what} is not readable`);
  }
}

/** Лежит ли реальный путь внутри реального корня (или совпадает с ним). */
function inside(real: string, realRoot: string): boolean {
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

/** Корень Gradle-проекта = каталог сессии, проверенный realpath на вхождение в
 *  whitelist корней (как в files.ts): symlink и «..» внутри имени каталога иначе
 *  увели бы запуск сборки в произвольную папку машины. */
async function sessionRoot(deps: GradleActionDeps, session: string): Promise<string> {
  const list = await deps.sessions.list();
  const info = list.find((x) => x.name === session);
  if (!info) throw new Error('Session not found');
  const real = await realDir(info.path, 'Session directory');
  for (const root of deps.roots) {
    const realRoot = await fsp.realpath(root).catch(() => null);
    if (realRoot && inside(real, realRoot)) return real;
  }
  throw new Error('Session directory outside allowed roots');
}

/** Папка запуска: `subdir` относительно корня, тоже через realpath (`externalProjectPath`
 *  конфигурации и подпапка из UI приходят снаружи). Пустой subdir — сам корень. */
async function resolveRunDir(root: string, subdir: string): Promise<string> {
  if (subdir.length === 0) return root;
  const real = await realDir(path.resolve(root, subdir), 'Run directory');
  if (!inside(real, root)) throw new Error('Run directory outside session root');
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

  const root = await sessionRoot(deps, session);
  const socketName = deps.socketName;
  switch (action) {
    case 'detect':
      return await detectProject(root);
    case 'tasks':
      return await listTasks(root, { refresh: req.refresh === true });
    case 'configs':
      return await listRunConfigs(root);
    case 'status':
      return await runStatus({ session, socketName });
    case 'stop':
      return await stopRun({ session, socketName });
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
