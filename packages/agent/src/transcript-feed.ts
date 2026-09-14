// Лента из транскрипта: файл беседы (Claude `.jsonl` или rollout Codex) превращается в
// страницу записей от старых к новым. Снаружи форматы неразличимы — на выходе одна и та
// же `FeedEntry`, различие остаётся полем `agent` страницы.
//
// Файл живой сессии весит мегабайты (замер 14.09.2026: 27 МБ у идущей сессии Claude),
// поэтому целиком он не читается никогда: страница берётся окном от известного места, а
// курсор — это смещение в байтах плюс признак файла (inode). Файлы обоих агентов только
// дописываются, поэтому смещение строки не меняется и курсор переживает дописывание.
//
// Что попадает в ленту, решено спецификацией (§2): реплики человека и агента, мышление
// отдельным видом, вызов инструмента одной строкой без вывода и служебные вехи. Список
// «что берём» явный: у Claude полтора десятка служебных типов записей и их число растёт
// с каждой версией, а виды ленты фиксированы.
//
// Роль в файле — не доказательство авторства: оба агента кладут вставки среды обычным
// сообщением с ролью человека (замер 14.09.2026: 2043 записи из 2699 у Claude — 75,7 %, и
// 11 334 из 12 324 у Codex — 92,0 %). Поэтому вид записи решают признаки вставки, а не поле
// роли: назвать `human` то, чего человек не писал, — соврать про говорящего.
//
// Ни tmux, ни сети, ни живого агента здесь нет: на вход путь и курсор, на выход страница.

import { open, type FileHandle } from 'node:fs/promises';
import type { AgentKind, FailureReason } from './agent-transcript.js';

/** Одна запись ленты — общая форма для обоих агентов. */
export interface FeedEntry {
  /** `uuid` у Claude, `payload.id` или `ordinal` у Codex, иначе смещение строки в байтах.
   *  Одна строка Claude может дать несколько записей (мышление + текст + вызов): первая
   *  берёт идентификатор строки, следующие — с суффиксом `#<номер>`. */
  id: string;
  /** Момент, epoch ms. Ноль — метки не было ни у этой записи, ни у соседей по окну. */
  at: number;
  kind: 'human' | 'agent' | 'thinking' | 'tool' | 'note';
  /** Текст записи. У `tool` — одна строка «что сделал». У `note` — подробность из
   *  источника либо пустая строка: саму веху называет `note`. */
  text: string;
  /** Имя инструмента — только у `kind: 'tool'`. */
  tool?: string;
  /** Что за веха — только у `kind: 'note'`. Код, а не фраза: слова подбирает экран. */
  note?: 'compacted' | 'interrupted' | 'error' | 'chain';
  /** Ветка подагента — только у Claude (`isSidechain`); на живых данных не заполняется, см.
   *  замер в `fromClaude`. */
  branch?: string;
  /** Текст обрезан по пределу записи. */
  truncated?: true;
}

/** Страница ленты. Поля `complete` и `live` сюда не входят: их отдаёт определитель
 *  (`resolve`), и приклеивает их тот, кто зовёт оба (`sessionFeed`). */
export interface FeedPage {
  ok: true;
  agent: AgentKind;
  entries: FeedEntry[];
  /** Курсоры краёв отданного куска: `head` — для запроса назад, `tail` — вперёд. */
  head: string;
  tail: string;
  /** Достигнуто начало файла / конец файла. */
  bof: boolean;
  eof: boolean;
  /** Сколько строк пропущено как неразобранные. */
  skipped: number;
}

export interface FeedFailure {
  ok: false;
  /** Причины определителя как есть плюс `cursor-stale`; новых слов для старых причин нет,
   *  и список не копируется — новая причина наверху доезжает сюда сама. Сам `readFeed`
   *  отвечает только `no-transcript`, `lookup-failed` и `cursor-stale`: `no-agent` и
   *  `unknown-format` приходят от определителя выше по цепочке. */
  reason: FailureReason | 'cursor-stale';
  detail: string;
}

