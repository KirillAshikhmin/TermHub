// Определитель «панель tmux → файлы транскрипта агента»: по адресу панели отвечает,
// какой агент в ней работает и где лежат файлы его беседы. Содержимое транскриптов не
// читается — только первая строка rollout'а Codex, в которой лежит признак корневого
// потока. Ни ленты, ни интерфейса здесь нет: это первый из трёх шагов.
//
// Способа два, общего у них — только форма ответа:
//   Claude — реестр ~/.claude/sessions/<pid>.json, поле `tmux` = адрес панели;
//   Codex  — файлы, которые процесс панели и его потомки держат открытыми.
// Ни заголовок панели, ни рабочий каталог, ни время файла в привязке не участвуют: на
// живых данных они сессии не различают (заголовок пуст у двух панелей из семи, каталог
// общий у восьми сессий, пишутся все одновременно). Единственный различающий признак —
// адрес панели.
//
// Цепочки файлов здесь нет намеренно (D01). На живых данных 13.09.2026 проверено, что
// продолжение и форк сессии Claude КОПИРУЮТ прежнюю беседу в новый файл: у пары
// d2d64e42… → 353d6219… первые метки времени совпадают до миллисекунды. Связка при этом
// записана только в ПРЕЖНЕМ файле (`continued-in`, указывает вперёд), в новом о родителе
// нет ничего. Значит текущий файл и есть вся беседа, а пара «прежний плюс текущий» —
// дубль истории, который читателю пришлось бы разбирать. Поэтому `files` — список из
// одного файла текущей сессии, а разбора аргументов процесса в модуле нет вовсе.
//
// Дюжина панелей опрашивается подряд, поэтому общие источники берутся снимком на секунду:
// один обход реестра, один вызов ps и один list-panes на весь обход, а не на панель.

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { isExistingSessionName } from './sessions.js';

const exec = promisify(execFile);

export type AgentKind = 'claude' | 'codex';

/** Причина отказа. Пустой результат вместо причины не отдаётся никогда. */
export type FailureReason =
  /** В панели нет агента, пишущего транскрипт (голая оболочка, vim, чужая программа). */
  | 'no-agent'
  /** Агент есть, но его данные не в том виде, который мы понимаем. */
  | 'unknown-format'
  /** Посмотреть не удалось: права, недоступный обход открытых файлов, сбой инструмента. */
  | 'lookup-failed';

export interface TranscriptChain {
  ok: true;
  agent: AgentKind;
  /** Файлы беседы от самого раннего к текущему; сейчас — ровно один, текущий. */
  files: string[];
  /** Содержит ли файл беседу целиком. У Claude — всегда да: продолжение и форк копируют
   *  прежнюю беседу в новый файл (D01). У Codex — да, если у корневого потока нет
   *  `forked_from_id`: поле в формате есть (в живых данных владельца оно у 51 вложенного
   *  потока из 248 и ни у одного из 80 корневых), и с ним начало осталось в другом файле. */
  complete: boolean;
  /** Работает ли в панели тот процесс, который это писал. У Claude проверяется на каждом
   *  ответе по свежей таблице процессов, поэтому false там означает «запись реестра пережила
   *  своего агента»: файл верен, а панель занята уже чем-то другим. У Codex это состояние НА
   *  МОМЕНТ ОБХОДА и не старше срока кэша: pid оболочки не меняется ни когда агент в ней
   *  стартует, ни когда выходит, так что перепроверка стоила бы ровно того обхода, ради
   *  которого кэш и заведён. */
  live: boolean;
}

export interface TranscriptFailure {
  ok: false;
  reason: FailureReason;
  /** Человекочитаемая причина: уходит в лог и на экран следующего этапа. */
  detail: string;
}

export type TranscriptResult = TranscriptChain | TranscriptFailure;

/** Строка таблицы процессов: сам процесс, его родитель и время старта (локальная зона). */
export interface ProcessRow {
  pid: number;
  ppid: number;
  startedAt: Date;
}

/** Источники данных — единственный шов для тестов: реестр и файлы читаются через них,
 *  внешние программы (ps, tmux, lsof) тоже вызываются только отсюда. Три источника из
 *  пяти отдают всё разом: на дюжине панелей это постоянное число запусков. */
