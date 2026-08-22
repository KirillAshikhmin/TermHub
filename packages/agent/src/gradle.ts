// Всё знание про Gradle на стороне агента: детект проекта, список тасок
// (`gradle tasks --all`, распарсенный и закэшированный), конфигурации запуска из
// XML проекта (IDEA) и имя сборочной tmux-сессии. Безопасность — как в files.ts/
// vcs.ts: внешние команды через execFile БЕЗ shell, имена тасок и аргументы
// проверяются регуляркой и ОТВЕРГАЮТСЯ, а не экранируются. Единственное исключение
// по спецификации — чтение списка тасок через login-оболочку ($SHELL -lc): Gradle
// почти всегда зависит от JAVA_HOME/sdkman/asdf из ~/.zshrc. Строка команды там
// КОНСТАНТНАЯ, пользовательских данных в ней нет — папка задаётся через cwd.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GradleProject, GradleRunConfig, GradleTask, GradleTasks } from '@termhub/protocol';

/** Маркеры Gradle-проекта в корне сессии — в порядке, в каком их перечисляем наружу. */
const MARKERS = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', 'gradlew'];

/** Файлы, по mtime которых инвалидируется кэш списка тасок. */
const CACHE_FILES = [...MARKERS.slice(0, 4), 'gradle.properties'];

/** Команда чтения тасок — КОНСТАНТА (см. шапку файла): ни одного подставляемого значения. */
const TASKS_CMD_WRAPPER = './gradlew tasks --all --console=plain -q';
const TASKS_CMD_GRADLE = 'gradle tasks --all --console=plain -q';
const TASKS_TIMEOUT_MS = 180_000;
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

/** Секция «Rules» в конце вывода `tasks --all` — это не таски, а шаблоны имён. */
const RULES_SECTION = 'Rules';
/** Группа без имени показывается как «Other tasks» — и должна быть последней. */
const OTHER_GROUP = 'Other tasks';

/** Имя таски и аргумент командной строки (§7 спецификации). Всё, что не прошло, отвергается. */
const TASK_RE = /^[A-Za-z0-9:._-]{1,200}$/;
const ARG_RE = /^[A-Za-z0-9:._=,/@+-]{1,200}$/;
export const MAX_ARGS = 32;

/** Префикс сборочных сессий: они прячутся из списка сессий (§2 спецификации). */
const BUILD_PREFIX = '_gradle_';
/** ≤24 символа санитизированного имени + 6 hex — итог укладывается в `^[\w-]{1,40}$`. */
const BUILD_NAME_MAX = 24;

/** Лимиты чтения XML конфигураций (§5 спецификации). */
const MAX_CONFIG_FILES = 100;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_WORKSPACE_BYTES = 4 * 1024 * 1024;

// ── Детект проекта ───────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Есть ли в папке Gradle-проект. Возвращает найденные маркеры или null. */
export async function detectProject(dir: string): Promise<GradleProject | null> {
  const root = path.resolve(dir);
  const markers: string[] = [];
  for (const m of MARKERS) {
    if (await exists(path.join(root, m))) markers.push(m);
  }
  if (markers.length === 0) return null;
  let wrapper = false;
  if (markers.includes('gradlew')) {
    try {
      const st = await fsp.stat(path.join(root, 'gradlew'));
      await fsp.access(path.join(root, 'gradlew'), fs.constants.X_OK);
      wrapper = st.isFile();
    } catch {
      wrapper = false;
    }
  }
  return { dir: root, wrapper, markers };
}

// ── Список тасок ─────────────────────────────────────────────────────────────

/** Разбирает вывод `gradle tasks --all --console=plain -q`.
 *  Заголовок группы — строка, под которой ровно столько же дефисов; таски внутри
 *  идут до пустой строки. Таска подпроекта печатается как `app:assembleDebug` —
 *  приводим к полному имени `:app:assembleDebug` и относим к проекту `:app`. */