export interface FeedOptions {
  /** По умолчанию 200, максимум 1000. */
  limit?: number;
  /** Курсоры взаимоисключающие; при нескольких сразу старшинство такое:
   *  `around`, затем `before`, затем `after`. */
  before?: string;
  after?: string;
  around?: string;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
/** Текст записи режется по 64 КиБ с пометкой `truncated`. Предел выбран замером на
 *  11 643 репликах владельца: медиана 7 Б, 99-й процентиль 7,8 КиБ, максимум 90 КБ —
 *  64 КиБ режут 0,02 % записей против 0,94 % у прежних 8 КиБ, и требование «реплики
 *  человека и агента целиком» остаётся выполненным. */
const TEXT_LIMIT = 64 * 1024;
/** Ответ не больше 1 МиБ: набрав его, чтение останавливается и отдаёт, что успело. Предел
 *  один на весь ответ ленты, поэтому его знает и тот, кто склеивает страницы файлов. */
export const RESPONSE_LIMIT = 1024 * 1024;
/** Аргумент в строке «что сделал» — подпись, а не содержимое. Предел 400 знаков выбран
 *  замером 14.09.2026 на 38 004 вызовах Codex и 27 728 вызовах Claude: после разбора обёртки
 *  песочницы медиана команды Codex — 140 знаков, p75 — 295, p90 — 569; у Claude медиана 254.
 *  Прежние 200 резали 36,3 % подписей Codex и 58,5 % подписей Claude — «короткий аргумент»
 *  почти всегда был обрезан; при 400 режется 14,9 % и 36,4 %, и это уже хвост составных команд
 *  и заданий подагенту, где дело названо в начале. Вдвое больший предел снял бы ещё 5 п.п. и
 *  перестал бы быть строкой. */
const ARG_LIMIT = 400;
/** Окно чтения: растёт удвоением, пока не наберёт записей. */
const WINDOW_MIN = 256 * 1024;
const WINDOW_MAX = 4 * 1024 * 1024;

/** Разбирает одну строку файла. Возвращает первую запись строки или `null`, если строки
 *  в ленте нет вовсе (служебная запись, вывод инструмента, неразобранная строка). */
export function parseLine(line: string, agent: AgentKind, offset = 0): FeedEntry | null {
  return classify(line, agent, offset).entries[0] ?? null;
}

/** Страница ленты по файлу и курсору. */
export async function readFeed(
  file: string,
  agent: AgentKind,
  opts: FeedOptions = {},
): Promise<FeedPage | FeedFailure> {
  let fh: FileHandle;
  try {
    fh = await open(file, 'r');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return { ok: false, reason: 'no-transcript', detail: `no transcript file ${file}` };
    return { ok: false, reason: 'lookup-failed', detail: `cannot open ${file}: ${String(e)}` };
  }
  try {
    const st = await fh.stat();
    const ino = Number(st.ino);
    const size = st.size;
    const limit = limitOf(opts.limit);
    // Курсоры взаимоисключающие; при нескольких сразу старшинство — around, before, after.
    const raw = opts.around ?? opts.before ?? opts.after;
    const at = raw === undefined ? size : cursorOf(raw, ino, size);
    if (at === null)
      return { ok: false, reason: 'cursor-stale', detail: `cursor ${raw} is not from ${file}` };
    if (opts.around !== undefined) {
      // Половина лимита до записи и половина от неё вперёд — окрестность найденного
      // места. На лимите в одну запись половины назад не остаётся вовсе, и назад тогда
      // не читается ничего: страница шире лимита — это уже не тот лимит.
      const half = Math.floor(limit / 2);
      const back =
        half > 0
          ? assemble(agent, ino, await backSlice(fh, agent, size, at, half), half, true)
          : null;
      const fwd = assemble(agent, ino, await fwdSlice(fh, agent, size, at, limit - half), limit - half, false);
      return {
        ok: true,
        agent,
        entries: [...(back?.entries ?? []), ...fwd.entries],
        head: back && back.entries.length > 0 ? back.head : fwd.head,
        tail: fwd.entries.length > 0 ? fwd.tail : (back?.tail ?? fwd.tail),
        bof: back ? back.bof : at === 0,
        eof: fwd.eof,
        skipped: (back?.skipped ?? 0) + fwd.skipped,
      };
    }
    if (opts.after !== undefined)
      return assemble(agent, ino, await fwdSlice(fh, agent, size, at, limit), limit, false);
    // Хвост и `before` — одно и то же окно, растущее назад: у хвоста оно от конца файла.
    return assemble(agent, ino, await backSlice(fh, agent, size, at, limit), limit, true);
  } catch (e) {
    return { ok: false, reason: 'lookup-failed', detail: `cannot read ${file}: ${String(e)}` };
  } finally {
    await fh.close();
  }
}

/** Действующий предел записей: по умолчанию 200, максимум 1000 (§5). Считается здесь и
 *  только здесь — иначе «столько же записей» в двух модулях означало бы разное. */
export function limitOf(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

/** Курсор — `<inode>:<offset>`. Признак файла нужен, чтобы смещение не пережило смену
 *  сессии в панели и не попало в середину чужой беседы. Не совпал inode, не разобрался
 *  курсор или смещение ушло за конец файла (файл только дописывается — значит это другой
 *  файл) — `cursor-stale`, и клиент берёт хвост заново. Цепочку файлов проверяет тот, кто
 *  её знает: здесь виден ровно один файл. */
function cursorOf(raw: string, ino: number, size: number): number | null {
  const parts = /^(\d+):(\d+)$/.exec(raw);
  if (!parts) return null;
  if (Number(parts[1]) !== ino) return null;
  const offset = Number(parts[2]);
  return offset > size ? null : offset;
}

// --- окно чтения ---------------------------------------------------------------------

/** Строка файла с её местом: смещения нужны и курсору, и запасному идентификатору. */
interface Row {
  start: number;
  end: number;
  entries: FeedEntry[];
  broken: boolean;
}

/** Кусок ленты: строки окна плюс то, что окно успело увидеть о краях файла. */
interface Slice {
  rows: Row[];
  /** Окно началось с нулевого байта. */
  atStart: boolean;
  /** Окно дочитано до конца файла. */
  atEnd: boolean;
  /** Смещение первой целой строки окна и смещение за последней. */
  firstStart: number;
  lastEnd: number;
}

/** Окно назад от `end`: 256 КиБ, при нехватке записей удваивается до 4 МиБ. Удвоение
 *  дочитывает только новый кусок и приклеивает к уже разобранному: перечитывать и
 *  перерабатывать окно на каждом удвоении дороже самого чтения: на живом rollout Codex в
 *  94 МБ хвост так стоил 29 мс вместо 9 мс (замер 14.09.2026). */
async function backSlice(
  fh: FileHandle,
  agent: AgentKind,
  size: number,
  end: number,
  limit: number,
): Promise<Slice> {
  let win = WINDOW_MIN;
  let bound = end;
  let rows: Row[] = [];
  for (;;) {
    const from = Math.max(0, end - win);
    const seg = linesOf(await window(fh, from, bound), from, agent, from > 0);
    rows = seg.rows.concat(rows);
    const atStart = from === 0;
    if (atStart || win >= WINDOW_MAX || counted(rows) >= limit)
      // Строк не нашлось вовсе — окно целиком внутри одной строки длиннее своего потолка.
      // Тогда левый край просмотренного куска и есть новый курсор: страница пуста, но
      // следующий запрос начнётся за этим куском, а не на том же месте.
      return {
        rows,
        atStart,
        atEnd: end >= size,
        firstStart: rows.length > 0 ? rows[0].start : from,
        lastEnd: rows.length > 0 ? rows[rows.length - 1].end : end,
      };
    // Следующий кусок кончается там, где началась первая целая строка этого: байты перед
    // ней — обрезанная строка, её целая половина лежит как раз в новом куске.
    bound = seg.rows.length > 0 ? seg.rows[0].start : bound;
    win *= 2;
  }
}

/** Окно вперёд от `start` тем же размером: курсор всегда указывает на начало строки. */
async function fwdSlice(
  fh: FileHandle,
  agent: AgentKind,
  size: number,
  start: number,
  limit: number,
): Promise<Slice> {
  let win = WINDOW_MIN;
  let from = start;
  // Курсор, шагнувший через строку длиннее окна, стоит в её середине. Её обрывок — хвост
  // перешагнутой строки, а не битая строка файла: он отбрасывается, как первая строка
  // окна, растущего назад, и в счётчик пропущенных не идёт. Той же проверкой отсекается
  // и курсор, присланный клиентом мимо границы строки.
  let dropFirst = start > 0 && !(await startsLine(fh, start));
  let rows: Row[] = [];
  for (;;) {
    const to = Math.min(size, start + win);
    const seg = linesOf(await window(fh, from, to), from, agent, dropFirst);
    rows = rows.concat(seg.rows);
    if (to >= size || win >= WINDOW_MAX || counted(rows) >= limit)
      // Пусто и не дочитано до конца файла — та же строка-переросток: курсор уходит за
      // просмотренный кусок. Пусто у конца файла — другое дело: там строка ещё пишется,
      // и курсор обязан остаться перед ней, иначе её начало уедет мимо ленты.
      return {
        rows,
        atStart: start === 0,
        atEnd: to >= size,
        firstStart: rows.length > 0 ? rows[0].start : start,
        lastEnd:
          rows.length > 0 ? rows[rows.length - 1].end : to >= size ? start : to,
      };
    // Недописанный хвост куска — начало строки, которая целиком попадёт в следующий.
    if (seg.lastEnd >= 0) {
      from = seg.lastEnd;
      dropFirst = false;
    }
    win *= 2;
  }
}

/** Стоит ли смещение на начале строки: байт перед ним — перевод строки. */
async function startsLine(fh: FileHandle, at: number): Promise<boolean> {
  const buf = Buffer.alloc(1);
  const r = await fh.read(buf, 0, 1, at - 1);
  return r.bytesRead === 1 && buf[0] === 10;
}

function counted(rows: Row[]): number {
  let n = 0;
  for (const row of rows) n += row.entries.length;
  return n;
}

async function window(fh: FileHandle, from: number, to: number): Promise<Buffer> {
  const len = Math.max(0, to - from);
  if (len === 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const r = await fh.read(buf, got, len - got, from + got);
    if (r.bytesRead === 0) break;
    got += r.bytesRead;
  }
  return got === len ? buf : buf.subarray(0, got);
}

/** Режет кусок на целые строки и разбирает каждую. Первая строка куска, растущего назад,
 *  почти всегда обрезана — она отбрасывается, кроме случая, когда кусок начинается с
 *  начала файла. Хвост без перевода строки — либо продолжение файла за куском, либо
 *  строка, которую агент прямо сейчас дописывает: это не поломка, а «ещё не строка». */
function linesOf(
  buf: Buffer,
  from: number,
  agent: AgentKind,
  dropFirst: boolean,
): { rows: Row[]; lastEnd: number } {
  const rows: Row[] = [];
  let pos = 0;
  let first = true;
  let lastEnd = -1;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const start = from + pos;
    const end = from + nl + 1;
    if (!(first && dropFirst)) {
      const parsed = classify(buf.toString('utf8', pos, nl), agent, start);
      rows.push({ start, end, entries: parsed.entries, broken: parsed.broken });
    }
    first = false;
    lastEnd = end;
    pos = nl + 1;
  }
  return { rows, lastEnd };
}

/** Собирает страницу из куска: обрезает по лимиту, восстанавливает метки, ставит края.
 *  Записи одной строки не делятся между страницами — курсор всегда стоит на границе
 *  строки, поэтому строка с несколькими записями целиком либо входит, либо нет. */
function assemble(
  agent: AgentKind,
  ino: number,
  slice: Slice,
  limit: number,
  fromBack: boolean,
): FeedPage {
  const rows = slice.rows;
  // Обрезка по лимиту и потолку ответа — один проход; направление задаёт шаг. Записи
  // одной строки не делятся между страницами, поэтому строка входит целиком либо никак,
  // и первая строка берётся всегда: иначе страница была бы пуста, а курсор — на месте.
  const step = fromBack ? -1 : 1;
  let taken = 0;
  let bytes = 0;
  let edge = -1;
  for (let i = fromBack ? rows.length - 1 : 0; i >= 0 && i < rows.length; i += step) {
    const weight = rows[i].entries.reduce((n, e) => n + weigh(e), 0);
    if (taken > 0 && (taken + rows[i].entries.length > limit || bytes + weight > RESPONSE_LIMIT))
      break;
    taken += rows[i].entries.length;
    bytes += weight;
    edge = i;
  }
  const firstIdx = fromBack && edge >= 0 ? edge : 0;
  const lastIdx = fromBack ? rows.length - 1 : edge;
  const entries: FeedEntry[] = [];
  let skipped = 0;
  let head = -1;
  let tail = -1;
  for (let i = firstIdx; i <= lastIdx && i < rows.length; i += 1) {
    const row = rows[i];
    if (row.broken) skipped += 1;
    if (row.entries.length === 0) continue;
    if (head < 0) head = row.start;
    tail = row.end;
    entries.push(...row.entries);
  }
  fillTimes(entries);
  // Страница без записей всё равно двигает курсор: назад — к началу просмотренного куска,
  // вперёд — за последнюю просмотренную строку. Иначе клиент, упёршийся в строку длиннее
  // окна, листал бы одно и то же место, а записи по ту сторону остались бы недостижимы.
  return {
    ok: true,
    agent,
    entries,
    head: `${ino}:${head < 0 ? slice.firstStart : head}`,
    tail: `${ino}:${tail < 0 ? slice.lastEnd : tail}`,
    bof: slice.atStart && firstIdx <= 0,
    eof: slice.atEnd && lastIdx >= rows.length - 1,
    skipped,
  };
}

/** Метки времени: нет у записи — берётся от предыдущей записи окна, а для первых в окне —
 *  от ближайшей следующей, у которой она есть. Ноль остаётся, только если метки нет ни у
 *  одной записи окна: на живых данных такого не встречено ни разу. */
function fillTimes(entries: FeedEntry[]): void {
  let prev = 0;
  for (const e of entries) {
    if (e.at > 0) prev = e.at;
    else if (prev > 0) e.at = prev;
  }
  let next = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].at > 0) next = entries[i].at;
    else if (next > 0) entries[i].at = next;
  }
}

