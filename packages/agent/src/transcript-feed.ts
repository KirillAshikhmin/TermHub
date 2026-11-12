// Лента из транскрипта: файл беседы (Claude `.jsonl` или rollout Codex) превращается в
// страницу записей от старых к новым. Снаружи форматы неразличимы — на выходе одна и та
// же `FeedEntry`, различие остаётся полем `agent` страницы. Беседа opencode — не файл, а
// строки общей базы: страницу по ней собирает `opencode-feed`, а запись разбирает
// `fromOpencode` отсюда же, теми же правилами, что и два других формата.
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

import type { ToolDetail } from '@termhub/protocol/chat';

import type { AgentKind, FailureReason } from './agent-transcript.js';

/** Агенты, чья беседа — файл строк JSON: его и читает `readFeed`. */
export type FileAgent = Exclude<AgentKind, 'opencode'>;

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
  /** Что за веха — только у `kind: 'note'`. Код, а не фраза: слова подбирает экран.
   *  `agent-start`, `agent-done` и `agent-message` — события фоновых агентов Claude: у
   *  первых двух `text` — название задачи, у третьего — текст сообщения. */
  note?: 'compacted' | 'interrupted' | 'error' | 'chain' | 'agent-start' | 'agent-done' | 'agent-message';
  /** Описание действия словами агента (`input.description`) — только у `tool` и только
   *  когда оно не стало самой подписью. Режется тем же пределом, что аргумент. */
  desc?: string;
  /** Кто прислал сообщение — только у `agent-message` и только когда отправитель назван. */
  from?: string;
  /** Сколько работал фоновый агент, секунды — только у `agent-done`, когда уведомление
   *  несёт длительность. */
  elapsed?: number;
  /** Чем кончил фоновый агент, если не успехом, — только у `agent-done`. */
  outcome?: 'failed' | 'stopped';
  /** Место записи в файле — курсор той же формы `<inode>:<offset>`, что принимают `before`,
   *  `after` и `around`. Им экран прыгает к найденной записи (история 9.1): поиск держит в
   *  руках запись, а не курсор, и без этого поля адресовать её место нечем. У всех записей
   *  одной строки курсор общий — строка и есть единица чтения, окрестность у них одна.
   *  Ставит его страница: признак файла знает только она, поэтому `parseLine`, разбирающий
   *  строку в отрыве от файла, курсора не ставит. */
  cursor?: string;
  /** Ветка подагента — только у Claude (`isSidechain`); на живых данных не заполняется, см.
   *  замер в `fromClaude`. */
  branch?: string;
  /** Текст обрезан по пределу записи. */
  truncated?: true;
  /** У действия есть подробности (команда с выводом, diff правки): их отдаёт `readDetail`
   *  по курсору записи. Только у `tool` из файлов Claude и Codex. */
  detail?: true;
  /** Чем кончилось действие — только у `tool` из файлов Claude и Codex. Ставит страница по
   *  результату вызова, лежащему в том же окне; результата в окне нет и файл дочитан до
   *  конца — `running`; результата нет, а файл дальше — поля нет (неизвестно). */
  result?: ToolResult;
  /** Вопросы, заданные человеку этим вызовом (`AskUserQuestion` у Claude,
   *  `request_user_input` и `request_user_input_async` у Codex) — только у `tool`. Вид
   *  записи остаётся `tool`, а `text` несёт вопросы словами: клиент, не знающий поля,
   *  показывает прежнюю строку действия и вопроса не теряет. */
  questions?: FeedQuestion[];
  /** Сколько сообщений Codex оставил в новом окне без сжатия — только у веха `compacted`
   *  из файла Codex, и только когда есть что показать. Тексты в страницу не кладутся: их
   *  отдаёт `readDetail` по курсору вехи (`messages`). */
  retained?: { human: number; agent: number };
}

/** Одно сохранённое без сжатия сообщение — тело раскрытия вехи сжатия Codex. */
export interface RetainedMessage {
  role: 'human' | 'agent';
  text: string;
}

/** Один вопрос вызова. `answer` — данный ответ: подписи выбранных вариантов либо свой
 *  текст человека; поля нет — ответа в окне страницы не нашлось (ещё не дан либо лежит
 *  дальше). Откуда он берётся: Claude — `toolUseResult.answers` записи результата; Codex
 *  `request_user_input` — вывод вызова; `request_user_input_async` — более поздняя запись
 *  человека `<send_user_message_question_reply>` (вывод вызова там только `{accepted}`). */
export interface FeedQuestion {
  text: string;
  /** Короткий заголовок вопроса — у Claude и у синхронного вопроса Codex. */
  header?: string;
  /** Варианты; `hint` — пояснение (у асинхронного вопроса Codex пояснений нет). */
  options?: { label: string; hint?: string }[];
  /** Можно отметить несколько вариантов (`multiSelect` у Claude). */
  multi?: true;
  answer?: string[];
}

/** Исход действия. `exit` — код выхода команды, только когда транскрипт его назвал и он
 *  не нулевой: у Claude это строка «Exit code N» ошибочного результата Bash, у Codex —
 *  «Exit code: N» / «Process exited with code N» в начале вывода или `metadata.exit_code`
 *  старой обёртки. `stopped` — прервано человеком (`interrupted` в сводке Claude). */
