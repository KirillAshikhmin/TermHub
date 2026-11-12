// Слэш-команды агента сессии для подсказок в поле ввода чата. Список собирается из трёх
// источников: встроенные команды из профиля агента, команды и навыки на диске (пользователя
// и проекта сессии) и — один раз на версию агента — то, что агент сам показывает по «/».
//
// Сверка с экраном шлёт клавиши в панель агента, поэтому идёт только когда агент ждёт ввода
// с ПУСТОЙ строкой, и всегда возвращает строку пустой. Набранное «/» стирается Backspace
// (строка непустая — ровно тот случай, когда клавиши профиля `clearInput` безопасны). Не
// уложилась в срок или в число нажатий, не вернула строку — результат не сохраняется и список
// отдаётся с `verified: false`; повторять сверку тут же нельзя — клавиши слать каждый запрос.
// Результат сверки хранится на хосте по агенту и версии: `commands-<агент>-<версия>.json`.
//
// Правило модуля то же, что у чата: «не распознали — молчим». Экран не распознан, агент
// работает, в строке текст — клавиш нет вовсе.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentId, ChatCommand, CommandsResult } from '@termhub/protocol/chat';

import { agentInfo, sessionLive, type LiveSources } from './agent-live.js';
import { profileOf, type AgentProfile } from './agent-profiles.js';
import { readPopup, readScreen } from './agent-screen.js';
import { resolve as resolvePane } from './agent-transcript.js';
import { capturePane, pasteText, sendKeys, type PaneShot } from './pane-io.js';
import { configDir } from './paths.js';
import { runTmux } from './tmux-run.js';

/** Источники — шов подмены: живой tmux, определитель и часы. Каталоги команд читаются
 *  настоящей файловой системой под `home`. */
export interface CommandsSources extends LiveSources {
  /** Рабочий каталог панели: оттуда берутся проектные команды и навыки. */
  cwd(pane: string): Promise<string | undefined>;
  /** Монотонные часы, мс: по ним отсчитывается срок сверки. */
  now(): number;
  /** Где хранится результат сверки. По умолчанию — каталог настроек агента. */
  stateDir: string;
}

/** Сверка не дольше этого. */
const RECONCILE_MS = 5000;
/** …и не больше стольких нажатий. */
const MAX_PRESSES = 300;
/** Столько нажатий подряд без единого нового имени — конец списка (или он пошёл по кругу).
 *  Больше окна любого из агентов: пока указатель идёт по окну, новых имён нет. */
const STALL_PRESSES = 12;
/** Пауза между опросами экрана и ожидание перерисовки после нажатия. */
const STEP_MS = 50;
/** Сколько ждать, что список откроется или строка очистится. */
const OPEN_MS = 1500;
const CLEAR_MS = 1500;
/** Пауза между нажатиями стирания строки: в замере они шли раздельно. */
const KEY_GAP_MS = 300;
/** После неудачной сверки следующая не раньше, чем через это время. */
const RETRY_AFTER_MS = 10 * 60 * 1000;
const DOWN = '\x1b[B';
const BACKSPACE = '\x7f';

/** Предел каталога: файлов с описанием, глубина и длина подсказки. */
const MAX_FILES = 300;
const MAX_DEPTH = 4;
const HEAD_BYTES = 16 * 1024;
const HINT_LIMIT = 200;
const ARGS_LIMIT = 80;

const encoder = new TextEncoder();
const NAME_RE = /^[^\s\u0000-\u001f\u007f]{1,80}$/u;
const SEGMENT_RE = /^[\p{L}\p{N}_.@-]{1,64}$/u;
const VERSION_RE = /^[\w.+-]{1,40}$/;
const PANE_ID_RE = /%\d+$/;