// --- разбор строки -------------------------------------------------------------------

interface Parsed {
  entries: FeedEntry[];
  broken: boolean;
}

/** Общее у всех записей строки: идентификатор, метка и ветка. */
interface Base {
  id: string;
  at: number;
  branch?: string;
}

function classify(line: string, agent: AgentKind, offset: number): Parsed {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { entries: [], broken: false };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { entries: [], broken: true };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { entries: [], broken: true };
  const rec = raw as Record<string, unknown>;
  return {
    entries: agent === 'claude' ? fromClaude(rec, offset) : fromCodex(rec, offset),
    broken: false,
  };
}

// --- вставки среды ---------------------------------------------------------------------

/** Обёртки, которыми среда кладёт своё сообщение в файл под ролью человека. Список признаков,
 *  а не одно выражение на все случаи: каждая форма названа отдельно и посчитана на живых
 *  данных владельца 14.09.2026 — 78 бесед `~/.claude/projects` (без каталогов `subagents`)
 *  и 328 файлов `~/.codex/sessions`. Срабатываний: `task-notification`
 *  3105, `environment_context` 480, `command-name` и `command-message` по 170, `command-args`
 *  160, `local-command-stdout` 82, `recommended_plugins` 78, `turn_aborted` 35, `bash-input`,
 *  `bash-stdout` и `bash-stderr` по 11, `user_shell_command` 2. `system-reminder` и
 *  `local-command-stderr` в тех записях, которые лента берёт, не встретились ни разу:
 *  `system-reminder` живёт в служебных записях (3565) и в выводе инструмента (95), а их лента
 *  не читает вовсе. Обе формы названы здесь как члены той же семьи. */
