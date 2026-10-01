// Всё знание про Gradle на стороне агента: детект проекта, список тасок
// (`gradle tasks --all`, распарсенный и закэшированный), конфигурации запуска из
// XML проекта (IDEA) и имя сборочной tmux-сессии. Безопасность — как в files.ts/
// vcs.ts: внешние команды через execFile БЕЗ shell, имена тасок и аргументы
// проверяются регуляркой и ОТВЕРГАЮТСЯ, а не экранируются. Единственное исключение
// по спецификации — чтение списка тасок через login-оболочку ($SHELL -lc): Gradle
// почти всегда зависит от JAVA_HOME/sdkman/asdf из ~/.zshrc. Строка команды там
// КОНСТАНТНАЯ, пользовательских данных в ней нет — папка задаётся через cwd, а путь
// к JDK проекта (§6) — отдельным значением в окружении, не внутри строки.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  GradleProject,
  GradleRunConfig,
  GradleRunConfigSource,
  GradleRunPhase,
  GradleRunState,
  GradleTask,
  GradleTasks,
} from '@termhub/protocol';

/** Имя wrapper'а — единственный маркер, который не описывает сборку, а запускает её. */
const WRAPPER_NAME = 'gradlew';

/** Маркеры Gradle-проекта в корне сессии — в порядке, в каком их перечисляем наружу. */
const MARKERS = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', WRAPPER_NAME];

/** Build-файлы проекта: все маркеры, кроме wrapper'а (отбор по имени, а не по позиции
 *  в MARKERS — иначе новый маркер в середине списка молча менял бы набор). */
const BUILD_FILES = MARKERS.filter((m) => m !== WRAPPER_NAME);

/** Команда чтения тасок — КОНСТАНТА (см. шапку файла): ни одного подставляемого значения. */
const TASKS_CMD_WRAPPER = './gradlew tasks --all --console=plain -q';
const TASKS_CMD_GRADLE = 'gradle tasks --all --console=plain -q';
const TASKS_TIMEOUT_MS = 180_000;
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

/** Где записан JDK проекта — в том же порядке, в каком его выбирает IDEA (§6). */
const JDK_KEY_GRADLE = 'org.gradle.java.home';
const JDK_KEY_CONFIG = 'java.home';
const MAX_PROPS_BYTES = 256 * 1024;

/** Путь к JDK едет ОТДЕЛЬНЫМ значением (env у execFile, `-e` у tmux new-session), а не
 *  внутри строки команды: в нём бывают пробелы («/Applications/Android Studio.app/…»),
 *  а строки команд у нас константны и не экранируются. Повторный export перед самой
 *  командой нужен потому, что ~/.zshrc пользователя выставляет свой JAVA_HOME уже ПОСЛЕ
 *  старта оболочки и переданное окружение иначе перебивается. */
const JDK_ENV_VAR = 'TERMHUB_JAVA_HOME';
const JDK_EXPORT = `export JAVA_HOME="$${JDK_ENV_VAR}"; `;

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
/** Читаемый префикс; идентичность задаётся полным SHA-256 и метаданными источника. */
const BUILD_NAME_MAX = 24;

/** Лимиты чтения XML конфигураций (§5 спецификации). */
const MAX_CONFIG_FILES = 100;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_WORKSPACE_BYTES = 4 * 1024 * 1024;

// ── Детект проекта ───────────────────────────────────────────────────────────

/** Есть ли исполняемый файл по пути (для ./gradlew). */
async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return false;
    await fsp.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

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
  const wrapper = markers.includes('gradlew') && (await isExecutableFile(path.join(root, 'gradlew')));
  return { dir: root, wrapper, markers };
}

// ── JDK проекта ──────────────────────────────────────────────────────────────