export interface ToolResult {
  state: 'done' | 'running' | 'failed' | 'stopped';
  exit?: number;
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
  /** Причины определителя как есть плюс `cursor-stale` и `forbidden`; новых слов для
   *  старых причин нет, и список не копируется — новая причина наверху доезжает сюда
   *  сама. Сам `readFeed` отвечает только `no-transcript`, `lookup-failed` и
   *  `cursor-stale`: `no-agent` и `unknown-format` приходят от определителя выше по
   *  цепочке, а `forbidden` — от моста relay (`doFeed`), когда гость спросил чужую
   *  сессию. Лента её не порождает, но отвечает ею тем же телом: клиент разбирает
   *  причины одним списком, и слово обязано стоять там же, где остальные. */
  reason: FailureReason | 'cursor-stale' | 'forbidden';
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
export function parseLine(line: string, agent: FileAgent, offset = 0): FeedEntry | null {
  return classify(line, agent, offset).entries[0] ?? null;
}

/** Страница ленты по файлу и курсору. */
export async function readFeed(
  file: string,
  agent: FileAgent,
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
  const parts = CURSOR_RE.exec(raw);
  if (!parts) return null;
  if (Number(parts[1]) !== ino) return null;
  const offset = Number(parts[2]);
  return offset > size ? null : offset;
}

/** `<inode>:<offset>`, а у второго и следующих действий одной строки — ещё `#<номер>`
 *  (номер действия в строке, с нуля; у первого его нет). Место в файле номер не меняет:
 *  прыжок и страница по такому курсору — те же, что по курсору строки. */
const CURSOR_RE = /^(\d+):(\d+)(?:#(\d{1,3}))?$/;

/** Номер действия в строке, на которое указывает курсор. */
function toolIndexOf(raw: string): number {
  return Number(CURSOR_RE.exec(raw)?.[3] ?? 0);
}

// --- окно чтения ---------------------------------------------------------------------

/** Строка файла с её местом: смещения нужны и курсору, и запасному идентификатору. */
interface Row {
  start: number;
  end: number;
  entries: FeedEntry[];
  broken: boolean;
  /** Результат вызова, если строка — вывод инструмента. */
  result?: { id: string; mark: ToolResult };
  answers?: Answer[];
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
  agent: FileAgent,
  size: number,
  end: number,
  limit: number,
): Promise<Slice> {
  let win = WINDOW_MIN;
  let bound = end;
  let rows: Row[] = [];
  // Курсор посреди строки ставит только шаг через строку длиннее окна. Её начало тогда —
  // последний обрывок этого куска: целиком строку не прочесть, но веху по её началу
  // поставить можно (`oversized`).
  let stepped = end > 0 && end < size && !(await startsLine(fh, end));
  let mark: Row | undefined;
  for (;;) {
    const from = Math.max(0, end - win);
    const buf = await window(fh, from, bound);
    const seg = linesOf(buf, from, agent, from > 0);
    if (stepped && bound === end) {
      const at = seg.lastEnd >= 0 ? seg.lastEnd : from === 0 ? 0 : -1;
      if (at >= 0) {
        stepped = false;
        if (at < end) mark = oversized(buf.subarray(at - from), agent, at, end);
      }
    }
    rows = seg.rows.concat(rows);
    const atStart = from === 0;
    if (atStart || win >= WINDOW_MAX || counted(rows) >= limit) {
      const all = mark ? rows.concat(mark) : rows;
      // Строк не нашлось вовсе — окно целиком внутри одной строки длиннее своего потолка.
      // Тогда левый край просмотренного куска и есть новый курсор: страница пуста, но
      // следующий запрос начнётся за этим куском, а не на том же месте.
      return {
        rows: all,
        atStart,
        atEnd: end >= size,
        firstStart: all.length > 0 ? all[0].start : from,
        lastEnd: all.length > 0 ? all[all.length - 1].end : end,
      };
    }
    // Следующий кусок кончается там, где началась первая целая строка этого: байты перед
    // ней — обрезанная строка, её целая половина лежит как раз в новом куске.
    bound = seg.rows.length > 0 ? seg.rows[0].start : bound;
    win *= 2;
  }
}

/** Окно вперёд от `start` тем же размером: курсор всегда указывает на начало строки. */
async function fwdSlice(
  fh: FileHandle,
  agent: FileAgent,
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
    const buf = await window(fh, from, to);
    const seg = linesOf(buf, from, agent, dropFirst);
    rows = rows.concat(seg.rows);
    if (to >= size || win >= WINDOW_MAX || counted(rows) >= limit) {
      // Строка началась на курсоре и не кончилась в целом окне: целиком её не прочесть, но
      // веху по её началу поставить можно. Край строки-вехи — край куска: следующая
      // страница начнётся за ним, как и после пустого шага.
      if (rows.length === 0 && !dropFirst && to < size) {
        const mark = oversized(buf, agent, from, to);
        if (mark) rows = [mark];
      }
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
    }
    // Недописанный хвост куска — начало строки, которая целиком попадёт в следующий.
    if (seg.lastEnd >= 0) {
      from = seg.lastEnd;
      dropFirst = false;
    }
    win *= 2;
  }
}

/** Сколько байт начала строки-переростка смотрит `oversized`. */
const OVERSIZED_HEAD = 64 * 1024;

/** Веха по началу строки, которая в окно чтения не помещается (`head` — её первые байты,
 *  `start` — её начало, `end` — край просмотренного куска). Узнаётся одна такая строка —
 *  запись сжатия Codex: на живых данных она бывает длиннее 4 МиБ, и без вехи сжатие в ленте
 *  пропадало вовсе. Сохранённое (`retained`) из неё не читается — веха едет без раскрытия;
 *  текст — итог сжатия, если он целиком лежит в начале строки. Прочие строки-переростки
 *  (вывод инструмента) в ленту не идут, как и раньше. */
function oversized(head: Buffer, agent: FileAgent, start: number, end: number): Row | undefined {
  if (agent !== 'codex') return undefined;
  const text = head.toString('utf8', 0, Math.min(head.length, OVERSIZED_HEAD));
  const cut = text.indexOf('"payload"');
  const top = cut < 0 ? text : text.slice(0, cut);
  if (!/^\s*\{/.test(top) || !/"type"\s*:\s*"compacted"/.test(top)) return undefined;
  const ordinal = /"ordinal"\s*:\s*(\d+)/.exec(top)?.[1];
  const base: Base = { id: ordinal ?? String(start), at: stamp(/"timestamp"\s*:\s*"([^"]*)"/.exec(top)?.[1]) };
  let said = '';
  const found = cut < 0 ? null : /^"payload"\s*:\s*\{\s*"message"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text.slice(cut));
  if (found) {
    try {
      said = str(JSON.parse(found[1]));
    } catch {
      said = '';
    }
  }
  return { start, end, entries: [note(base, 'compacted', said)], broken: false };
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
  agent: FileAgent,
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
      rows.push({ start, end, entries: parsed.entries, broken: parsed.broken, result: parsed.result, answers: parsed.answers });
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
  agent: FileAgent,
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
    // Курсор записи ставится здесь и только здесь: до страницы ни признака файла, ни
    // смещения строки у разбора нет. Строка — единица чтения, поэтому у всех её записей
    // он один: `around` по нему вернёт их все, включая ту, от которой прыгнули.
    // Исключение — второе и следующие действия строки (у Claude их бывает несколько): им
    // к курсору дописан номер, чтобы подробности отдавались по каждому, а не по первому.
    const cursor = `${ino}:${row.start}`;
    let tools = 0;
    for (const entry of row.entries) {
      const nth = entry.kind === 'tool' ? tools++ : 0;
      entry.cursor = nth > 0 ? `${cursor}#${nth}` : cursor;
    }
    entries.push(...row.entries);
  }
  fillTimes(entries);
  markResults(rows, entries, slice.atEnd);
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

/** Исход действий страницы по результатам окна. Результат ищется по всем строкам куска,
 *  не только по попавшим на страницу: вызов у края страницы обычно кончается чуть дальше. */
function markResults(rows: Row[], entries: FeedEntry[], atEnd: boolean): void {
  const marks = new Map<string, ToolResult>();
  const answers = new Map<string, Answer[]>();
  for (const row of rows) {
    if (row.result) marks.set(row.result.id, row.result.mark);
    for (const answer of row.answers ?? []) answers.set(answer.call, [...(answers.get(answer.call) ?? []), answer]);
  }
  for (const entry of entries) {
    const id = callIds.get(entry);
    if (!id) continue;
    if (entry.questions) applyAnswers(entry, answers.get(id) ?? []);
    const mark = marks.get(id);
    if (mark) entry.result = mark;
    else if (atEnd) entry.result = { state: 'running' };
  }
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
  /** Результат вызова, если строка — вывод инструмента. */
  result?: { id: string; mark: ToolResult };
  /** Ответы на вопросы, если строка их несёт: результат вызова либо запись-ответ Codex. */
  answers?: Answer[];
}

/** Общее у всех записей строки: идентификатор, метка и ветка. */
interface Base {
  id: string;
  at: number;
  branch?: string;
}

function classify(line: string, agent: FileAgent, offset: number): Parsed {
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
  const result = resultOf(rec, agent);
  const answers = answersOf(rec, agent);
  return {
    entries: agent === 'claude' ? fromClaude(rec, offset) : fromCodex(rec, offset),
    broken: false,
    ...(result ? { result } : {}),
    ...(answers.length ? { answers } : {}),
  };
}

/** Идентификатор вызова записи `tool` — служебный, наружу не едет: им страница сопоставляет
 *  запись с результатом из своего окна. */
const callIds = new WeakMap<FeedEntry, string>();

/** Исход из строки-результата: Claude — `tool_result` (`is_error`, `interrupted` сводки),
 *  Codex — `*_call_output`. Не результат — `null`. */
function resultOf(rec: Record<string, unknown>, agent: FileAgent): { id: string; mark: ToolResult } | null {
  if (agent === 'claude') {
    if (rec.type !== 'user') return null;
    const content = (rec.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return null;
    for (const item of content) {
      if (item === null || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      if (block.type !== 'tool_result' || !str(block.tool_use_id)) continue;
      const meta = rec.toolUseResult as Record<string, unknown> | undefined;
      const stopped = meta !== null && typeof meta === 'object' && meta.interrupted === true;
      return { id: str(block.tool_use_id), mark: claudeMark(block, stopped) };
    }
    return null;
  }
  const payload = rec.payload as Record<string, unknown> | undefined;
  if (rec.type !== 'response_item' || !payload) return null;
  if (payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') return null;
  if (!str(payload.call_id)) return null;
  return { id: str(payload.call_id), mark: codexMark(resultText(payload.output)) };
}

function claudeMark(block: Record<string, unknown>, stopped: boolean): ToolResult {
  if (stopped) return { state: 'stopped' };
  if (block.is_error !== true) return { state: 'done' };
  const code = /^Exit code (\d+)/.exec(resultText(block.content));
  const exit = code ? Number(code[1]) : 0;
  return exit > 0 ? { state: 'failed', exit } : { state: 'failed' };
}

function codexMark(output: string): ToolResult {
  let text = output;
  let code: number | null = null;
  if (text.startsWith('{')) {
    // Старая обёртка: `{"output": "...", "metadata": {"exit_code": N}}`.
    const wrapped = recordOf(text);
    const meta = wrapped?.metadata as Record<string, unknown> | undefined;
    if (typeof meta?.exit_code === 'number') code = meta.exit_code;
    if (wrapped && typeof wrapped.output === 'string') text = wrapped.output;
  }
  if (code === null) {
    const head = /^(?:Exit code: |[\s\S]{0,200}?\nProcess exited with code )(\d+)/.exec(text);
    if (head) code = Number(head[1]);
  }
  if (code === null && /^[\s\S]{0,200}?\nProcess running with session ID/.test(text)) return { state: 'running' };
  if (code !== null && code > 0) return { state: 'failed', exit: code };
  return { state: 'done' };
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

/** Слэш-команда Claude: её человек набрал сам, а CLI записал тегами `<command-name>/имя`,
 *  `<command-message>`, `<command-args>` (замер 12.11.2026: 28 записей в 60 беседах, все —
 *  строка из одних тегов, имя всегда со слэшем; `/model`, `/clear`, `/rename`, команды
 *  навыков). Лента показывает её как набрано — «/имя аргументы». Вывод команды
 *  (`<local-command-stdout>`) идёт отдельной записью и остаётся шумом. Команды, открывающие
 *  только окно (`/usage`), CLI не пишет вовсе. */
const COMMAND_NAME_RE = /<command-name>\s*(\/[^<\s]{1,80})\s*<\/command-name>/;
function commandWords(text: string): string {
  const name = COMMAND_NAME_RE.exec(text);
  if (!name) return '';
  const args = tagOf(text, 'command-args');
  return args ? `${name[1]} ${args}` : name[1];
}

/** Сообщение, отправленное работающему Claude и доставленное ему посреди хода: пишется не
 *  записью `user`, а вложением `queued_command` (замер 12.11.2026 на 2.1.322; агент видит
 *  его со служебной обёрткой «The user sent a new message while you were working», она
 *  лежит отдельно, в `rendered`). В ленте это реплика человека — на месте доставки. Только
 *  запрос человека: команды иного вида и уведомления репликой не становятся. Сообщение,
 *  дождавшееся конца хода, Claude пишет обычной записью `user`. */
function queuedCommand(rec: Record<string, unknown>, offset: number): FeedEntry[] {
  const att = rec.attachment as Record<string, unknown> | null | undefined;
  if (typeof att !== 'object' || att === null || att.type !== 'queued_command') return [];
  if (att.commandMode !== undefined && att.commandMode !== 'prompt') return [];
  const origin = att.origin as Record<string, unknown> | null | undefined;
  if (typeof origin === 'object' && origin !== null && origin.kind !== 'human') return [];
  const words = humanWords(claudeText(att.prompt));
  if (!words) return [];
  return [make({ id: str(rec.uuid) || String(offset), at: stamp(rec.timestamp) }, 0, 'human', words)];
}

function fromClaude(rec: Record<string, unknown>, offset: number): FeedEntry[] {
  const type = rec.type;
  if (type === 'attachment') return queuedCommand(rec, offset);
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
    const event = agentEvent(rec, base, message);
    if (event) return [event];
    // Вывод инструмента в ленту не идёт: запись `tool` уже сказала, что было сделано.
    if (rec.isMeta === true || rec.toolUseResult !== undefined) return [];
    const text = claudeText(message?.content);
    if (rec.isCompactSummary === true) return [note(base, 'compacted', text)];
    if (str(rec.interruptedMessageId)) return [note(base, 'interrupted', text)];
    const words = [commandWords(text), humanWords(text)].filter(Boolean).join('\n');
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
      out.push(
        callId(
          withDetail(
            asked(base, out.length, str(block.name), block.input) ??
              tool(base, out.length, str(block.name), argOf(block.input), descOf(block.input)),
          ),
          block.id,
        ),
      );
  }
  return out;
}

/** Описание, которое агент дал действию (у `Bash` и `Monitor` — поле `description`). */
function descOf(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  return cut(str((input as Record<string, unknown>).description));
}

// --- события фоновых агентов -----------------------------------------------------------

/** Сводка уведомления о задаче, если задача — агент: «Agent "…" finished», «… failed: …»,
 *  «… was stopped by …». Фоновые команды и мониторы пишут то же уведомление другими
 *  словами, и в ленту они не идут. Название жадное: кавычки бывают и внутри него. */
const AGENT_DONE_RE = /^Agent "([\s\S]*)" (finished|failed\b|was stopped\b)/;
/** Отчёт подагента в `origin.body`: строка-пояснение в квадратных скобках, кончающаяся
 *  двоеточием, и сам отчёт с отступом в два пробела. */
const HANDBACK_RE = /^\[[^\]\n]{1,60}\][^\n]*:\n/;

/** Запись `user`, которая на деле событие фонового агента: запуск (результат вызова
 *  `Agent` с `status: 'async_launched'`), завершение (`<task-notification>` со сводкой об
 *  агенте) или пришедшее от него сообщение (`origin.kind: 'peer'`). Формы сняты с живых
 *  транскриптов 12.11.2026. Человек этого не писал — запись едет вехой, а не репликой. */
function agentEvent(
  rec: Record<string, unknown>,
  base: Base,
  message: Record<string, unknown> | undefined,
): FeedEntry | null {
  const result = rec.toolUseResult;
  if (result !== undefined) {
    if (result === null || typeof result !== 'object') return null;
    const launch = result as Record<string, unknown>;
    const name = cut(str(launch.description));
    if (launch.isAsync !== true || launch.status !== 'async_launched' || !name) return null;
    return event(base, 'agent-start', name);
  }
  const origin = (rec.origin ?? undefined) as Record<string, unknown> | undefined;
  const text = claudeText(message?.content);
  if (origin?.kind === 'peer') {
    const words = str(origin.handbackReportText).trim() || unwrapReport(str(origin.body)) || peerWords(text);
    if (!words) return null;
    const entry = event(base, 'agent-message', words);
    const from = cut(str(origin.name));
    if (from) entry.from = from;
    return entry;
  }
  if (rec.isMeta === true) return null;
  const notice = /^<task-notification>([\s\S]*)<\/task-notification>$/.exec(text);
  if (!notice) return null;
  const done = AGENT_DONE_RE.exec(tagOf(notice[1], 'summary'));
  if (!done) return null;
  const entry = event(base, 'agent-done', cut(done[1]));
  const ms = Number(tagOf(notice[1], 'duration_ms'));
  if (Number.isFinite(ms) && ms > 0) entry.elapsed = Math.round(ms / 1000);
  if (done[2] !== 'finished') entry.outcome = done[2] === 'failed' ? 'failed' : 'stopped';
  return entry;
}

function event(base: Base, what: NonNullable<FeedEntry['note']>, text: string): FeedEntry {
  const entry = make(base, 0, 'note', text);
  entry.note = what;
  return entry;
}

/** Содержимое первого тега `<name>…</name>`; тега нет — пусто. */
function tagOf(text: string, name: string): string {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return found ? found[1].trim() : '';
}

/** Тело сообщения без пояснения среды: отчёт подагента лежит под строкой-пояснением с
 *  отступом в два пробела. Другой формы — тело как есть. */
function unwrapReport(body: string): string {
  const head = HANDBACK_RE.exec(body);
  if (!head) return body.trim();
  const lines = body.slice(head[0].length).split('\n');
  if (lines.some((line) => line.trim() !== '' && !line.startsWith('  '))) return body.trim();
  return lines.map((line) => line.slice(2)).join('\n').trim();
}

/** Слова из самой записи, когда `origin` их не несёт: то, что внутри `<agent-message>`. */
function peerWords(text: string): string {
  const found = /<agent-message\b[^>]*>([\s\S]*?)<\/agent-message>/.exec(text);
  return found ? found[1].trim() : '';
}

/** Сохранённое без сжатия в записи `compacted` Codex: `payload.retained_context` — открытый
 *  текст последних сообщений человека и ответов агента в порядке беседы (`order`). Итог
 *  сжатия зашифрован (`replacement_history[].compaction`), а `replacement_history` — это
 *  ещё и служебные инструкции роли developer: оттуда не берётся ничего. Человеческие
 *  сообщения проходят тот же фильтр, что реплики ленты: обёртки среды и ответы на вопросы
 *  очереди — не его слова. */
function retainedMessages(payload: Record<string, unknown> | undefined): RetainedMessage[] {
  const ctx = payload?.retained_context;
  if (ctx === null || typeof ctx !== 'object') return [];
  const found: Array<RetainedMessage & { order: number }> = [];
  const take = (list: unknown, role: RetainedMessage['role']): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue;
      const m = item as Record<string, unknown>;
      const raw = str(m.text);
      if (role === 'human' && REPLY_RE.test(raw)) continue;
      const text = (role === 'human' ? humanWords(raw) : raw).trim();
      if (text) found.push({ role, text, order: typeof m.order === 'number' ? m.order : found.length });
    }
  };
  const c = ctx as Record<string, unknown>;
  take(c.user_messages, 'human');
  take(c.assistant_messages, 'agent');
  // Сортировка устойчива: при равном `order` человек раньше агента, как собрано.
  return found.sort((a, b) => a.order - b.order).map(({ role, text }) => ({ role, text }));
}

function fromCodex(rec: Record<string, unknown>, offset: number): FeedEntry[] {
  const payload = (rec.payload ?? undefined) as Record<string, unknown> | undefined;
  const id =
    str(payload?.id) ||
    (typeof rec.ordinal === 'number' ? String(rec.ordinal) : '') ||
    String(offset);
  const base: Base = { id, at: stamp(rec.timestamp) };
  if (rec.type === 'compacted') {
    const entry = note(base, 'compacted', str(payload?.message));
    const kept = retainedMessages(payload);
    const human = kept.filter((m) => m.role === 'human').length;
    if (kept.length > 0) entry.retained = { human, agent: kept.length - human };
    return [entry];
  }
  if (rec.type === 'event_msg')
    return payload?.type === 'error' ? [note(base, 'error', str(payload.message))] : [];
  if (rec.type !== 'response_item' || !payload) return [];
  if (payload.type === 'message') {
    // `developer` — это инструкции окружения, а не реплика человека.
    const kind = payload.role === 'user' ? 'human' : payload.role === 'assistant' ? 'agent' : null;
    if (!kind) return [];
    const raw = codexText(payload.content);
    // Ответ на вопрос очереди — служебная обёртка: он встаёт отметкой у самого вопроса.
    if (kind === 'human' && REPLY_RE.test(raw)) return [];
    const text = kind === 'human' ? humanWords(raw) : raw;
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
    return [callId(withDetail(asked(base, 0, name, args) ?? tool(base, 0, name, codexArg(args))), payload.call_id)];
  }
  return [];
}

// --- вопросы агента --------------------------------------------------------------------

/** Инструменты, которыми агент спрашивает человека. */
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'request_user_input', 'request_user_input_async']);
/** Пределы блока вопроса: вопросов и вариантов больше не бывает (Claude — до 4 и 4), а
 *  подпись и пояснение варианта — строки, не документы. Вместе с пределом текста записи
 *  они держат вес записи ограниченным. */