const ENV_TAGS = [
  'task-notification',
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'environment_context',
  'recommended_plugins',
  'turn_aborted',
  'user_shell_command',
];
const ENV_TAG_RE = new RegExp(`<(${ENV_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g');
/** Пометка о прерывании, которую дописывает сам CLI: 18 записей. Тем же прерыванием с полем
 *  `interruptedMessageId` лента уже занялась выше — это его бесполезный близнец без поля. */
const ENV_MARK_RE = /\[Request interrupted by user[^\]]*\]/g;
/** Свалки, которые приезжают в роли человека целиком и тегов вокруг себя не имеют: история
 *  подагента, подкладываемая Codex под оценку (9455 записей), и дамп AGENTS.md (305 записей,
 *  медиана 14,8 КиБ). Признаков два — зачин И маркер её тела, потому что зачина мало: «# AGENTS.md
 *  instructions — почему не применяются?» человек пишет сам, и по одному зачину его вопрос исчез
 *  бы из ленты молча. Маркер тела замером 14.09.2026 есть у всех свалок до одной: `>>> APPROVAL
 *  REQUEST` у 9455 историй из 9455, `<INSTRUCTIONS>` у 305 дампов из 305. Порог по объёму на эту
 *  роль не годится: свалки начинаются с 281 Б, и при пороге 4 КиБ в ленту уехали бы 3444 из них. */
const ENV_DUMPS: Array<[RegExp, RegExp]> = [
  [/^The following is the Codex agent history\b/, />>> APPROVAL REQUEST/],
  [/^#\s*AGENTS\.md instructions\b/, /<INSTRUCTIONS>/],
];

/** Слова человека в записи, которую среда подписала его ролью: вставки снимаются, остаётся
 *  написанное им самим. Пусто — записи в ленте нет вовсе: назвать `human` то, чего человек не
 *  писал, значит соврать про говорящего. Вставка вперемешку со словами оставляет слова —
 *  на живых данных владельца таких записей сегодня ни одной, но правило держит границу там,
 *  где она проходит, а не там, где кончился сегодняшний замер. По той же причине свалка
 *  выбрасывает запись целиком только тогда, когда запись из неё и состоит: разделить свалку и
 *  слова нечем — закрывающего тега у неё нет, — поэтому она опознаётся не зачином, а телом. */
function humanWords(text: string): string {
  const rest = text.replace(ENV_TAG_RE, '').replace(ENV_MARK_RE, '').trim();
  return ENV_DUMPS.some(([head, body]) => head.test(rest) && body.test(rest)) ? '' : rest;
}

function fromClaude(rec: Record<string, unknown>, offset: number): FeedEntry[] {
  const type = rec.type;
  if (type !== 'user' && type !== 'assistant') return [];
  const base: Base = { id: str(rec.uuid) || String(offset), at: stamp(rec.timestamp) };
  // Имя ветки — только `agentName`: `agentId` из соседнего поля читается человеком как
  // мусор, а поле ветки показывают ему. Имени нет — запись едет без ветки. Замер 14.09.2026:
  // сегодня ветка не заполняется никогда — в 78 корневых беседах владельца нет ни одной записи
  // с `isSidechain` (0 из 83 175), а `agentName` не встретился ни разу нигде. Беседы подагентов
  // лежат отдельными файлами `subagents/agent-*.jsonl` (1754 файла, 122 683 записи бокового
  // потока), которых лента не читает: `resolve` отдаёт ей файл беседы панели.
  if (rec.isSidechain === true && str(rec.agentName)) base.branch = str(rec.agentName);
  const message = rec.message as Record<string, unknown> | undefined;
  if (type === 'user') {
    // Вывод инструмента в ленту не идёт: запись `tool` уже сказала, что было сделано.
    if (rec.isMeta === true || rec.toolUseResult !== undefined) return [];
    const text = claudeText(message?.content);
    if (rec.isCompactSummary === true) return [note(base, 'compacted', text)];
    if (str(rec.interruptedMessageId)) return [note(base, 'interrupted', text)];
    const words = humanWords(text);
    return words ? [make(base, 0, 'human', words)] : [];
  }
  if (rec.isApiErrorMessage === true) return [note(base, 'error', claudeText(message?.content))];
  const content = message?.content;
  if (typeof content === 'string') return content.trim() ? [make(base, 0, 'agent', content)] : [];
  if (!Array.isArray(content)) return [];
  const out: FeedEntry[] = [];
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    const text = str(block.text);
    const thinking = str(block.thinking);
    if (block.type === 'text' && text.trim()) out.push(make(base, out.length, 'agent', text));
    else if (block.type === 'thinking' && thinking) out.push(make(base, out.length, 'thinking', thinking));
    else if (block.type === 'tool_use' && str(block.name))
      out.push(tool(base, out.length, str(block.name), argOf(block.input)));
  }
  return out;
}

function fromCodex(rec: Record<string, unknown>, offset: number): FeedEntry[] {
  const payload = (rec.payload ?? undefined) as Record<string, unknown> | undefined;
  const id =
    str(payload?.id) ||
    (typeof rec.ordinal === 'number' ? String(rec.ordinal) : '') ||
    String(offset);
  const base: Base = { id, at: stamp(rec.timestamp) };
  if (rec.type === 'compacted') return [note(base, 'compacted', str(payload?.message))];
  if (rec.type === 'event_msg')
    return payload?.type === 'error' ? [note(base, 'error', str(payload.message))] : [];
  if (rec.type !== 'response_item' || !payload) return [];
  if (payload.type === 'message') {
    // `developer` — это инструкции окружения, а не реплика человека.
    const kind = payload.role === 'user' ? 'human' : payload.role === 'assistant' ? 'agent' : null;
    if (!kind) return [];
    const text = kind === 'human' ? humanWords(codexText(payload.content)) : codexText(payload.content);
    return text ? [make(base, 0, kind, text)] : [];
  }
  if (payload.type === 'reasoning') {
    // Пустое мышление в ленту не едет вовсе: на живых данных владельца 14.09.2026 непустого
    // пересказа нет ни у одной из 53 265 записей `reasoning` в 328 файлах, а сами они — треть
    // страницы Codex (32,8 % из 162 200 записей ленты). Пустая строка «агент думал» — не
    // событие беседы, а её разбавление.
    const summary = codexSummary(payload);
    return summary ? [make(base, 0, 'thinking', summary)] : [];
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const name = str(payload.name);
    if (!name) return [];
    const args = payload.type === 'function_call' ? payload.arguments : payload.input;
    return [tool(base, 0, name, codexArg(args))];
  }
  return [];
}

// --- сборка записей ------------------------------------------------------------------

function make(base: Base, index: number, kind: FeedEntry['kind'], text: string): FeedEntry {
  const clipped = clip(text.trim());
  const entry: FeedEntry = {
    id: index === 0 ? base.id : `${base.id}#${index}`,
    at: base.at,
    kind,
    text: clipped.text,
  };
  if (base.branch) entry.branch = base.branch;
  if (clipped.truncated) entry.truncated = true;
  return entry;
}