export interface TranscriptSources {
  /** Домашний каталог: корень каталогов обоих агентов. */
  home: string;
  /** Сокет tmux рабочих сессий (в проде — config.TMUX_SOCKET). */
  socketName?: string;
  /** Имена файлов каталога; нет каталога — пустой список, прочие ошибки наружу. */
  readDir(dir: string): Promise<string[]>;
  /** Начало файла: транскрипты весят мегабайты, целиком их не читаем. */
  readHead(file: string, maxBytes: number): Promise<string>;
  /** Есть ли такой обычный файл. */
  isFile(file: string): Promise<boolean>;
  /** Все процессы разом. Сбой опроса — исключение, а не пустая таблица: «процесса нет» и
   *  «посмотреть не удалось» — разные ответы. */
  processTable(): Promise<ProcessRow[]>;
  /** Адрес панели → pid запущенного в ней процесса, для всех панелей разом. */
  panePids(): Promise<Map<string, number>>;
  /** Пути файлов, открытых этими процессами. */
  openFiles(pids: number[]): Promise<string[]>;
}

/** Хвост адреса панели: «:@окно.%панель». Имя сессии перед ним проверяет общее с sessions.ts
 *  правило (там же оно применяется к гостевым ссылкам и WS-апгрейду): своя регулярка здесь
 *  уже разошлась с ним на дефисе и отвечала «формат незнаком» на живом имени сессии. */
const PANE_TAIL_RE = /^(.*):@\d+\.%\d+$/;
/** Идентификатор сессии Claude: из него получается имя файла, поэтому проверяем строго —
 *  это и есть защита от пути наружу, собранного по чужой записи реестра. */
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** Формат list-panes: адрес панели ровно в том виде, в каком его пишет в реестр Claude. */
const PANE_PID_FORMAT = '#{session_name}:#{window_id}.#{pane_id}\t#{pane_pid}';

const CLAUDE_REGISTRY_DIR = '.claude/sessions';
const CLAUDE_PROJECTS_DIR = '.claude/projects';
const CODEX_SESSIONS_DIR = '.codex/sessions';

/** Сколько читаем от файла: запись реестра — сотни байт, первая строка rollout'а — десятки КиБ. */
const HEAD_BYTES = 64 * 1024;
const EXEC_TIMEOUT_MS = 3000;
/** Обход открытых файлов мерялся в 0,4 с на панель — запас втрое. */
const LSOF_TIMEOUT_MS = 5000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
/** Допуск при сверке времён старта: обе стороны округляют до секунды. */
const START_TOLERANCE_MS = 2000;
/** Сколько живёт снимок общих источников: обход дюжины панелей укладывается в него целиком,
 *  а свежесть теряется не больше чем на секунду. */
const SNAPSHOT_TTL_MS = 1000;
/** Срок записи кэша обхода Codex. Числа из замера тут нет: замерена только цена обхода —
 *  около 0,4 с на панель, то есть примерно пять секунд на дюжину. Срок взят чуть больше
 *  периода, с которым веб опрашивает сессии (три секунды): короче — и каждый опрос платил
 *  бы полный обход, ради которого кэш и заведён; длиннее — и запуск агента в оболочке
 *  замечался бы на столько же позже, ведь pid оболочки при этом не меняется. Станет опрос
 *  чаще — срок по-прежнему его накрывает; станет реже срока — кэш перестанет помогать
 *  вовсе, и поднимать надо будет не это число наугад, а срок до периода опроса. */
const CODEX_CACHE_TTL_MS = 5000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

interface ClaudeEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  procStart?: string;
  startedAt: number;
}

/** Записи реестра про одну панель: годные и признак «была запись, да не разобралась». */
interface PaneRecords {
  entries: ClaudeEntry[];
  malformed: boolean;
}

/** Что реестр знает про панель: живой агент, запись без процесса и битая запись. */
interface ClaudeCandidates {
  alive?: ClaudeEntry;
  stale?: ClaudeEntry;
  malformed: boolean;
}