export function parseTasksOutput(out: string, fetchedAt: number = Date.now()): GradleTasks {
  const lines = out.split(/\r?\n/);
  const tasks: GradleTask[] = [];
  const order: string[] = [];
  let group: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trimEnd();
    if (line.length === 0) {
      group = null;
      continue;
    }
    const next = i + 1 < lines.length ? lines[i + 1].trimEnd() : '';
    if (/^-+$/.test(next) && next.length === line.length) {
      // Заголовок группы; «Rules» — не группа тасок, её содержимое пропускаем.
      group = line === RULES_SECTION ? null : line;
      if (group !== null && !order.includes(group)) order.push(group);
      i += 1;
      continue;
    }
    if (group === null || /^-+$/.test(line)) continue;
    const task = parseTaskLine(line, group);
    if (task) tasks.push(task);
  }
  // «Other tasks» всегда последней, остальные — в порядке печати.
  const groupOrder = [...order.filter((g) => g !== OTHER_GROUP), ...order.filter((g) => g === OTHER_GROUP)];
  return { tasks, groupOrder, fetchedAt };
}

function parseTaskLine(line: string, group: string): GradleTask | null {
  const sep = line.indexOf(' - ');
  const raw = (sep === -1 ? line : line.slice(0, sep)).trim();
  const description = sep === -1 ? '' : line.slice(sep + 3).trim();
  if (!TASK_RE.test(raw)) return null;
  const last = raw.lastIndexOf(':');
  if (last === -1) return { name: raw, project: ':', group, description };
  const full = raw.startsWith(':') ? raw : `:${raw}`;
  const project = full.slice(0, full.lastIndexOf(':')) || ':';
  return { name: full, project, group, description };
}

/** Результат внешней команды: код и потоки, без throw (ошибку разбирает вызывающий). */
interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  failed: boolean;
}

function runShell(cmd: string, cwd: string): Promise<RunResult> {
  const shell = process.env.SHELL || '/bin/sh';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-lc', cmd],
      { cwd, timeout: TASKS_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string }) | null;
        resolve({
          code: typeof e?.code === 'number' ? e.code : e ? null : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          failed: Boolean(e),
        });
      },
    );
  });
}

/** Кэш списка тасок: папка → (сигнатура build-файлов, результат). */
const tasksCache = new Map<string, { sig: string; value: GradleTasks }>();

/** Сигнатура build-файлов папки (имя + mtime) — по ней инвалидируется кэш. */
async function buildFilesSig(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const f of CACHE_FILES) {
    try {
      const st = await fsp.stat(path.join(dir, f));
      parts.push(`${f}:${st.mtimeMs}`);
    } catch {
      // файла нет — в сигнатуру не попадает
    }
  }
  return parts.join('|');
}

export interface ListTasksOpts {
  /** Сбросить кэш и перечитать список у Gradle. */
  refresh?: boolean;
}

/** Хвост stderr для сообщения об ошибке: последние непустые строки. */
function stderrTail(stderr: string, lines = 12): string {
  const tail = stderr
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(-lines)
    .join('\n');
  return tail.slice(-4000);
}

/** Список тасок проекта. Кэшируется по (папка → mtime build-файлов). */
export async function listTasks(dir: string, opts: ListTasksOpts = {}): Promise<GradleTasks> {
  const project = await detectProject(dir);
  if (!project) throw new Error('Не Gradle-проект');
  const root = project.dir;
  const sig = await buildFilesSig(root);
  if (opts.refresh) tasksCache.delete(root);
  else {
    const hit = tasksCache.get(root);
    if (hit && hit.sig === sig) return hit.value;
  }
  const cmd = project.wrapper ? TASKS_CMD_WRAPPER : TASKS_CMD_GRADLE;
  const r = await runShell(cmd, root);
  if (r.failed) {
    const tail = stderrTail(r.stderr) || stderrTail(r.stdout);
    throw new Error(`Gradle не отдал список тасок${tail ? `:\n${tail}` : ''}`);
  }
  const value = parseTasksOutput(r.stdout);
  tasksCache.set(root, { sig, value });
  return value;
}