/** Логические строки .properties: строка, оканчивающаяся НЕЧЁТНЫМ числом обратных
 *  слэшей, продолжается следующей — у продолжения отбрасываются ведущие пробелы.
 *  Комментарий не продолжается: он кончается на своём переводе строки. */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let acc: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[ \t\f]+/, '');
    if (acc === null && (line.length === 0 || line.startsWith('#') || line.startsWith('!'))) continue;
    const cur: string = (acc ?? '') + line;
    if (/(?:^|[^\\])(?:\\\\)*\\$/.test(cur)) {
      acc = cur.slice(0, -1);
      continue;
    }
    out.push(cur);
    acc = null;
  }
  if (acc !== null) out.push(acc);
  return out;
}

/** Разбор одной логической строки: ключ кончается на первом неэкранированном `=`, `:`
 *  ИЛИ пробеле (`java.util.Properties` признаёт разделителем и его), дальше — значение. */
function parseProperty(line: string): { key: string; value: string } | null {
  let i = 0;
  let key = '';
  for (; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      key += ch + line[i + 1];
      i += 1;
      continue;
    }
    if (ch === '=' || ch === ':' || ch === ' ' || ch === '\t' || ch === '\f') break;
    key += ch;
  }
  if (key.length === 0) return null;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t' || line[i] === '\f')) i += 1;
  if (i < line.length && (line[i] === '=' || line[i] === ':')) {
    i += 1;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t' || line[i] === '\f')) i += 1;
  }
  // Хвостовые пробелы Properties сохраняет, но путь ими не кончается, а в файле они бывают.
  const value = line.slice(i).replace(/(?<!\\)[ \t\f]+$/, '');
  return { key: unescapeProperty(key), value: unescapeProperty(value) };
}

/** Значение свойства из .properties-файла (формат `java.util.Properties`: разделитель
 *  `=`, `:` или пробел, перенос строки хвостовым `\`, escape-последовательности,
 *  комментарии `#`/`!`). Повторённый ключ берётся ПОСЛЕДНИЙ — так его читает и сама
 *  `java.util.Properties`, а значит и Gradle: свойство чаще всего дописывают строкой
 *  в конец файла. Выставлено наружу, чтобы разбор формата проверялся напрямую, а не
 *  через запись файла и чтение списка тасок. */
export function propertyValue(text: string, key: string): string | null {
  let found: string | null = null;
  for (const line of logicalLines(text)) {
    const parsed = parseProperty(line);
    if (parsed !== null && parsed.key === key) found = parsed.value;
  }
  return found;
}

/** Escape-последовательности значения: Properties.store() экранирует пробелы, `:`, `=`
 *  и сам обратный слэш (на Windows путь пишется как `C\:\\Program Files\\…`). */
function unescapeProperty(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== '\\' || i + 1 >= value.length) {
      out += ch;
      continue;
    }
    i += 1;
    const next = value[i];
    if (next === 't') out += '\t';
    else if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 'f') out += '\f';
    else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(value.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(value.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += next;
  }
  return out;
}

/** Каталог пользовательских настроек Gradle (его же читает и сама сборка). */
function gradleUserHome(): string {
  return process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
}

/** Откуда берётся JDK проекта, в порядке §6: файл и ключ в нём. Список ОДИН на две
 *  задачи — выбрать JDK (resolveJavaHome) и заметить, что он сменился (сигнатура
 *  кэша тасок): вторая копия означала бы, что новый источник молча отдаёт список,
 *  прочитанный на прежнем JDK. Выставлен наружу, чтобы тест перебирал ровно эти
 *  источники, а не свою копию списка. */
export function jdkSources(root: string): { file: string; key: string }[] {
  return [
    { file: path.join(root, 'gradle.properties'), key: JDK_KEY_GRADLE },
    { file: path.join(gradleUserHome(), 'gradle.properties'), key: JDK_KEY_GRADLE },
    { file: path.join(root, '.gradle', 'config.properties'), key: JDK_KEY_CONFIG },
  ];
}