/** Текст записи режется по 64 КиБ. Граница ищется по байтам и сдвигается назад до начала
 *  символа: иначе на месте разреза получился бы обломок многобайтной буквы. */
function clip(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= TEXT_LIMIT) return { text, truncated: false };
  const buf = Buffer.from(text, 'utf8');
  let end = TEXT_LIMIT;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.toString('utf8', 0, end), truncated: true };
}

/** Вес записи в ответе: текст плюс ключи и служебные поля вокруг него. Оценка, а не
 *  точный размер JSON — она сторожит потолок ответа, и считать её точно значило бы
 *  сериализовать каждую запись дважды. */
export function weigh(entry: FeedEntry): number {
  return Buffer.byteLength(entry.text) + Buffer.byteLength(entry.id) + Buffer.byteLength(entry.tool ?? '') + 80;
}

/** Веха беседы. Подробность из источника проходит тот же фильтр, что и реплика человека:
 *  строка, объявленная шумом в записи человека, не становится содержимым оттого, что приехала
 *  вехой, и поле `note` не повторяется словами. Прерыванию после этого остаётся пустой текст —
 *  замер 14.09.2026: у всех 20 вех прерывания владельца текст состоял только из маркера
 *  `[Request interrupted by user]`, своей подробности не было ни у одной. */