const QUESTION_MAX = 8;
const OPTION_MAX = 12;
const OPTION_LIMIT = 1000;
/** Ответ на асинхронный вопрос Codex: запись человека из одной этой обёртки. */
const REPLY_RE = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/;

/** Ответ на один вопрос вызова `call`. Вопрос назван тем, что знает источник: текстом
 *  (Claude), идентификатором (синхронный Codex) или номером (асинхронный Codex). */
interface Answer {
  call: string;
  text?: string;
  key?: string;
  index?: number;
  answer: string[];
}

/** Чем вопросы записи названы в источнике — служебное, наружу не едет. */
const questionKeys = new WeakMap<FeedEntry, { texts: string[]; keys: string[] }>();

function short(value: unknown): string {
  const text = str(value).trim();
  return text.length > OPTION_LIMIT ? `${text.slice(0, OPTION_LIMIT - 1)}…` : text;
}

/** Запись вопроса из вызова инструмента; не вопрос или вопросов не разобрать — `null`, и
 *  вызов едет обычным действием. */
function asked(base: Base, index: number, name: string, input: unknown): FeedEntry | null {
  if (!QUESTION_TOOLS.has(name)) return null;
  const args = typeof input === 'string' ? recordOf(input) : input;
  if (args === null || typeof args !== 'object') return null;
  const list = (args as Record<string, unknown>).questions;
  if (!Array.isArray(list)) return null;
  const questions: FeedQuestion[] = [];
  const texts: string[] = [];
  const keys: string[] = [];
  // Предел текста записи — один на все вопросы вызова: каждый следующий режется остатком.
  let budget = TEXT_LIMIT;
  let truncated = false;
  for (const item of list.slice(0, QUESTION_MAX)) {
    if (item === null || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const full = (str(raw.question) || str(raw.title)).trim();
    if (!full) continue;
    const clipped = clip(full, budget);
    budget -= Buffer.byteLength(clipped.text);
    if (clipped.truncated) truncated = true;
    const question: FeedQuestion = { text: clipped.text };
    const header = short(raw.header);
    if (header) question.header = header;
    const options: NonNullable<FeedQuestion['options']> = [];
    for (const opt of Array.isArray(raw.options) ? raw.options.slice(0, OPTION_MAX) : []) {
      const rec = (opt !== null && typeof opt === 'object' ? opt : {}) as Record<string, unknown>;
      const label = short(typeof opt === 'string' ? opt : rec.label);
      if (!label) continue;
      const hint = short(rec.description);
      options.push(hint ? { label, hint } : { label });
    }
    if (options.length) question.options = options;
    if (raw.multiSelect === true) question.multi = true;
    questions.push(question);
    texts.push(full);
    keys.push(str(raw.id));
  }
  if (questions.length === 0) return null;
  const entry = make(base, index, 'tool', `${name} ${questions.map((q) => q.text).join('\n')}`);
  entry.tool = name;
  entry.questions = questions;
  if (truncated) entry.truncated = true;
  questionKeys.set(entry, { texts, keys });
  return entry;
}

/** Ответы, которые несёт строка файла: результат вызова вопроса либо запись-ответ Codex. */
function answersOf(rec: Record<string, unknown>, agent: FileAgent): Answer[] {
  const out: Answer[] = [];
  if (agent === 'claude') {
    const meta = rec.toolUseResult;
    if (rec.type !== 'user' || meta === null || typeof meta !== 'object') return out;
    const given = (meta as Record<string, unknown>).answers;
    if (given === null || typeof given !== 'object' || Array.isArray(given)) return out;
    const content = (rec.message as Record<string, unknown> | undefined)?.content;
    const block = Array.isArray(content)
      ? (content.find((b) => b !== null && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result') as
          | Record<string, unknown>
          | undefined)
      : undefined;
    const call = str(block?.tool_use_id);
    if (!call) return out;
    for (const [text, value] of Object.entries(given as Record<string, unknown>))
      if (str(value).trim()) out.push({ call, text, answer: [short(value)] });
    return out;
  }
  const payload = rec.payload as Record<string, unknown> | undefined;
  if (rec.type !== 'response_item' || !payload) return out;
  if (payload.type === 'function_call_output') {
    const call = str(payload.call_id);
    const output = str(payload.output);
    // Дешёвая отсечка: вывод команд — не JSON с ответами, разбирать его незачем.
    if (!call || !output.startsWith('{') || !output.includes('"answers"')) return out;
    const given = recordOf(output)?.answers;
    if (given === null || typeof given !== 'object' || Array.isArray(given)) return out;
    for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
      const list = (value as Record<string, unknown> | null)?.answers;
      const answer = Array.isArray(list) ? list.map(short).filter(Boolean) : [];
      if (answer.length) out.push({ call, key, answer });
    }
    return out;
  }
  if (payload.type !== 'message' || payload.role !== 'user') return out;
  const reply = REPLY_RE.exec(codexText(payload.content));
  if (!reply) return out;
  let list: unknown;
  try {
    list = JSON.parse(reply[1]);
  } catch {
    return out;
  }
  for (const item of Array.isArray(list) ? list : []) {
    if (item === null || typeof item !== 'object') continue;
    const one = item as Record<string, unknown>;
    const answer = short(one.answer);
    let where: unknown;
    try {
      where = JSON.parse(str(one.questionItemId));
    } catch {
      continue;
    }
    // `[<что-то>, <call_id>, <номер вопроса>]` — замер 12.11.2026, 69 ответов из 69.
    if (!answer || !Array.isArray(where) || typeof where[1] !== 'string' || typeof where[2] !== 'number') continue;
    out.push({ call: where[1], index: where[2], answer: [answer] });
  }
  return out;
}

/** Ставит ответы вопросам записи. Несколько отметок Claude пишет одной строкой через «, » —
 *  она делится, только если каждая часть есть среди вариантов: свой текст с запятой остаётся
 *  целым. */
function applyAnswers(entry: FeedEntry, answers: Answer[]): void {
  const names = questionKeys.get(entry);
  if (!names || !entry.questions) return;
  for (const given of answers) {
    const at =
      given.index !== undefined ? given.index
      : given.key !== undefined ? names.keys.indexOf(given.key)
      : names.texts.indexOf(given.text ?? '');
    const question = entry.questions[at];
    if (!question) continue;
    let answer = given.answer;
    if (question.multi && answer.length === 1) {
      const parts = answer[0].split(', ');
      const labels = new Set((question.options ?? []).map((o) => o.label));
      if (parts.length > 1 && parts.every((part) => labels.has(part))) answer = parts;
    }
    question.answer = answer;
  }
}

function callId(entry: FeedEntry, id: unknown): FeedEntry {
  if (typeof id === 'string' && id) callIds.set(entry, id);
  return entry;
}

/** Подробности у действия есть всегда: вызов несёт ввод, а вывод ищется по требованию. */
function withDetail(entry: FeedEntry): FeedEntry {
  entry.detail = true;
  return entry;
}

/** Запись базы opencode (`session_message`): тип лежит столбцом рядом с телом JSON.
 *  Мышление, текст и вызовы — части одного ответа, как блоки строки Claude, поэтому и
 *  идентификаторы у них те же: строка, затем `#<номер>`. `pending` — ответ ещё пишется:
 *  его строка в базе уже есть и будет расти, и читатель держит курсор перед ней, как перед
 *  недописанной строкой файла. Служебные типы (`system`, `synthetic`, `model-switched`) в
 *  ленту не идут: их пишет сам opencode, а не человек и не модель. */
export function fromOpencode(type: string, data: string, id: string): Parsed & { pending: boolean } {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { entries: [], broken: true, pending: false };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { entries: [], broken: true, pending: false };
  const rec = raw as Record<string, unknown>;
  const time = (rec.time ?? undefined) as Record<string, unknown> | undefined;
  const base: Base = { id, at: stamp(time?.created) };
  const done = (entries: FeedEntry[], pending = false) => ({ entries, broken: false, pending });
  if (type === 'user') {
    const words = humanWords(str(rec.text));
    return done(words ? [make(base, 0, 'human', words)] : []);
  }
  if (type === 'assistant') {
    const out: FeedEntry[] = [];
    for (const item of Array.isArray(rec.content) ? rec.content : []) {
      if (item === null || typeof item !== 'object') continue;
      const part = item as Record<string, unknown>;
      const text = str(part.text);
      if (part.type === 'text' && text.trim()) out.push(make(base, out.length, 'agent', text));
      else if (part.type === 'reasoning' && text.trim()) out.push(make(base, out.length, 'thinking', text));
      else if (part.type === 'tool' && str(part.name)) {
        const state = (part.state ?? undefined) as Record<string, unknown> | undefined;
        out.push(tool(base, out.length, str(part.name), argOf(state?.input)));
      }
    }
    const error = errorText(rec.error);
    if (error) out.push(note(base, 'error', error, out.length));
    return done(out, time?.completed === undefined && rec.error === undefined);
  }
  if (type === 'compaction') {
    // Сбой сжатия здесь молчит: ход, который он оборвал, следом закрывает запись `idle` с той
    // же ошибкой, и второй строки об одном и том же лента не показывает.
    if (rec.status === 'completed') return done([note(base, 'compacted', str(rec.summary))]);
    return done([], rec.status !== 'failed');
  }
  if (type === 'idle') {
    const outcome = str(rec.outcome);
    if (outcome === 'failed') return done([note(base, 'error', errorText(rec.error))]);
    if (/abort|interrupt|cancel/i.test(outcome)) return done([note(base, 'interrupted', '')]);
  }
  return done([]);
}

/** Текст ошибки opencode: `{type, message}` либо строка. */
function errorText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw === null || typeof raw !== 'object') return '';
  const err = raw as Record<string, unknown>;
  return str(err.message) || str(err.type);
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
function clip(text: string, limit = TEXT_LIMIT): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= limit) return { text, truncated: false };
  const buf = Buffer.from(text, 'utf8');
  let end = Math.max(0, limit);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.toString('utf8', 0, end), truncated: true };
}