interface Snapshot {
  /** Момент, с которого считается срок: выставляется, когда очередное чтение ЗАВЕРШИЛОСЬ,
   *  а не когда снимок создан, — иначе источник медленнее срока устаревал бы на лету. */
  at: number;
  /** Сколько чтений этого снимка ещё идёт: пока их больше нуля, снимок не ротируется. */
  pending: number;
  /** Чей это снимок: с другими источниками он недействителен, даже пока не истёк. */
  owner?: TranscriptSources;
  registry?: Promise<Map<string, PaneRecords>>;
  processes?: Promise<Map<number, ProcessRow>>;
  panes?: Promise<Map<string, number>>;
}

/** Кэш дорогого обхода Codex: на панель, ключ — pid и время его старта. Срок обязателен:
 *  оболочка сохраняет свой pid, когда внутри неё запускают агента, поэтому ключ на такую
 *  подмену не реагирует и ответ «агента нет» иначе жил бы до полной очистки. */
const codexCache = new Map<string, { key: string; until: number; value: TranscriptResult | undefined }>();
let snapshot: Snapshot = { at: 0, pending: 0 };

function fail(reason: FailureReason, detail: string): TranscriptFailure {
  return { ok: false, reason, detail };
}

function found(agent: AgentKind, file: string, complete: boolean, live: boolean): TranscriptChain {
  return { ok: true, agent, files: [file], complete, live };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Стандартные источники: настоящие файловая система, ps, tmux и lsof. */
function withDefaults(over?: Partial<TranscriptSources>): TranscriptSources {
  const home = over?.home ?? os.homedir();
  const socketName = over?.socketName;
  return {
    home,
    socketName,
    readDir: over?.readDir ?? defaultReadDir,
    readHead: over?.readHead ?? defaultReadHead,
    isFile: over?.isFile ?? defaultIsFile,
    processTable: over?.processTable ?? defaultProcessTable,
    panePids: over?.panePids ?? panePidsFor(socketName),
    openFiles: over?.openFiles ?? defaultOpenFiles,
  };
}

async function defaultReadDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch (err) {
    // Каталога агента может не быть вовсе — это «агента нет», а не сбой. Остальное
    // (в том числе EACCES) уходит наружу и станет «определить не удалось».
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function defaultReadHead(file: string, maxBytes: number): Promise<string> {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function defaultIsFile(file: string): Promise<boolean> {
  try {
    return (await fsp.stat(file)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Вся таблица процессов одним вызовом: pid, родитель и время старта. Любая ошибка ps —
 *  сбой обхода и уходит наверх; пустой таблицы от живой системы не бывает. */
async function defaultProcessTable(): Promise<ProcessRow[]> {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,lstart='], {
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER,
  });
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line);
    if (!m) continue;
    const parts = parseStamp(m[3]);
    if (!parts) continue;
    // ps печатает время в локальной зоне — собираем момент по локальному календарю.
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      startedAt: new Date(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second),
    });
  }
  return rows;
}

/** Обёртка list-panes на конкретный сокет — одна и та же при каждом вызове: снимок
 *  сравнивает источники по функциям, и новая обёртка обнуляла бы его каждый раз. */
const panePidsBySocket = new Map<string, () => Promise<Map<string, number>>>();

function panePidsFor(socketName?: string): () => Promise<Map<string, number>> {
  const key = socketName ?? '';
  let fn = panePidsBySocket.get(key);
  if (!fn) {
    fn = () => defaultPanePids(socketName);
    panePidsBySocket.set(key, fn);
  }
  return fn;
}

async function defaultPanePids(socketName?: string): Promise<Map<string, number>> {
  const socket = socketName ? ['-L', socketName] : [];
  let stdout: string;
  try {
    ({ stdout } = await exec('tmux', [...socket, 'list-panes', '-a', '-F', PANE_PID_FORMAT], {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    }));
  } catch (err) {
    // Сервера tmux может не быть вовсе — тогда панелей нет; прочее — сбой обхода.
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    if (/no server running|error connecting|no such file or directory/i.test(stderr)) return new Map();
    throw err;
  }
  const panes = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const tab = line.lastIndexOf('\t');
    if (tab < 0) continue;
    const pid = Number(line.slice(tab + 1).trim());
    if (Number.isInteger(pid) && pid > 0) panes.set(line.slice(0, tab), pid);
  }
  return panes;
}