function note(base: Base, what: NonNullable<FeedEntry['note']>, text: string): FeedEntry {
  const entry = make(base, 0, 'note', humanWords(text));
  entry.note = what;
  return entry;
}

function tool(base: Base, index: number, name: string, arg: string): FeedEntry {
  const entry = make(base, index, 'tool', arg ? `${name} ${arg}` : name);
  entry.tool = name;
  return entry;
}

/** Первый аргумент, который человек узнаёт: путь файла, команда, образец поиска, адрес,
 *  задание подагенту. Ничего из перечисленного нет — остаётся одно имя инструмента.
 *  `cmd` — та же «команда»: так её называет `exec_command` Codex на живых данных. */
const ARG_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'cmd', 'pattern', 'url', 'description'];

function argOf(input: unknown): string {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('{')) {
      try {
        return argOf(JSON.parse(trimmed));
      } catch {
        /* не JSON — значит сам аргумент, вроде тела патча */
      }
    }
    return cut(trimmed.split('\n')[0]);
  }
  if (input === null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    // Массивом приходит команда оболочки Codex (`command: ["bash","-lc","…"]`): для
    // подписи это та же одна строка, склеенная пробелами.
    const raw = obj[key];
    const value = Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').join(' ') : str(raw);
    if (value.trim()) return cut(value);
  }
  return '';
}