/** Вес записи в ответе: текст плюс ключи и служебные поля вокруг него. Оценка, а не
 *  точный размер JSON — она сторожит потолок ответа, и считать её точно значило бы
 *  сериализовать каждую запись дважды. Постоянная считана по полям: `id`, `at`, `kind`,
 *  `text` с кавычками и запятыми — около 80 байт, курсор со своим ключом — ещё около 40.
 *  Считается до того, как страница проставит курсор, поэтому он и входит постоянной.
 *  Постоянную держит тест «на множестве коротких записей счёт страницы решает накладной
 *  вес записи»: на странице из тысячи коротких записей она и решает, сколько их войдёт в
 *  потолок ответа, — подмена 120 на 80 даёт 966 записей вместо 932. Новое поле формы
 *  кладётся в неё же, иначе страница дешевеет молча — и здесь, и в бюджете склейки
 *  цепочки, который меряет этой же функцией `session-feed`. */
export function weigh(entry: FeedEntry): number {
  return (
    Buffer.byteLength(entry.text) +
    Buffer.byteLength(entry.id) +
    Buffer.byteLength(entry.tool ?? '') +
    Buffer.byteLength(entry.desc ?? '') +
    Buffer.byteLength(entry.from ?? '') +
    (entry.questions ? questionWeight(entry.questions) : 0) +
    120
  );
}