// ── Конфигурации запуска (XML) ───────────────────────────────────────────────

function unxml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Значение атрибута тега (первое вхождение). */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? unxml(m[1]) : null;
}

/** Значение `<option name="X" value="…"/>` внутри блока конфигурации. */
function optionValue(block: string, name: string): string | null {
  const m = new RegExp(`<option\\s+name="${name}"([^>]*)>`).exec(block);
  if (!m) return null;
  return attr(m[0], 'value');
}

/** Список из `<option name="X"><list><option value="…"/>…</list></option>`. */
function optionList(block: string, name: string): string[] {
  const open = new RegExp(`<option\\s+name="${name}"\\s*>`).exec(block);
  if (!open) return [];
  const from = open.index + open[0].length;
  const end = block.indexOf('</option>', from);
  const inner = block.slice(from, end === -1 ? block.length : end);
  const out: string[] = [];
  for (const m of inner.matchAll(/<option\s+value="([^"]*)"\s*\/?>/g)) out.push(unxml(m[1]));
  return out;
}

export interface ParseRunConfigOpts {
  /** Корень проекта: подстановка `$PROJECT_DIR$` и папка запуска по умолчанию. */
  projectDir: string;
  /** Откуда прочитано: '.run' | 'runConfigurations' | 'workspace'. */
  source: string;
}

/** Узкий парсер `<configuration type="GradleRunConfiguration">` — берёт ровно четыре
 *  поля (§5 спецификации). Конфигурации других типов пропускаются; битый блок,
 *  который не закрылся, обрывает разбор, но уже разобранное возвращается. */
export function parseRunConfigXml(xml: string, opts: ParseRunConfigOpts): GradleRunConfig[] {
  const out: GradleRunConfig[] = [];
  const openTag = /<configuration\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = openTag.exec(xml)) !== null) {
    const tag = m[0];
    const selfClosed = tag.endsWith('/>');
    let block = '';
    if (!selfClosed) {
      const end = xml.indexOf('</configuration>', openTag.lastIndex);
      if (end === -1) break; // незакрытый блок — дальше доверять нечему
      block = xml.slice(openTag.lastIndex, end);
      openTag.lastIndex = end + '</configuration>'.length;
    }
    if (attr(tag, 'type') !== 'GradleRunConfiguration') continue;
    const name = attr(tag, 'name');
    if (!name) continue;
    const tasks = optionList(block, 'taskNames');
    if (tasks.length === 0) continue; // без тасок запускать нечего — наружу не отдаём
    const rawDir = optionValue(block, 'externalProjectPath');
    const dir = rawDir
      ? path.resolve(rawDir.replace(/\$PROJECT_DIR\$/g, opts.projectDir))
      : path.resolve(opts.projectDir);
    out.push({
      name,
      tasks,
      args: optionValue(block, 'scriptParameters') ?? '',
      dir,
      source: opts.source,
    });
  }
  return out;
}

/** Внутри `<component name="RunManager">` из workspace.xml — только он нас интересует. */
function runManagerBlock(xml: string): string {
  const open = /<component\s+name="RunManager"[^>]*>/.exec(xml);
  if (!open) return '';
  const from = open.index + open[0].length;
  const end = xml.indexOf('</component>', from);
  return xml.slice(from, end === -1 ? xml.length : end);
}