async function defaultOpenFiles(pids: number[]): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec('lsof', ['-w', '-p', pids.join(','), '-F', 'n'], {
      encoding: 'utf8',
      timeout: LSOF_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    }));
  } catch (err) {
    // lsof отвечает кодом 1, если часть pid уже умерла, — остальное он при этом печатает.
    const e = err as { stdout?: unknown; code?: unknown };
    if (typeof e.stdout === 'string') stdout = e.stdout;
    else if (e.code === 1) stdout = '';
    else throw err;
  }
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('n/'))
    .map((l) => l.slice(1));
}

interface Stamp {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Разбирает «Thu Sep  3 14:17:47 2026» на части. День недели не смотрим: в реестре он
 *  от UTC-даты и после сдвига зоны с локальной не совпадает (замер на живых данных:
 *  pid 47778 — «Sat Sep 12 22:47:27» в реестре против «Sun Sep 13 01:47:27» у ps). */
function parseStamp(text: string): Stamp | undefined {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return undefined;
  return {
    year: Number(m[6]),
    month,
    day: Number(m[2]),
    hour: Number(m[3]),
    minute: Number(m[4]),
    second: Number(m[5]),
  };
}

/** Тот ли это процесс: `procStart` реестра записан в UTC, а момент старта от ps собран по
 *  локальному календарю. Сравниваем моменты, а не строки, — иначе запись пережившей pid
 *  чужой сессии проходила бы проверку ровно на величину смещения зоны. */
function sameStart(procStart: string, startedAt: Date): boolean {
  const parts = parseStamp(procStart);
  if (!parts) return false;
  const registry = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  return Math.abs(registry - startedAt.getTime()) <= START_TOLERANCE_MS;
}

/** Каталог транскриптов Claude для рабочего каталога сессии: каждый символ вне [A-Za-z0-9]
 *  заменён дефисом (проверено на живых именах: «/Users/u/GitHub/Sprut.Hub_Tools» лежит в
 *  «-Users-u-GitHub-Sprut-Hub-Tools»). */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Лежит ли путь внутри каталога агента. Проверка лексическая: путь, пришедший снаружи,
 *  мы к файловой системе не подносим вовсе. */
function withinDir(file: string, dir: string): boolean {
  return path.resolve(file).startsWith(dir + path.sep);
}

function validPane(pane: string): boolean {
  const m = PANE_TAIL_RE.exec(pane);
  return m !== null && isExistingSessionName(m[1]);
}

/** Снимок общих источников: живёт SNAPSHOT_TTL_MS, поэтому обход дюжины панелей стоит
 *  одного чтения реестра, одного ps и одного list-panes. Берётся один раз на вызов resolve
 *  и дальше передаётся вниз: иначе реестр приезжал бы из одного снимка, а таблица процессов
 *  из следующего. Пока по снимку идут чтения, он не ротируется — медленный источник не
 *  должен превращать один обход в два. Снимок привязан к набору источников: пришли другие —
 *  прежние данные к ним отношения не имеют. */
function fresh(src: TranscriptSources): Snapshot {
  const now = Date.now();
  const expired = snapshot.pending === 0 && now - snapshot.at > SNAPSHOT_TTL_MS;
  if (expired || !sameSources(snapshot.owner, src)) snapshot = { at: now, pending: 0, owner: src };
  return snapshot;
}

/** Отмечает чтение снимка: срок начинает течь с его завершения. */
function track<T>(snap: Snapshot, read: Promise<T>): Promise<T> {
  snap.pending++;
  return read.finally(() => {
    snap.pending--;
    snap.at = Date.now();
  });
}

/** Те же ли это источники: сравниваем сами функции, а не объект-обёртку — её withDefaults
 *  собирает заново на каждый вызов, а функции при одних и тех же подменах те же самые. */
function sameSources(a: TranscriptSources | undefined, b: TranscriptSources): boolean {
  return (
    a !== undefined &&
    a.home === b.home &&
    a.socketName === b.socketName &&
    a.readDir === b.readDir &&
    a.readHead === b.readHead &&
    a.isFile === b.isFile &&
    a.processTable === b.processTable &&
    a.panePids === b.panePids &&
    a.openFiles === b.openFiles
  );
}

function registryOf(snap: Snapshot, src: TranscriptSources): Promise<Map<string, PaneRecords>> {
  return (snap.registry ??= track(snap, readRegistry(src)));
}

function processesOf(snap: Snapshot, src: TranscriptSources): Promise<Map<number, ProcessRow>> {
  return (snap.processes ??= track(
    snap,
    src.processTable().then((rows) => new Map(rows.map((r) => [r.pid, r]))),
  ));
}

function panesOf(snap: Snapshot, src: TranscriptSources): Promise<Map<string, number>> {
  return (snap.panes ??= track(
    snap,
    src.panePids().then((panes) => {
    // Панель исчезает вместе с сессией, и её запись в кэше больше никогда не понадобится.
      for (const pane of [...codexCache.keys()]) if (!panes.has(pane)) codexCache.delete(pane);
      return panes;
    }),
  ));
}

/** Разбирает запись реестра: адрес панели и поля сессии. undefined — записи не про панель
 *  (приписать её некуда), 'malformed' — адрес есть, а полей нет или они не те. */
function registryRecord(json: string): { pane: string; entry: ClaudeEntry | 'malformed' } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const { tmux, pid, sessionId, cwd } = rec;
  if (typeof tmux !== 'string' || tmux.length === 0) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return { pane: tmux, entry: 'malformed' };
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return { pane: tmux, entry: 'malformed' };
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return { pane: tmux, entry: 'malformed' };
  return {
    pane: tmux,
    entry: {
      pid,
      sessionId,
      cwd,
      procStart: typeof rec.procStart === 'string' ? rec.procStart : undefined,
      startedAt: typeof rec.startedAt === 'number' ? rec.startedAt : 0,
    },
  };
}