/** Вес вопросов записи: тексты плюс ключи и скобки вокруг каждого вопроса и варианта. */
function questionWeight(questions: FeedQuestion[]): number {
  let n = 16;
  for (const q of questions) {
    n += Buffer.byteLength(q.text) + Buffer.byteLength(q.header ?? '') + 60;
    for (const o of q.options ?? []) n += Buffer.byteLength(o.label) + Buffer.byteLength(o.hint ?? '') + 24;
    for (const a of q.answer ?? []) n += Buffer.byteLength(a) + 4;
  }
  return n;
}

/** Веха беседы. Подробность из источника проходит тот же фильтр, что и реплика человека:
 *  строка, объявленная шумом в записи человека, не становится содержимым оттого, что приехала
 *  вехой, и поле `note` не повторяется словами. Прерыванию после этого остаётся пустой текст —
 *  замер 14.09.2026: у всех 20 вех прерывания владельца текст состоял только из маркера
 *  `[Request interrupted by user]`, своей подробности не было ни у одной. */
function note(base: Base, what: NonNullable<FeedEntry['note']>, text: string, index = 0): FeedEntry {
  const entry = make(base, index, 'note', humanWords(text));
  entry.note = what;
  return entry;
}

function tool(base: Base, index: number, name: string, arg: string, desc = ''): FeedEntry {
  const entry = make(base, index, 'tool', arg ? `${name} ${arg}` : name);
  entry.tool = name;
  // Описание, уже ставшее подписью (у `Agent` подпись и есть описание), не повторяется.
  if (desc && desc !== arg) entry.desc = desc;
  return entry;
}