/** JDK проекта — тот же выбор, что делает IDEA (§6 спецификации): свойство проекта →
 *  то же свойство в настройках пользователя → `java.home` из `<проект>/.gradle/config.properties`
 *  (это и есть `#GRADLE_LOCAL_JAVA_HOME` из `.idea/gradle.xml`). Путь, по которому нет
 *  исполняемого `bin/java`, пропускается, как будто его не записали. `null` — оставить
 *  окружение login-оболочки как есть.
 *
 *  НАМЕРЕННО без проверки вхождения в корни сессии — и добавлять её сюда нельзя:
 *  типичный JDK Android-проекта лежит в `/Applications/Android Studio.app/Contents/jbr/…`,
 *  то есть заведомо вне корней, и whitelist сломал бы ровно тот случай, ради которого
 *  выбор JDK и появился. Новой дыры нет: путь берётся из файлов САМОГО проекта, едет
 *  отдельным значением окружения (не строкой команды), а сборка и так исполняет
 *  `./gradlew` из этого же проекта. */
async function resolveJavaHome(root: string): Promise<string | null> {
  for (const { file, key } of jdkSources(root)) {
    const text = await readCapped(file, MAX_PROPS_BYTES);
    if (text === null) continue;
    const value = propertyValue(text, key);
    if (value === null || value.length === 0) continue;
    const home = path.resolve(root, value);
    if (await isExecutableFile(path.join(home, 'bin', 'java'))) return home;
  }
  return null;
}

/** Окружение агента с добавленным JDK — целиком, а не две переменные: команде нужен
 *  весь PATH и всё остальное. Обе переменные держим вместе: JAVA_HOME читает сам
 *  gradlew, TERMHUB_JAVA_HOME — источник для повторного export (JDK_EXPORT). */
function processEnvWithJdk(javaHome: string): NodeJS.ProcessEnv {
  return { ...process.env, JAVA_HOME: javaHome, [JDK_ENV_VAR]: javaHome };
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

/** Результат внешней команды: потоки и признак неудачи, без throw (разбирает вызывающий).
 *  Кода возврата тут нет — ни один вызывающий его не читает: сборка отдаёт свой код
 *  строкой `[termhub] gradle exit=N` в терминал, а списку тасок хватает `failed`. */
interface RunResult {
  stdout: string;
  stderr: string;
  failed: boolean;
}

function runShell(cmd: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  const shell = process.env.SHELL || '/bin/sh';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-lc', cmd],
      { cwd, env, timeout: TASKS_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          failed: Boolean(err),
        });
      },
    );
  });
}

/** Кэш списка тасок: папка → (сигнатура входных файлов, результат). */
const tasksCache = new Map<string, { sig: string; value: GradleTasks }>();

/** Сигнатура входных файлов (путь + mtime + размер): всё, что описывает сборку, и всё,
 *  откуда берётся JDK (§6) — источники берутся из того же `jdkSources`, что и сам выбор
 *  JDK, поэтому добавленный источник инвалидирует кэш сам собой. Только СТАТЫ: ключ
 *  кэша обязан стоить дешевле того, что кэш экономит, поэтому сам JDK (чтения файлов
 *  и stat на bin/java) вычисляется только при промахе. Плата: JDK, исчезнувший с диска
 *  без правки .properties, кэш не инвалидирует — это заметит уже сама сборка. */