/** Команда внутри скрипта песочницы: `tools.exec_command({cmd:"…"})`; ключ бывает и в
 *  кавычках (`{"cmd":"…"}`), а вызовов в одном скрипте бывает несколько — их до восьми. */
const SCRIPT_CMD_RE = /["'`]?\bcmd["'`]?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
/** Заголовок патча в том же скрипте: сам патч — содержимое, делом его делает путь файла. */
const SCRIPT_PATCH_RE = /\*\*\* (?:Add|Update|Delete) File: *([^\n\\]+)/g;

/** Подпись вызова у Codex. Аргумент приезжает либо объектом JSON (его разбирает `argOf`), либо
 *  скриптом песочницы: `const r = await tools.exec_command({cmd:"git commit …"})`. Первая
 *  строка такого скрипта — обёртка, а не дело, поэтому команда достаётся признаками по замеру
 *  14.09.2026 на 32 929 вызовах `exec` владельца: `cmd` находится у 23 468 (71,3 %), заголовок
 *  патча — ещё у 4 345 (13,2 %). Остальные 5 116 (15,5 %) — ввод в идущую сессию
 *  (`write_stdin`), поиск в сети и массив команд без ключа `cmd`: там первая строка скрипта и
 *  есть всё, что о вызове известно. */
function codexArg(input: unknown): string {
  if (typeof input !== 'string' || input.trim().startsWith('{')) return argOf(input);
  const commands: string[] = [];
  let found: RegExpExecArray | null;
  SCRIPT_CMD_RE.lastIndex = 0;
  while ((found = SCRIPT_CMD_RE.exec(input)) !== null) commands.push(unquote(found[1]));
  if (commands.length) return cut(commands.join(' ; '));
  const files: string[] = [];
  SCRIPT_PATCH_RE.lastIndex = 0;
  while ((found = SCRIPT_PATCH_RE.exec(input)) !== null) files.push(found[1].trim());
  if (files.length) return cut(`apply_patch ${files.join(' ')}`);
  return argOf(input);
}

/** Строковая постоянная скрипта в обычный текст: перевод строки и табуляция — пробелом (подпись
 *  однострочна), прочая экранировка снимается как есть. */
function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, (_whole, ch: string) => ('nrt'.includes(ch) ? ' ' : ch));
}