/** Первый аргумент, который человек узнаёт: путь файла, команда, образец поиска, адрес,
 *  задание подагенту. Ничего из перечисленного нет — остаётся одно имя инструмента.
 *  `cmd` — та же «команда»: так её называет `exec_command` Codex на живых данных.
 *
 *  Порядок — это правило разрешения спора, а не список: подпись берёт первый ключ, который
 *  в записи нашёлся. Поэтому ключи разговора (`summary`, `target`, `task_name`) стоят раньше
 *  `message`: у `send_message`, `followup_task` и `spawn_agent` тело письма на живых данных
 *  зашифровано (`gAAAAAB…`), и подписью может быть только адресат. По той же причине новые
 *  ключи дописаны в конец: до них очередь доходит ровно тогда, когда прежние не нашлись,
 *  и ни одна уже работающая подпись от их появления не меняется.
 *
 *  Замер 14.09.2026 на 65 773 вызовах владельца: без аргумента ехали 6 533 подписи (9,93 %),
 *  хотя аргумент лежал в записи — `send_message` 1 407 (`target`), `SendMessage` 569
 *  (`summary`), `followup_task` 344 (`target`), `AskUserQuestion` 243 (`questions[].question`),
 *  `ToolSearch` 179 и `WebSearch` 139 (`query`), `Skill` 144 (`skill`), `spawn_agent` 124
 *  (`task_name`), `mcp__claude-in-chrome__computer` 22 (`action`), `PushNotification` 17
 *  (`message`), `interrupt_agent` 16 (`target`), `request_user_input_async` 11
 *  (`questions[].title`), `CronCreate` 1 (`prompt`). */
const ARG_KEYS = [
  'file_path',
  'path',
  'notebook_path',
  'command',
  'cmd',
  'pattern',
  'url',
  'description',
  'query',
  'skill',
  'summary',
  'target',
  'task_name',
  'questions',
  'question',
  'title',
  'prompt',
  'message',
  'action',
];

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
    const value = argValue(obj[key]);
    if (value.trim()) return cut(value);
  }
  // Одно имя инструмента — это решение, а не недосмотр разбора. Замер 14.09.2026 после
  // правки: без аргумента остаются 3 314 вызовов из 65 776 (5,04 % против прежних 9,93 %),
  // и 3 019 из них — `wait_agent` (1 532), `wait` (957), `list_agents` (275) и `sleep` (255):
  // подписать нечем, в записи у них только число миллисекунд, чужой номер ячейки или пустой
  // объект. Остальные молчат намеренно: `TaskUpdate`/`TaskStop`/`TaskOutput` несут
  // непрозрачный идентификатор задачи, `browser_batch` — список вложенных вызовов, `Workflow`
  // и `evaluate_script` — тело кода на сотни строк. Идентификатор и простыня кода — не
  // подпись; поставить их сюда значило бы поменять молчание на шум.
  return '';
}

/** Значение ключа подписи в строку. Массивом приходит и команда оболочки Codex
 *  (`command: ["bash","-lc","…"]` — для подписи это та же одна строка, склеенная пробелами),
 *  и список вопросов (`questions: [{question}]` у `AskUserQuestion`, `[{title}]` у
 *  `request_user_input_async`): там слова лежат на элемент глубже, и достаёт их тот же
 *  перебор ключей. Берётся первый вопрос, а не все: подпись — строка, а не список. */