/** Весь реестр Claude за один обход: панель → её записи. */
async function readRegistry(src: TranscriptSources): Promise<Map<string, PaneRecords>> {
  const dir = path.join(src.home, CLAUDE_REGISTRY_DIR);
  const byPane = new Map<string, PaneRecords>();
  for (const name of await src.readDir(dir)) {
    if (!name.endsWith('.json')) continue;
    let body: string;
    try {
      body = await src.readHead(path.join(dir, name), HEAD_BYTES);
    } catch (err) {
      // Реестр самоочищается: запись могла исчезнуть между чтением каталога и файла.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const parsed = registryRecord(body);
    if (!parsed) continue;
    const slot = byPane.get(parsed.pane) ?? { entries: [], malformed: false };
    if (parsed.entry === 'malformed') slot.malformed = true;
    else slot.entries.push(parsed.entry);
    byPane.set(parsed.pane, slot);
  }
  return byPane;
}

/** Кандидаты из реестра Claude: живой агент панели и, отдельно, запись, пережившая свой
 *  процесс. Разделены намеренно — модуль отвечает, какой агент в панели РАБОТАЕТ, а
 *  мёртвая запись подошла бы разве что за неимением живого. Внутри каждой группы
 *  выигрывает более поздняя запись. */
async function claudeCandidates(
  pane: string,
  snap: Snapshot,
  src: TranscriptSources,
): Promise<ClaudeCandidates | undefined> {
  const slot = (await registryOf(snap, src)).get(pane);
  if (!slot) return undefined;
  const processes = await processesOf(snap, src);
  let alive: ClaudeEntry | undefined;
  let stale: ClaudeEntry | undefined;
  let malformed = slot.malformed;
  for (const entry of slot.entries) {
    const row = processes.get(entry.pid);
    if (!row) {
      // Агент завершился — запись ещё жива и путь в ней верен.
      if (!stale || entry.startedAt > stale.startedAt) stale = entry;
      continue;
    }
    // Живой процесс без времени старта отличить от переиспользовавшего pid нечем:
    // такую запись не берём и говорим про формат, а не про отсутствие агента.
    if (!entry.procStart) {
      malformed = true;
      continue;
    }
    if (!sameStart(entry.procStart, row.startedAt)) continue;
    if (!alive || entry.startedAt > alive.startedAt) alive = entry;
  }
  return { alive, stale, malformed };
}

/** Годится ли запись, пережившая своего агента. Мёртвый процесс сверить не с чем, поэтому
 *  сверяем панель: адрес вида «SprutApp:@0.%0» переиспользуется новым сервером tmux, а на
 *  живых данных владельца все девять записей реестра указывают на уже умершие процессы.
 *  Панель, которая моложе записи, к этой беседе отношения не имеет, а панели, которой уже
 *  нет, отвечать нечем. Запись без времени старта не проходит: сверить нечем. */
async function staleFits(
  pane: string,
  entry: ClaudeEntry,
  snap: Snapshot,
  src: TranscriptSources,
): Promise<boolean> {
  const pid = (await panesOf(snap, src)).get(pane);
  if (pid === undefined) return false;
  const row = (await processesOf(snap, src)).get(pid);
  const parts = entry.procStart ? parseStamp(entry.procStart) : undefined;
  if (!row || !parts) return false;
  const agentStart = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  return row.startedAt.getTime() <= agentStart + START_TOLERANCE_MS;
}

/** Файл беседы Claude: каталог — из рабочего каталога сессии, имя — из её идентификатора.
 *  Обе составляющие пришли из чужого файла, поэтому обе обезврежены до сборки пути:
 *  каталог кодируется посимвольно, идентификатор проверен SESSION_ID_RE. Полнота у Claude
 *  всегда подтверждена (D01), различается только «живость» записи. */
async function claudeFile(entry: ClaudeEntry, live: boolean, src: TranscriptSources): Promise<TranscriptResult> {
  const projects = path.join(src.home, CLAUDE_PROJECTS_DIR);
  const file = path.join(projects, encodeCwd(entry.cwd), `${entry.sessionId}.jsonl`);
  // Сам собранный путь проверяется тем же правилом, что и путь из открытых файлов Codex:
  // сегодня обе составляющие уже обезврежены по отдельности, поэтому ложным условие стать
  // не может, но защищать два пути по-разному значит держать одну из дверей приоткрытой.
  if (!withinDir(file, projects) || !(await src.isFile(file)))
    return fail('unknown-format', `Транскрипт сессии ${entry.sessionId} не лежит там, где его держит Claude: ${file}`);
  return found('claude', file, true, live);
}

interface CodexMeta {
  root: boolean;
  started: number;
  /** Поток отпочкован от другого: начало беседы осталось в том файле. */
  forked: boolean;
}

/** Первая строка rollout'а Codex: `session_meta`. Вложенный поток узнаётся по родителю и
 *  по `source.subagent`; у корневого `source` — строка «cli», родителя нет. */
function codexMeta(head: string): CodexMeta | undefined {
  const line = head.split('\n')[0] ?? '';
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== 'session_meta') return undefined;
  const payload =
    typeof rec.payload === 'object' && rec.payload !== null ? (rec.payload as Record<string, unknown>) : {};
  const source = payload.source;
  const nested =
    (typeof payload.parent_thread_id === 'string' && payload.parent_thread_id.length > 0) ||
    (typeof source === 'object' && source !== null && 'subagent' in (source as Record<string, unknown>));
  const stamp = Date.parse(String(payload.timestamp ?? rec.timestamp ?? ''));
  const forked = typeof payload.forked_from_id === 'string' && payload.forked_from_id.length > 0;
  return { root: !nested, started: Number.isFinite(stamp) ? stamp : 0, forked };
}