/** Список команд агента сессии. Не бросает: любой сбой — причиной отказа. */
export async function sessionCommands(session: string, sources?: Partial<CommandsSources>): Promise<CommandsResult> {
  const src = withDefaults(sources);
  try {
    const live = await sessionLive(session, src);
    if (!live.ok) return { ok: false, reason: live.reason, detail: live.detail };
    const profile = profileOf(live.agent);
    const pane = await src.capture(session).then(
      (shot) => shot.pane,
      () => undefined,
    );
    const cwd = pane ? await src.cwd(pane).catch(() => undefined) : undefined;
    const base = withoutDuplicates([...profile.builtins, ...(await diskCommands(live.agent, src.home, cwd))]);
    const version = live.version !== undefined && VERSION_RE.test(live.version) ? live.version : undefined;
    // Без версии сверку не к чему привязать: каждый запрос слал бы клавиши заново.
    if (version === undefined) return { ok: true, commands: base, verified: false };

    const known = await readCache(src.stateDir, live.agent, version);
    if (known) return { ok: true, commands: withExtras(base, known), verified: true };
    // Агент занят или в его строке текст — сверка невозможна сейчас, а не вообще.
    if (live.screen.kind !== 'idle' || live.screen.input !== '') {
      return { ok: true, commands: base, verified: false };
    }
    const outcome = await reconcileOnce(src, session, live.agent, version, profile);
    if (!outcome) return { ok: true, commands: base, verified: false };
    const extras = outcome.seen.filter((c) => !base.some((b) => b.name === c.name));
    if (outcome.complete && outcome.clean) {
      await writeCache(src.stateDir, live.agent, version, extras);
      return { ok: true, commands: withExtras(base, extras), verified: true };
    }
    // Что успели увидеть — отдаём: команда с экрана реальна, даже если до конца не дошли.
    return { ok: true, commands: withExtras(base, extras), verified: false };
  } catch (err) {
    return { ok: false, reason: 'lookup-failed', detail: `cannot list commands of ${session}: ${describe(err)}` };
  }
}