function argValue(raw: unknown): string {
  if (!Array.isArray(raw)) return str(raw);
  const words = raw.filter((x) => typeof x === 'string') as string[];
  if (words.length) return words.join(' ');
  for (const item of raw) {
    const inner = argOf(item);
    if (inner) return inner;
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

// --- подробности действия ------------------------------------------------------------------

/** Ответ на запрос подробностей: тело `ToolDetail` либо отказ ленты теми же причинами. */
export type DetailResult =
  | ({ ok: true } & ToolDetail & { result?: ToolResult; messages?: RetainedMessage[] })
  | FeedFailure;

/** Как далеко от вызова ищется его результат. Результат идёт следом, но между ними бывают
 *  записи параллельных вызовов и реплики; дальше этого предела вызов считается ещё идущим. */
const DETAIL_SCAN_LIMIT = 32 * 1024 * 1024;
/** Строка вызова длиннее этого не читается: это не вызов, а свалка. */
const DETAIL_LINE_LIMIT = 16 * 1024 * 1024;
const DETAIL_CHUNK = 256 * 1024;

/** Вызов, найденный по курсору. `id` связывает его с результатом: `tool_use.id` у Claude,
 *  `call_id` у Codex. */
interface Call {
  name: string;
  id: string;
  input: unknown;
  end: number;
}

/** Результат вызова в виде, общем для обоих агентов. */
interface Outcome {
  output: string;
  /** Claude: сводка правки (`toolUseResult`) — из неё берётся diff. */
  meta?: Record<string, unknown>;
  mark: ToolResult;
}

/** Подробности действия по курсору записи `tool` страницы ленты: команда с выводом либо
 *  diff правки. Курсор не на действии, чужой, не на границе строки — `cursor-stale`. Файл
 *  целиком не читается: строка вызова и затем окно вперёд до результата. */
export async function readDetail(file: string, agent: FileAgent, cursor: string): Promise<DetailResult> {
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
    const at = cursorOf(cursor, Number(st.ino), st.size);
    if (at === null || (at > 0 && !(await startsLine(fh, at))))
      return { ok: false, reason: 'cursor-stale', detail: `cursor ${cursor} is not from ${file}` };
    const line = await lineAt(fh, at, st.size);
    if (line === 'long') return { ok: false, reason: 'lookup-failed', detail: `line at ${cursor} is too long` };
    if (line !== null && agent === 'codex') {
      const kept = retainedDetail(line.text);
      if (kept) return kept;
    }
    const found = line === null ? null : callOf(line.text, agent, line.end, toolIndexOf(cursor));
    if (!found) return { ok: false, reason: 'cursor-stale', detail: `cursor ${cursor} is not on an action` };
    const outcome = found.id ? await outcomeOf(fh, agent, found.id, found.end, st.size) : null;
    return { ok: true, ...detailOf(agent, found, outcome) };
  } catch (e) {
    return { ok: false, reason: 'lookup-failed', detail: `cannot read ${file}: ${String(e)}` };
  } finally {
    await fh.close();
  }
}

/** Раскрытие вехи сжатия Codex: сохранённые сообщения в порядке беседы. Бюджет один на всё
 *  тело — предел текста записи; набирается с самых свежих, а упёршееся сообщение режется, и
 *  тело помечается `truncated`. `null` — строка не веха сжатия с сохранённым. */
function retainedDetail(line: string): DetailResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== 'compacted') return null;
  const kept = retainedMessages((rec.payload ?? undefined) as Record<string, unknown> | undefined);
  if (kept.length === 0) return null;
  const out: RetainedMessage[] = [];
  let room = TEXT_LIMIT;
  let truncated = false;
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const size = Buffer.byteLength(kept[i].text);
    if (size <= room) {
      out.push(kept[i]);
      room -= size;
      continue;
    }
    truncated = true;
    if (room > 0) out.push({ role: kept[i].role, text: clip(kept[i].text, room).text });
    break;
  }
  if (out.length < kept.length) truncated = true;
  return { ok: true, messages: out.reverse(), ...(truncated ? { truncated: true } : {}) };
}

/** Целая строка с `at`; `null` — строки там нет (конец файла или она ещё пишется). */
async function lineAt(fh: FileHandle, at: number, size: number): Promise<{ text: string; end: number } | 'long' | null> {
  const parts: Buffer[] = [];
  let pos = at;
  let total = 0;
  while (pos < size) {
    const buf = Buffer.alloc(Math.min(DETAIL_CHUNK, size - pos));
    const r = await fh.read(buf, 0, buf.length, pos);
    if (r.bytesRead === 0) break;
    const nl = buf.subarray(0, r.bytesRead).indexOf(10);
    if (nl >= 0) {
      parts.push(buf.subarray(0, nl));
      return { text: Buffer.concat(parts).toString('utf8'), end: pos + nl + 1 };
    }
    parts.push(buf.subarray(0, r.bytesRead));
    total += r.bytesRead;
    pos += r.bytesRead;
    if (total > DETAIL_LINE_LIMIT) return 'long';
  }
  return null;
}

/** Вызов инструмента номер `nth` в строке (с нуля). Одна строка Claude бывает с несколькими
 *  вызовами: счёт идёт по тем же блокам и в том же порядке, что дают записи `tool` страницы.
 *  У Codex вызов в строке один. */