/** Читает файл, если он не больше лимита; иначе (и на любой ошибке) — null. */
async function readCapped(file: string, limit: number): Promise<string | null> {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > limit) return null;
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** XML-файлы каталога по алфавиту (бюджет тратится при чтении, а не тут). */
async function xmlFiles(dir: string): Promise<string[]> {
  try {
    const names = (await fsp.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.xml')).sort();
    return names.sort().map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Лежит ли путь внутри корня (оба — уже реальные). */
function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

/** Конфигурации запуска Gradle из `.run/*.xml`, `.idea/runConfigurations/*.xml` и
 *  `RunManager` в `.idea/workspace.xml`. Дубли по имени схлопываются — `.run` важнее.
 *  Конфигурация, чья папка запуска после realpath вне корня сессии, пропускается
 *  вместе с именем (см. ниже), как и конфигурация без единой таски. */
export async function listRunConfigs(dir: string): Promise<GradleRunConfig[]> {
  const root = path.resolve(dir);
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    return [];
  }
  const found: GradleRunConfig[] = [];
  let budget = MAX_CONFIG_FILES;

  for (const [sub, source] of [
    ['.run', '.run'],
    [path.join('.idea', 'runConfigurations'), 'runConfigurations'],
  ] as const) {
    if (budget <= 0) break;
    for (const f of await xmlFiles(path.join(root, sub))) {
      if (budget <= 0) break;
      const xml = await readCapped(f, MAX_CONFIG_BYTES);
      if (xml === null) continue; // не прочитан (нет, велик, недоступен) — бюджет не тратим
      budget -= 1;
      try {
        found.push(...parseRunConfigXml(xml, { projectDir: root, source }));
      } catch {
        // битый файл пропускаем, остальные читаем дальше
      }
    }
  }

  const ws = await readCapped(path.join(root, '.idea', 'workspace.xml'), MAX_WORKSPACE_BYTES);
  if (ws !== null) {
    try {
      found.push(...parseRunConfigXml(runManagerBlock(ws), { projectDir: root, source: 'workspace' }));
    } catch {
      // см. выше
    }
  }

  // Имя занимает ПЕРВЫЙ источник (.run → runConfigurations → workspace) — даже если
  // его папка не прошла проверку на вхождение в корень. Иначе конфигурация,
  // отвергнутая за выход из корня, воскресала бы из младшего источника под тем же
  // именем — пользователь запустил бы не то, что видел в IDEA.
  const claimed = new Set<string>();
  const out: GradleRunConfig[] = [];
  for (const c of found) {
    if (claimed.has(c.name)) continue;
    claimed.add(c.name);
    let realDir: string;
    try {
      realDir = await fsp.realpath(c.dir);
    } catch {
      continue; // папки запуска нет — проверить вхождение в корень нечем
    }
    if (!inside(realRoot, realDir)) continue;
    out.push(c);
  }
  return out;
}

// ── Сборочная сессия и валидация ─────────────────────────────────────────────

/** Имя сборочной tmux-сессии для рабочей: детерминировано, ≤40 символов,
 *  не сталкивается при обрезке (хвост — 6 hex от sha256 полного имени). */
export function buildSessionName(session: string): string {
  const safe = session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, BUILD_NAME_MAX);
  const hash = createHash('sha256').update(session, 'utf8').digest('hex').slice(0, 6);
  return `${BUILD_PREFIX}${safe}_${hash}`;
}

/** Сборочная ли это сессия — по префиксу (такие не показываются в списке сессий). */
export function isBuildSessionName(name: string): boolean {
  return name.startsWith(BUILD_PREFIX);
}

/** Имя таски: отвергаем всё, что не прошло, — не экранируем (§7 спецификации). */
export function checkTaskName(name: string): void {
  if (!TASK_RE.test(name)) throw new Error(`Недопустимое имя таски: ${JSON.stringify(name)}`);
}

/** Аргументы запуска: каждый по регулярке, не больше MAX_ARGS штук. */
export function checkArgs(args: string[]): void {
  if (args.length > MAX_ARGS) throw new Error(`Слишком много аргументов: ${args.length} > ${MAX_ARGS}`);
  for (const a of args) {
    if (!ARG_RE.test(a)) throw new Error(`Недопустимый аргумент: ${JSON.stringify(a)}`);
  }
}