function withoutDuplicates(list: ChatCommand[]): ChatCommand[] {
  const seen = new Set<string>();
  const out: ChatCommand[] = [];
  for (const cmd of list) {
    if (seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    out.push(cmd);
  }
  return out;
}

function withExtras(base: ChatCommand[], extras: ChatCommand[]): ChatCommand[] {
  return withoutDuplicates([...base, ...extras]);
}

// --- каталоги на диске -------------------------------------------------------------------------

/** Команды и навыки агента с диска. Нет каталога, файла без описания, битый frontmatter —
 *  пропускаются: список собирается без них. */
async function diskCommands(agent: AgentId, home: string, cwd: string | undefined): Promise<ChatCommand[]> {
  const out: ChatCommand[] = [];
  if (agent === 'claude') {
    if (cwd) out.push(...(await commandFiles(path.join(cwd, '.claude', 'commands'), 'project', '')));
    out.push(...(await commandFiles(path.join(home, '.claude', 'commands'), 'user', '')));
    out.push(...(await skillDirs(path.join(home, '.claude', 'skills'))));
    if (cwd) out.push(...(await skillDirs(path.join(cwd, '.claude', 'skills'))));
  } else {
    // Свои запросы Codex вызываются как `/prompts:<имя>`.
    out.push(...(await commandFiles(path.join(home, '.codex', 'prompts'), 'user', 'prompts:')));
  }
  return out;
}

/** Файлы `*.md` каталога команд: подкаталог — часть имени через «:». */
async function commandFiles(root: string, source: 'user' | 'project', prefix: string): Promise<ChatCommand[]> {
  const found: ChatCommand[] = [];
  const budget = { files: MAX_FILES };
  await walk(root, [], 0, budget, async (segments, file) => {
    const last = segments[segments.length - 1]!;
    if (!last.endsWith('.md')) return;
    const names = [...segments.slice(0, -1), last.slice(0, -3)];
    if (!names.every((n) => SEGMENT_RE.test(n))) return;
    const head = await frontmatterOf(file);
    const hint = hintOf(head?.description);
    if (!head || !hint) return;
    const args = clean(head['argument-hint'], ARGS_LIMIT);
    found.push({ name: `${prefix}${names.join(':')}`, hint, source, ...(args ? { args } : {}) });
  });
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Навыки: по каталогу на навык, описание — во frontmatter его `SKILL.md`. */
async function skillDirs(root: string): Promise<ChatCommand[]> {
  const found: ChatCommand[] = [];
  let entries: string[];
  try {
    entries = (await fsp.readdir(root)).slice(0, MAX_FILES);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const head = await frontmatterOf(path.join(root, entry, 'SKILL.md'));
    const hint = hintOf(head?.description);
    const named = head?.name && SEGMENT_RE.test(head.name) ? head.name : entry;
    if (!head || !hint || !SEGMENT_RE.test(named)) continue;
    found.push({ name: named, hint, source: 'skill' });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function walk(
  dir: string,
  segments: string[],
  depth: number,
  budget: { files: number },
  visit: (segments: string[], file: string) => Promise<void>,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (budget.files <= 0) return;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = await fsp.stat(full); // по ссылкам: каталог навыков часто лежит символической ссылкой
    } catch {
      continue;
    }
    if (stat.isDirectory()) await walk(full, [...segments, name], depth + 1, budget, visit);
    else if (stat.isFile()) {
      budget.files -= 1;
      await visit([...segments, name], full);
    }
  }
}

/** Шапка файла: пары `ключ: значение` между строками `---`. Нет открывающей или закрывающей
 *  черты — шапки нет (`null`): файл с оборванной шапкой в список не идёт. */
async function frontmatterOf(file: string): Promise<Record<string, string> | null> {
  let text: string;
  try {
    const handle = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
      text = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return null;
  const out: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const found = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!found) continue;
    let value = found[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      // Блочная запись: строки с отступом до следующего ключа.
      const parts: string[] = [];
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(' ');
    } else if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) {
      value = value.slice(1, -1);
      if (found[2]!.trim()[0] === '"') value = value.replace(/\\(["\\])/g, '$1');
    }
    out[found[1]!] = value;
  }
  return out;
}

function clean(value: string | undefined, limit: number): string {
  const line = (value ?? '').replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function hintOf(value: string | undefined): string {
  return clean(value, HINT_LIMIT);
}

// --- сверка с экраном ------------------------------------------------------------------------

interface Reconciled {
  /** Всё, что агент показал, по порядку. */
  seen: ChatCommand[];
  /** Список пройден до конца. */
  complete: boolean;
  /** Строка агента после сверки пуста. */
  clean: boolean;
}

const running = new Map<string, Promise<Reconciled | null>>();
const failedAt = new Map<string, number>();

/** Одна сверка на агента и версию: параллельные запросы ждут ту же, неудавшаяся не
 *  повторяется несколько минут. `null` — не пытались. */
function reconcileOnce(
  src: CommandsSources,
  session: string,
  agent: AgentId,
  version: string,
  profile: AgentProfile,
): Promise<Reconciled | null> {
  const key = `${src.stateDir}\u0000${src.socketName ?? ''}\u0000${agent}\u0000${version}`;
  const active = running.get(key);
  if (active) return active;
  const failed = failedAt.get(key);
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return Promise.resolve(null);
  const job = reconcile(src, session, profile).then((outcome) => {
    if (outcome && !(outcome.complete && outcome.clean)) failedAt.set(key, Date.now());
    return outcome;
  });
  running.set(key, job);
  const release = (): void => {
    if (running.get(key) === job) running.delete(key);
  };
  job.then(release, release);
  return job;
}

/** Набрать «/», пролистать список агента стрелкой вниз до конца, стереть набранное. Ни одного
 *  нажатия, пока экран свежего снимка не «ждёт ввода с пустой строкой». */
async function reconcile(src: CommandsSources, session: string, profile: AgentProfile): Promise<Reconciled | null> {
  const first = await src.capture(session);
  const screen = readScreen(first.lines, profile);
  if (screen.kind !== 'idle' || screen.input !== '') return null;
  const pane = first.pane;
  const press = (keys: string): Promise<void> => src.send(session, encoder.encode(keys), pane);
  /** Снимок той же панели; другая панель — экран чужой, дальше по нему не идём. */
  const look = async (): Promise<PaneShot | null> => {
    const shot = await src.capture(session);
    return shot.pane === pane ? shot : null;
  };
  const until = async (ok: (shot: PaneShot) => boolean, ms: number): Promise<PaneShot | null> => {
    for (let i = Math.ceil(ms / STEP_MS); i > 0; i--) {
      await src.sleep(STEP_MS);
      const shot = await look();
      if (shot && ok(shot)) return shot;
    }
    return null;
  };

  const seen = new Map<string, ChatCommand>();
  const take = (shot: PaneShot): number => {
    let fresh = 0;
    for (const row of readPopup(shot.lines, profile)) {
      if (!NAME_RE.test(row.name) || seen.has(row.name)) continue;
      seen.set(row.name, { name: row.name, ...(row.hint ? { hint: clean(row.hint, HINT_LIMIT) } : {}), source: 'screen' });
      fresh++;
    }
    return fresh;
  };

  let complete = false;
  let typed = false;
  try {
    await press('/');
    typed = true;
    const opened = await until((s) => readPopup(s.lines, profile).length > 0, OPEN_MS);
    if (opened) {
      take(opened);
      const start = src.now();
      let last = opened.lines.join('\n');
      let stalled = 0;
      for (let presses = 0; presses < MAX_PRESSES && src.now() - start <= RECONCILE_MS; presses++) {
        await press(DOWN);
        // Экран ещё не перерисован — подождать; не изменился и после этого — список кончился.
        let shot = await look();
        for (let wait = 0; shot && shot.lines.join('\n') === last && wait < 2; wait++) {
          await src.sleep(STEP_MS);
          shot = await look();
        }
        if (!shot) break;
        const key = shot.lines.join('\n');
        if (key === last) {
          complete = true;
          break;
        }
        last = key;
        if (readPopup(shot.lines, profile).length === 0) break;
        stalled = take(shot) > 0 ? 0 : stalled + 1;
        if (stalled >= STALL_PRESSES) {
          complete = true;
          break;
        }
      }
    }
  } catch {
    complete = false;
  }
  const isClean = typed ? await restore(src, profile, press, until, look) : true;
  return { seen: [...seen.values()], complete, clean: isClean };
}

/** Строка агента снова пуста: Backspace стирает набранное «/», а если не стёрло и в строке
 *  текст — клавиши профиля (они безопасны только на непустой строке). */
async function restore(
  src: CommandsSources,
  profile: AgentProfile,
  press: (keys: string) => Promise<void>,
  until: (ok: (shot: PaneShot) => boolean, ms: number) => Promise<PaneShot | null>,
  look: () => Promise<PaneShot | null>,
): Promise<boolean> {
  const empty = (shot: PaneShot): boolean => {
    const s = readScreen(shot.lines, profile);
    return s.kind === 'idle' && s.input === '';
  };
  try {
    await press(BACKSPACE);
    if (await until(empty, CLEAR_MS)) return true;
    const now = await look();
    if (!now) return false;
    const s = readScreen(now.lines, profile);
    // Только непустая строка на ожидании ввода: на пустой те же клавиши — меню отката у
    // Claude и выход у Codex.
    if (s.kind !== 'idle' || !s.input) return false;
    for (const key of profile.keys.clearInput) {
      await press(key);
      await src.sleep(KEY_GAP_MS);
    }
    return (await until(empty, CLEAR_MS)) !== null;
  } catch {
    return false;
  }
}

// --- сохранённое на хосте --------------------------------------------------------------------

function cachePath(dir: string, agent: AgentId, version: string): string {
  return path.join(dir, `commands-${agent}-${version}.json`);
}

/** Сохранённая сверка. Нет файла, не JSON, чужой агент или версия, мусор в списке — `null`. */
async function readCache(dir: string, agent: AgentId, version: string): Promise<ChatCommand[] | null> {
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(cachePath(dir, agent, version), 'utf8'));
    if (raw === null || typeof raw !== 'object') return null;
    const body = raw as Record<string, unknown>;
    if (body.agent !== agent || body.version !== version || !Array.isArray(body.commands)) return null;
    const out: ChatCommand[] = [];
    for (const item of body.commands) {
      if (item === null || typeof item !== 'object') return null;
      const cmd = item as Record<string, unknown>;
      if (typeof cmd.name !== 'string' || !NAME_RE.test(cmd.name)) return null;
      if (cmd.hint !== undefined && typeof cmd.hint !== 'string') return null;
      out.push({ name: cmd.name, ...(cmd.hint ? { hint: clean(cmd.hint as string, HINT_LIMIT) } : {}), source: 'screen' });
    }
    return out;
  } catch {
    return null;
  }
}

/** Сохраняет сверку: каталог 0700, файл 0600, замена целиком. Сбой записи сверке не мешает. */
async function writeCache(dir: string, agent: AgentId, version: string, commands: ChatCommand[]): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = cachePath(dir, agent, version);
    const temp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify({ agent, version, at: new Date().toISOString(), commands }), { mode: 0o600 });
    await fsp.rename(temp, target);
  } catch {
    // следующий запрос сверит заново
  }
}