async function cacheSig(root: string): Promise<string> {
  const files = [...BUILD_FILES.map((f) => path.join(root, f)), ...jdkSources(root).map((s) => s.file)];
  const parts: string[] = [];
  for (const f of files) {
    try {
      const st = await fsp.stat(f);
      parts.push(`${f}:${st.mtimeMs}:${st.size}`);
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
  if (!project) throw new Error('Not a Gradle project');
  const root = project.dir;
  // Файлы, откуда берётся JDK, входят в сигнатуру: сменили его правкой config.properties —
  // список тасок надо перечитать, хотя build-файлы никто не трогал.
  const sig = await cacheSig(root);
  if (opts.refresh) tasksCache.delete(root);
  else {
    const hit = tasksCache.get(root);
    if (hit && hit.sig === sig) return hit.value;
  }
  const javaHome = await resolveJavaHome(root);
  const cmd = project.wrapper ? TASKS_CMD_WRAPPER : TASKS_CMD_GRADLE;
  const r =
    javaHome === null
      ? await runShell(cmd, root)
      : await runShell(JDK_EXPORT + cmd, root, processEnvWithJdk(javaHome));
  if (r.failed) {
    const tail = stderrTail(r.stderr) || stderrTail(r.stdout);
    throw new Error(`Gradle failed to list tasks${tail ? `:\n${tail}` : ''}`);
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
    // Номер символа вне диапазона Unicode оставляем как есть: fromCodePoint на нём
    // бросает, и один мусорный «&#…;» уронил бы разбор всего файла конфигураций.
    .replace(/&#(\d+);/g, (m, d: string) => {
      const code = Number(d);
      return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
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
  source: GradleRunConfigSource;
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
    return names.map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Лежит ли путь внутри корня (оба — уже реальные, после realpath). Единственная
 *  такая проверка на всю вкладку: порядок аргументов — «корень, потом путь». */
export function isInsideRoot(root: string, p: string): boolean {
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
      // Парсер не бросает: битый блок он обрывает и отдаёт разобранное до него.
      found.push(...parseRunConfigXml(xml, { projectDir: root, source }));
    }
  }

  const ws = await readCapped(path.join(root, '.idea', 'workspace.xml'), MAX_WORKSPACE_BYTES);
  if (ws !== null) found.push(...parseRunConfigXml(runManagerBlock(ws), { projectDir: root, source: 'workspace' }));

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
    if (!isInsideRoot(realRoot, realDir)) continue;
    out.push(c);
  }
  return out;
}

// ── Сборочная сессия и валидация ─────────────────────────────────────────────

/** Полный SHA-256 разделяет имена с одинаковым читаемым префиксом.
 *  Старые имена с шестизначным хешем намеренно не усыновляем и не удаляем:
 *  в них не было полной идентичности источника, доказать владение невозможно. */
export function buildSessionName(session: string): string {
  const safe = session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, BUILD_NAME_MAX);
  const hash = createHash('sha256').update(session, 'utf8').digest('hex');
  return `${BUILD_PREFIX}${safe}_${hash}`;
}

/** Сборочная ли это сессия — по префиксу (такие не показываются в списке сессий). */
export function isBuildSessionName(name: string): boolean {
  return name.startsWith(BUILD_PREFIX);
}

/** Имя таски: отвергаем всё, что не прошло, — не экранируем (§7 спецификации). */
export function checkTaskName(name: string): void {
  if (!TASK_RE.test(name)) throw new Error(`Invalid task name ${JSON.stringify(name)}`);
}

/** Аргументы запуска: каждый по регулярке, не больше MAX_ARGS штук. */
export function checkArgs(args: string[]): void {
  if (args.length > MAX_ARGS) throw new Error(`Too many arguments: ${args.length} > ${MAX_ARGS}`);
  for (const a of args) {
    if (!ARG_RE.test(a)) throw new Error(`Invalid argument ${JSON.stringify(a)}`);
  }
}

// ── Запуск сборки в tmux ─────────────────────────────────────────────────────

/** Пользовательские опции сборочной сессии: что запущено, когда и как зовут её
 *  оболочку в простое. Хранение в самой tmux-сессии, а не в памяти агента, —
 *  тогда после рестарта агента статус идущей сборки читается как ни в чём не бывало. */
const OPT_SOURCE = '@termhub_gradle_source';
const OPT_COMMAND = '@termhub_gradle_cmd';
const OPT_STARTED = '@termhub_gradle_started';
const OPT_SHELL = '@termhub_gradle_shell';

/** Хвост командной строки: без него код выхода не увидеть — сессия остаётся в оболочке. */
const EXIT_TAIL = "; printf '\\n[termhub] gradle exit=%s\\n' $?";

/** Оболочки: если в панели одна из них, сборка уже не идёт. Запасной вариант на
 *  случай, когда имя оболочки сессии не записалось (см. OPT_SHELL). */
const SHELL_COMMANDS = new Set(['zsh', 'bash', 'sh', 'dash', 'fish', 'ksh', '-zsh', '-bash', '-sh', 'login']);

/** Поиск gradle в PATH login-оболочки — строка КОНСТАНТНАЯ (см. шапку файла). */
const GRADLE_LOOKUP_CMD = 'command -v gradle';

/** Путь к wrapper из папки запуска: только «..» и само имя — имён каталогов в нём
 *  нет, поэтому метасимволам оболочки взяться неоткуда. */
const WRAPPER_REL_RE = /^(\.\.\/)*gradlew$/;

/** Сколько времени после отправки строка считается «уже запущенной», даже если в
 *  панели ещё оболочка: login-оболочка сессии успевает прочитать ~/.zshrc не мгновенно,
 *  и без этой отсрочки только что запущенная сборка отдавалась бы как finished.
 *  Настоящую сборку окно не задевает: gradlew занимает панель ещё на старте JVM. */
const START_GRACE_MS = 5000;

/** «Сборочной сессии нет» — каждый раз свежий объект: состояние уходит наружу и
 *  не должно оказаться общим для всех вызовов. */
function idleState(): GradleRunState {
  return { phase: 'idle', session: null, command: null, startedAt: null };
}

interface TmuxResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** tmux с изолированным сокетом (если задан). Отличается от приватного `tmux()` в
 *  SessionService контрактом ошибки: там неудача — исключение, здесь код возврата
 *  часть ответа (нет сборочной сессии — это не ошибка, а фаза `idle`), поэтому
 *  обёртка своя. Свести их в одну можно только вместе с правкой `sessions.ts`. */
function tmux(args: string[], socketName?: string): Promise<TmuxResult> {
  const full = socketName ? ['-L', socketName, ...args] : args;
  return new Promise((resolve) => {
    execFile('tmux', full, { encoding: 'utf8', maxBuffer: EXEC_MAX_BUFFER }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string }) | null;
      resolve({
        code: typeof e?.code === 'number' ? e.code : e ? 1 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

/** Цель tmux для команд, принимающих target-pane: `=<имя>:` — с двоеточием.
 *  Без двоеточия tmux ищет ПАНЕЛЬ с таким именем и не находит; «=» выключает
 *  поиск по префиксу имени. */
function paneTarget(name: string): string {
  return `=${name}:`;
}

/** Цель tmux для команд, принимающих target-session (kill-session): `=<имя>` — без
 *  двоеточия. «=» так же выключает поиск по префиксу имени. */
function sessionTarget(name: string): string {
  return `=${name}`;
}

export interface RunTargetOpts {
  /** Имя рабочей сессии — сборочная вычисляется из него. */
  session: string;
  /** Изолированный сокет tmux (в проде — config.TMUX_SOCKET). */
  socketName?: string;
}

/** Сборки, которым «Стоп» уже отправлял Ctrl+C: повторный «Стоп» при всё ещё живой
 *  команде убивает сессию совсем (история 18). Ставится и снимается только запуском
 *  и «Стопом» — статусный запрос состояние не трогает.
 *  Ключ — сокет И имя сборочной сессии: на разных сокетах (прод `termhub`, тестовый
 *  `termhub-test-…`) живут РАЗНЫЕ сборки, и одинаковое имя рабочей сессии не должно
 *  делать их одной. */
const stopSent = new Set<string>();

/** Base64 сохраняет полное имя, включая пробелы/табуляции, в одной колонке tmux. */
function sourceIdentity(session: string): string {
  return Buffer.from(session, 'utf8').toString('base64');
}

function stopKey(name: string, socketName?: string): string {
  return `${socketName ?? ''} ${name}`;
}

/** Идёт ли в панели что-то кроме оболочки. */
function isBusy(current: string, idleShell: string): boolean {
  if (current.length === 0) return false;
  if (idleShell.length > 0) return current !== idleShell;
  return !SHELL_COMMANDS.has(current);
}

/** Состояние сборки: idle — сборочной сессии нет, running — в панели идёт не
 *  оболочка, finished — сессия жива, команда отработала (вывод на месте).
 *  Запрос и только запрос: ничего в состоянии агента не меняет. */
export async function runStatus(opts: RunTargetOpts): Promise<GradleRunState> {
  const name = buildSessionName(opts.session);
  const fmt = `#{pane_current_command}\t#{${OPT_COMMAND}}\t#{${OPT_STARTED}}\t#{${OPT_SHELL}}\t#{${OPT_SOURCE}}`;
  const r = await tmux(['list-panes', '-t', paneTarget(name), '-F', fmt], opts.socketName);
  if (r.code !== 0) return idleState();
  let busy = false;
  let command = '';
  let started = '';
  for (const line of r.stdout.split('\n').filter((l) => l.length > 0)) {
    const [current = '', cmd = '', at = '', shell = '', source = ''] = line.split('\t');
    if (!cmd || source !== sourceIdentity(opts.session))
      throw new Error('Build session name is occupied by a session with unverified source identity');
    if (isBusy(current.trim(), shell.trim())) busy = true;
    if (cmd) command = cmd;
    if (at) started = at;
  }
  const at = Number(started);
  const startedAt = Number.isFinite(at) && at > 0 ? at : null;
  const justSent = startedAt !== null && Date.now() - startedAt < START_GRACE_MS;
  const phase: GradleRunPhase = busy || justSent ? 'running' : 'finished';
  return { phase, session: name, command: command || null, startedAt };
}

export interface StartRunOpts extends RunTargetOpts {
  /** Папка запуска — вызывающий уже проверил её вхождение в корень сессии. */
  dir: string;
  /** Корень проекта: там ищется wrapper (§6). По умолчанию — сама папка запуска. */
  root?: string;
  tasks: string[];
  args?: string[];
  /** Остановить идущую сборку и запустить новую. Без него идущая сборка не трогается. */
  force?: boolean;
}

/** Чем запускать: gradlew из КОРНЯ проекта (первым — как в IDEA), иначе gradle из
 *  PATH login-оболочки, иначе запускать нечем (§6 спецификации). Многомодульная
 *  сборка держит wrapper только в корне, а запуск идёт в подпапке (`subdir`,
 *  `externalProjectPath`) — поэтому корень адресуется относительным путём от папки
 *  запуска: `./gradlew` из корня, `../gradlew` из `<root>/app`. */
async function resolveGradle(root: string, dir: string): Promise<string> {
  if (await isExecutableFile(path.join(root, 'gradlew'))) {
    const rel = path.relative(dir, path.join(root, 'gradlew'));
    if (!WRAPPER_REL_RE.test(rel))
      throw new Error('Run directory outside project root: gradlew is not addressable from there');
    return rel === 'gradlew' ? './gradlew' : rel;
  }
  const r = await runShell(GRADLE_LOOKUP_CMD, dir);
  if (!r.failed && r.stdout.trim().length > 0) return 'gradle';
  throw new Error('Neither ./gradlew nor gradle found');
}

/** Запускает таски в отдельной tmux-сессии и возвращает её состояние. */
export async function startRun(opts: StartRunOpts): Promise<GradleRunState> {
  const args = opts.args ?? [];
  if (opts.tasks.length === 0) throw new Error('No tasks selected');
  for (const t of opts.tasks) checkTaskName(t);
  checkArgs(args);

  const dir = path.resolve(opts.dir);
  const root = path.resolve(opts.root ?? opts.dir);
  const bin = await resolveGradle(root, dir);
  // JDK берём у проекта (§6): в окружении login-оболочки почти наверняка чужой.
  const javaHome = await resolveJavaHome(root);
  const name = buildSessionName(opts.session);
  const line = [bin, ...opts.tasks, ...args].join(' ');

  // Вторую сборку поверх идущей молча не запускаем: вызывающий сам решит, гасить
  // ли прежнюю (история 16), и придёт снова с force.
  const current = await runStatus(opts);
  if (current.phase === 'running' && !opts.force) return current;

  // Прежняя сборочная сессия (с выводом прошлого запуска) уступает место новой.
  if (current.phase !== 'idle')
    await tmux(['kill-session', '-t', sessionTarget(name)], opts.socketName);
  // Путь к JDK едет отдельным argv-элементом `-e VAR=<путь>`: кавычки не нужны,
  // пробелы в «/Applications/Android Studio.app/…» ничего не ломают.
  const jdkArgs = javaHome === null ? [] : ['-e', `JAVA_HOME=${javaHome}`, '-e', `${JDK_ENV_VAR}=${javaHome}`];
  const created = await tmux(['new-session', '-d', '-s', name, '-c', dir, ...jdkArgs], opts.socketName);
  if (created.code !== 0)
    throw new Error(`Failed to create build session: ${created.stderr.trim() || created.code}`);
  // Новая сборка — новый счёт «Стопов»: первый снова шлёт Ctrl+C, а не убивает сессию.
  stopSent.delete(stopKey(name, opts.socketName));

  const startedAt = Date.now();
  const target = paneTarget(name);
  // Имя оболочки в простое — эталон для «идёт или закончилось» (см. isBusy).
  const idleShell = (await tmux(['display-message', '-p', '-t', target, '#{pane_current_command}'], opts.socketName)).stdout.trim();
  const tagged = await tmux(['set-option', '-t', target, OPT_SOURCE, sourceIdentity(opts.session)], opts.socketName);
  if (tagged.code !== 0) throw new Error('Failed to record build source identity');
  await tmux(['set-option', '-t', target, OPT_COMMAND, line], opts.socketName);
  await tmux(['set-option', '-t', target, OPT_STARTED, String(startedAt)], opts.socketName);
  if (idleShell) await tmux(['set-option', '-t', target, OPT_SHELL, idleShell], opts.socketName);
  // Команда уходит в login-оболочку сессии (§3): -l шлёт строку буквально, Enter — отдельно.
  await tmux(['send-keys', '-t', target, '-l', (javaHome === null ? '' : JDK_EXPORT) + line + EXIT_TAIL], opts.socketName);
  await tmux(['send-keys', '-t', target, 'Enter'], opts.socketName);

  return await runStatus(opts);
}

/** «Стоп»: первый вызов шлёт Ctrl+C, второй — при всё ещё живой команде — убивает
 *  сборочную сессию совсем (история 18). Уже завершившуюся сборку не трогаем:
 *  её вывод пользователю ещё нужен. */
export async function stopRun(opts: RunTargetOpts): Promise<GradleRunState> {
  const name = buildSessionName(opts.session);
  const key = stopKey(name, opts.socketName);
  const state = await runStatus(opts);
  if (state.phase !== 'running') {
    // Останавливать нечего — и счёт «Стопов» начинается заново.
    stopSent.delete(key);
    return state;
  }
  if (stopSent.has(key)) {
    await tmux(['kill-session', '-t', sessionTarget(name)], opts.socketName);
    stopSent.delete(key);
    return idleState();
  }
  stopSent.add(key);
  await tmux(['send-keys', '-t', paneTarget(name), 'C-c'], opts.socketName);
  return await runStatus(opts);
}