/** Процесс панели и все его потомки: у Codex rollout держит открытым не тот процесс, что
 *  запущен в панели, а его потомок (замер: node-обёртка не держит ничего). */
function descendants(root: number, processes: Map<number, ProcessRow>): number[] {
  const byParent = new Map<number, number[]>();
  for (const row of processes.values()) {
    const kids = byParent.get(row.ppid) ?? [];
    kids.push(row.pid);
    byParent.set(row.ppid, kids);
  }
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const kid of byParent.get(pid) ?? [])
      if (!seen.has(kid)) {
        seen.add(kid);
        queue.push(kid);
      }
  }
  return [...seen];
}

/** Способ второй: открытые файлы процесса панели. undefined — Codex в панели нет. */
async function codexThread(
  pid: number,
  processes: Map<number, ProcessRow>,
  src: TranscriptSources,
): Promise<TranscriptResult | undefined> {
  const root = path.join(src.home, CODEX_SESSIONS_DIR);
  const open = await src.openFiles(descendants(pid, processes));
  const files = open.filter((f) => withinDir(f, root) && f.endsWith('.jsonl')).sort();
  if (files.length === 0) return undefined;
  let best: { file: string; started: number; forked: boolean } | undefined;
  let metaSeen = false;
  for (const file of files) {
    let head: string;
    try {
      head = await src.readHead(file, HEAD_BYTES);
    } catch (err) {
      // Файл мог уйти вместе с завершившимся потоком — это не сбой обхода.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const meta = codexMeta(head);
    if (!meta) continue;
    metaSeen = true;
    if (!meta.root) continue;
    if (!best || meta.started > best.started) best = { file, started: meta.started, forked: meta.forked };
  }
  if (!best)
    return fail(
      'unknown-format',
      metaSeen
        ? `Codex держит открытыми только вложенные потоки: корневого среди ${files.length} файлов нет`
        : 'Первая строка транскрипта Codex — не session_meta: формат rollout не разобран',
    );
  // Корневой поток пишет живой процесс панели; отпочкованный от другого потока помечаем
  // неполным — начало беседы осталось в файле, из которого его отпочковали.
  return found('codex', best.file, !best.forked, true);
}

/** Обход открытых файлов стоит около 0,4 с на панель, а панелей дюжина: держим результат
 *  на панель с ключом из pid и времени его старта — сменился процесс, запись недействительна.
 *  Сбой обхода сюда не попадает: он летит исключением и кэш не трогает. */
async function tryCodex(pane: string, snap: Snapshot, src: TranscriptSources): Promise<TranscriptResult | undefined> {
  const pid = (await panesOf(snap, src)).get(pane);
  if (pid === undefined) return undefined;
  const processes = await processesOf(snap, src);
  const row = processes.get(pid);
  const key = `${pid}:${row ? row.startedAt.getTime() : 0}`;
  const hit = codexCache.get(pane);
  if (hit && hit.key === key && hit.until > Date.now()) return hit.value;
  const value = await codexThread(pid, processes, src);
  codexCache.set(pane, { key, until: Date.now() + CODEX_CACHE_TTL_MS, value });
  return value;
}

/** Какой агент работает в панели и где лежат файлы его беседы. Не бросает: любой сбой
 *  обхода возвращается причиной отказа. */
export async function resolve(pane: string, sources?: Partial<TranscriptSources>): Promise<TranscriptResult> {
  const src = withDefaults(sources);
  if (!validPane(pane))
    return fail('unknown-format', `Адрес панели «${pane}» не разобран: ожидается «сессия:@окно.%панель»`);
  // Ослепший способ не отменяет второго: пробуем оба и только потом отвечаем причиной.
  // «Посмотреть не удалось» важнее «агента нет» — подменять второе первым значит врать.
  // Снимок берётся один на весь обход и дальше не пересматривается.
  const snap = fresh(src);
  let blind: string | undefined;
  let claude: ClaudeCandidates | undefined;
  try {
    claude = await claudeCandidates(pane, snap, src);
  } catch (err) {
    blind = describe(err);
  }
  // Живой агент панели важнее всего остального.
  if (claude?.alive) return claudeFile(claude.alive, true, src);
  let codex: TranscriptResult | undefined;
  try {
    codex = await tryCodex(pane, snap, src);
  } catch (err) {
    blind ??= describe(err);
  }
  if (codex) return codex;
  // Запись, пережившая своего агента, идёт последней: живой обход Codex она обгонять не
  // должна, иначе панель отдаст беседу давно закрытой сессии как свою.
  if (claude?.stale)
    try {
      if (await staleFits(pane, claude.stale, snap, src)) return claudeFile(claude.stale, false, src);
    } catch (err) {
      blind ??= describe(err);
    }
  if (claude?.malformed)
    return fail('unknown-format', `Запись реестра Claude про панель ${pane} не разобрана: полей нет или они не те`);
  if (blind) return fail('lookup-failed', `Определить агента панели ${pane} не удалось: ${blind}`);
  return fail('no-agent', `В панели ${pane} нет агента, пишущего транскрипт`);
}

/** Сбрасывает и кэш обхода Codex, и снимок общих источников. */
export function clearCache(): void {
  codexCache.clear();
  snapshot = { at: 0, pending: 0 };
}