// --- источники по умолчанию ------------------------------------------------------------------

function withDefaults(over?: Partial<CommandsSources>): CommandsSources {
  const home = over?.home ?? os.homedir();
  const socketName = over?.socketName;
  return {
    home,
    socketName,
    stateDir: over?.stateDir ?? (over?.home !== undefined ? path.join(over.home, '.termhub') : configDir()),
    capture: over?.capture ?? ((session) => capturePane(session, socketName)),
    send: over?.send ?? ((session, bytes, pane) => sendKeys(session, socketName, bytes, pane)),
    paste: over?.paste ?? ((session, text, pane) => pasteText(session, socketName, text, pane)),
    resolve: over?.resolve ?? ((pane) => resolvePane(pane, { home, socketName })),
    version: over?.version ?? agentInfo,
    sleep: over?.sleep ?? ((ms) => new Promise((wake) => setTimeout(wake, ms))),
    now: over?.now ?? (() => performance.now()),
    cwd: over?.cwd ?? ((pane) => paneCwd(pane, socketName)),
  };
}

/** Рабочий каталог панели по её номеру (`%N` из адреса `сессия:@окно.%панель`). */
async function paneCwd(pane: string, socketName: string | undefined): Promise<string | undefined> {
  const id = PANE_ID_RE.exec(pane)?.[0];
  if (!id) return undefined;
  const out = await runTmux(['display-message', '-p', '-t', id, '#{pane_current_path}'], { socketName, timeoutMs: 3000 });
  const dir = out.trim();
  return path.isAbsolute(dir) ? dir : undefined;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