function cut(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > ARG_LIMIT ? `${line.slice(0, ARG_LIMIT)}…` : line;
}

// --- мелочи --------------------------------------------------------------------------

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(str(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Текст сообщения Claude: строка либо блоки `text`; всё остальное в текст не идёт. */
function claudeText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && str(block.text)) parts.push(str(block.text));
  }
  return parts.join('\n').trim();
}

/** Текст сообщения Codex: элементы `input_text` / `output_text`. */
function codexText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue;
    const part = item as Record<string, unknown>;
    if (str(part.text)) parts.push(str(part.text));
  }
  return parts.join('\n').trim();
}

/** Мышление Codex: пересказ в `summary`. На живых данных владельца он пуст всегда — непустого
 *  не встретилось ни разу (0 из 53 265 записей `reasoning` в 328 файлах, замер 14.09.2026):
 *  содержательная часть лежит зашифрованной в `encrypted_content`. Разбор оставлен на случай,
 *  когда пересказ включат, а пустую запись отбрасывает вызывающий. */
function codexSummary(payload: Record<string, unknown>): string {
  const summary = payload.summary;
  if (!Array.isArray(summary)) return codexText(payload.content);
  const parts: string[] = [];
  for (const item of summary) {
    if (typeof item === 'string') parts.push(item);
    else if (item !== null && typeof item === 'object' && str((item as Record<string, unknown>).text))
      parts.push(str((item as Record<string, unknown>).text));
  }
  const text = parts.join('\n\n').trim();
  return text || codexText(payload.content);
}