function callOf(line: string, agent: FileAgent, end: number, nth = 0): Call | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (agent === 'claude') {
    if (rec.type !== 'assistant') return null;
    const content = (rec.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return null;
    let seen = 0;
    for (const item of content) {
      if (item === null || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      if (block.type !== 'tool_use' || !str(block.name)) continue;
      if (seen++ === nth) return { name: str(block.name), id: str(block.id), input: block.input, end };
    }
    return null;
  }
  if (nth > 0) return null;
  const payload = rec.payload as Record<string, unknown> | undefined;
  if (rec.type !== 'response_item' || !payload) return null;
  if ((payload.type !== 'function_call' && payload.type !== 'custom_tool_call') || !str(payload.name)) return null;
  const input = payload.type === 'function_call' ? payload.arguments : payload.input;
  return { name: str(payload.name), id: str(payload.call_id), input, end };
}

/** Ищет вывод вызова вперёд от его строки. Строки без идентификатора вызова не
 *  разбираются вовсе: на живых файлах они весят мегабайты. */
async function outcomeOf(
  fh: FileHandle,
  agent: FileAgent,
  id: string,
  from: number,
  size: number,
): Promise<Outcome | null> {
  const stop = Math.min(size, from + DETAIL_SCAN_LIMIT);
  let pos = from;
  let tail = Buffer.alloc(0);
  while (pos < stop) {
    const buf = Buffer.alloc(Math.min(DETAIL_CHUNK * 4, stop - pos));
    const r = await fh.read(buf, 0, buf.length, pos);
    if (r.bytesRead === 0) break;
    pos += r.bytesRead;
    let data = tail.length ? Buffer.concat([tail, buf.subarray(0, r.bytesRead)]) : buf.subarray(0, r.bytesRead);
    let nl = data.indexOf(10);
    while (nl >= 0) {
      const text = data.toString('utf8', 0, nl);
      if (text.includes(id)) {
        const found = agent === 'claude' ? claudeOutcome(text, id) : codexOutcome(text, id);
        if (found) return found;
      }
      data = data.subarray(nl + 1);
      nl = data.indexOf(10);
    }
    tail = Buffer.from(data);
  }
  return null;
}

function recordOf(text: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(text);
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function claudeOutcome(text: string, id: string): Outcome | null {
  const rec = recordOf(text);
  if (!rec || rec.type !== 'user') return null;
  const content = (rec.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type !== 'tool_result' || block.tool_use_id !== id) continue;
    const meta =
      rec.toolUseResult !== null && typeof rec.toolUseResult === 'object' && !Array.isArray(rec.toolUseResult)
        ? (rec.toolUseResult as Record<string, unknown>)
        : undefined;
    let output = resultText(block.content);
    // Вывод, который агент не положил в блок, но записал в сводку (Bash).
    if (!output && meta) output = [str(meta.stdout), str(meta.stderr)].filter(Boolean).join('\n');
    return { output, mark: claudeMark(block, meta?.interrupted === true), ...(meta ? { meta } : {}) };
  }
  return null;
}

function codexOutcome(text: string, id: string): Outcome | null {
  const rec = recordOf(text);
  const payload = rec?.payload as Record<string, unknown> | undefined;
  if (!payload || rec?.type !== 'response_item') return null;
  if (payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') return null;
  if (payload.call_id !== id) return null;
  let output = resultText(payload.output);
  // Старая обёртка: `{"output": "...", "metadata": {...}}` строкой.
  if (output.startsWith('{')) {
    const wrapped = recordOf(output);
    if (wrapped && typeof wrapped.output === 'string') output = wrapped.output;
  }
  return { output, mark: codexMark(resultText(payload.output)) };
}

/** Текст результата: строка либо список блоков, из которых берутся текстовые. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') parts.push(item);
    else if (item !== null && typeof item === 'object') {
      const block = item as Record<string, unknown>;
      if (str(block.text)) parts.push(str(block.text));
      else if (block.type === 'image') parts.push('[image]');
    }
  }
  return parts.join('\n');
}

/** Подробности из вызова и его результата. Правка с diff отдаёт только diff: ввод и вывод
 *  при ней — то же самое другими словами. */
function detailOf(agent: FileAgent, call: Call, outcome: Outcome | null): ToolDetail & { result?: ToolResult } {
  const clipped = { truncated: false };
  const cap = (text: string): string => {
    const cut = clip(text);
    if (cut.truncated) clipped.truncated = true;
    return cut.text;
  };
  const out: ToolDetail & { result?: ToolResult } = {};
  const diff = agent === 'claude' ? claudeDiff(outcome?.meta) : patchDiff(call.input);
  if (diff.length > 0) {
    out.diff = capDiff(diff, clipped);
    // Правка Codex, не прошедшая, объясняет себя выводом; удавшаяся — нет.
    if (agent === 'codex' && outcome?.output && !/^success\b/i.test(outcome.output)) out.output = cap(outcome.output);
  } else {
    const input = inputText(agent, call.input);
    if (input) out.input = cap(input);
    if (outcome?.output) out.output = cap(outcome.output);
  }
  if (!outcome) out.pending = true;
  // Успех — отсутствие поля и `pending`; называются только неудача и прерывание.
  else if (outcome.mark.state === 'failed' || outcome.mark.state === 'stopped') out.result = outcome.mark;
  if (clipped.truncated) out.truncated = true;
  return out;
}

type DiffFile = NonNullable<ToolDetail['diff']>[number];

/** Diff Claude: `structuredPatch` сводки результата; у нового файла он пуст — тогда весь
 *  файл добавленный; у правки без него — старая и новая строки. */
function claudeDiff(meta: Record<string, unknown> | undefined): DiffFile[] {
  if (!meta) return [];
  const file = str(meta.filePath);
  const lines: DiffFile['lines'] = [];
  if (Array.isArray(meta.structuredPatch)) {
    for (const hunk of meta.structuredPatch) {
      const rows = hunk !== null && typeof hunk === 'object' ? (hunk as Record<string, unknown>).lines : undefined;
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (typeof row !== 'string' || row.startsWith('\\')) continue;
        const sign = row[0];
        lines.push(
          sign === '+' || sign === '-' ? { t: sign, s: row.slice(1) } : { t: ' ', s: sign === ' ' ? row.slice(1) : row },
        );
      }
    }
  }
  if (lines.length === 0 && meta.type === 'create' && typeof meta.content === 'string') {
    for (const row of splitLines(meta.content)) lines.push({ t: '+', s: row });
  }
  if (lines.length === 0 && typeof meta.oldString === 'string' && typeof meta.newString === 'string') {
    for (const row of splitLines(meta.oldString)) lines.push({ t: '-', s: row });
    for (const row of splitLines(meta.newString)) lines.push({ t: '+', s: row });
  }
  return lines.length > 0 ? [{ path: file, lines }] : [];
}

function splitLines(text: string): string[] {
  const rows = text.split('\n');
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** Diff Codex: текст патча `*** Begin Patch` в вводе вызова (отдельным инструментом либо
 *  внутри скрипта песочницы). Заголовки разделов `@@` в строки не идут. */
function patchDiff(input: unknown): DiffFile[] {
  const text = typeof input === 'string' ? input : '';
  const start = text.indexOf('*** Begin Patch');
  if (start < 0) return [];
  const end = text.indexOf('*** End Patch', start);
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  for (const row of text.slice(start, end < 0 ? undefined : end).split('\n')) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(row);
    if (head) {
      current = { path: head[2]!.trim(), lines: [] };
      files.push(current);
      continue;
    }
    if (!current || row.startsWith('***') || row.startsWith('@@')) continue;
    const sign = row[0];
    if (sign === '+' || sign === '-') current.lines.push({ t: sign, s: row.slice(1) });
    else if (sign === ' ') current.lines.push({ t: ' ', s: row.slice(1) });
  }
  return files.filter((f) => f.lines.length > 0);
}

/** Тот же предел, что у текста записи: diff, не влезший в 64 КиБ, обрезается по строкам. */
function capDiff(files: DiffFile[], clipped: { truncated: boolean }): DiffFile[] {
  let budget = TEXT_LIMIT;
  const out: DiffFile[] = [];
  for (const file of files) {
    const lines: DiffFile['lines'] = [];
    for (const line of file.lines) {
      const weight = Buffer.byteLength(line.s) + 2;
      if (weight > budget) {
        clipped.truncated = true;
        break;
      }
      budget -= weight;
      lines.push(line);
    }
    if (lines.length > 0) out.push({ path: file.path, lines });
    if (clipped.truncated) break;
  }
  return out;
}

/** Ввод вызова для человека: команда — как она набрана, прочее — читаемый JSON. */
function inputText(agent: FileAgent, input: unknown): string {
  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        /* не JSON — сам текст ввода */
      }
    }
  }
  if (typeof value === 'string') return agent === 'codex' ? scriptCommands(value) : value;
  if (value === null || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  for (const key of ['command', 'cmd']) {
    const found = obj[key];
    if (typeof found === 'string' && found) return found;
    if (Array.isArray(found) && found.every((x) => typeof x === 'string') && found.length > 0) {
      const words = found as string[];
      // `["bash", "-lc", "<команда>"]` — оболочка вокруг команды, а не она сама.
      return words.length === 3 && /^(?:ba|z|da)?sh$/.test(words[0]!) && /^-\w*c$/.test(words[1]!)
        ? words[2]!
        : words.join(' ');
    }
  }
  return JSON.stringify(obj, null, 2);
}

/** Команды из скрипта песочницы Codex (`tools.exec_command({cmd:"…"})`); нет их — сам скрипт. */
function scriptCommands(script: string): string {
  const commands: string[] = [];
  let found: RegExpExecArray | null;
  SCRIPT_CMD_RE.lastIndex = 0;
  while ((found = SCRIPT_CMD_RE.exec(script)) !== null) commands.push(unquote(found[1]));
  return commands.length > 0 ? commands.join('\n') : script;
}
