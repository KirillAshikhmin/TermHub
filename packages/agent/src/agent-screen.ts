// Распознавание экрана агента: по строкам видимого экрана панели и профилю-данным
// говорит, что на нём — агент ждёт ввода, работает, задаёт вопрос, просит разрешение,
// показывает известное меню — или экран не узнан. Чистые функции: ни tmux, ни сети.
//
// Правило модуля — «не узнали — молчим»: любое сомнение даёт `unknown`, потому что по
// распознанному экрану чат нажимает клавиши в сессии, где агент правит файлы.
//
// Строки принимаются такими, как их отдаёт `capture-pane -p -e`: с оформлением. Оно
// нужно ровно для одного — подсказку-заглушку в строке ввода («Try "…"», «Ask Codex to
// do anything») агенты рисуют тусклым, и без оформления она неотличима от набранного
// текста. Строки без оформления тоже разбираются, но заглушка тогда читается текстом.

import { questionStamp } from '@termhub/protocol/chat';
import type {
  BackgroundAgent,
  ChatCommand,
  QueuedMessage,
  ScreenOption,
  ScreenQuestion,
  ScreenState,
  ScreenStep,
} from '@termhub/protocol/chat';

import type { AgentProfile, DialogSign, PendingSign, QueueSign } from './agent-profiles.js';

/** Строка экрана без оформления; `dim` — номера знаков, нарисованных тусклым, `lit` —
 *  нарисованных с фоном (так агент выделяет текущий шаг полосы над вопросом). */
interface Row {
  text: string;
  dim: Set<number>;
  lit: Set<number>;
  /** В строке есть оформление. */
  styled: boolean;
  /** Строка с оформлением, в которой ни за первым знаком, ни за пробелом после него нет
   *  управляющей последовательности: знак нарисован одним куском с текстом за ним. */
  glued: boolean;
  /** Сколько раз в строке задан цвет текста: реплику беседы от сообщения очереди у Claude
   *  отличает только смена цвета после знака. У строки без оформления — ноль. */
  inks: number;
}

/** Строка ввода агента и то, что вокруг неё. */
interface Box {
  /** Первая строка блока ввода (у `ruled` — верхняя линейка). */
  top: number;
  /** Строки самого ввода. */
  first: number;
  last: number;
  /** Подвал под строкой ввода, одной строкой. */
  footer: string;
  /** Пункты строки состояния из подвала (`statusLine` профиля). */
  items: string[];
  /** Строки подвала по одной. */
  lines: string[];
}

/** Сколько строк над вариантами может занимать шапка диалога (команда, правка). */
const HEAD_LIMIT = 60;
/** Сколько строк пояснений и переносов бывает у одного варианта. */
const EXTRA_LIMIT = 8;
/** Как далеко над строкой ввода ищутся строка работы и очередь. */
const STATUS_REACH = 12;
/** Сколько строк под рамкой ввода `ruled` считается её подвалом, самое большее. */
const FOOTER_REACH = 8;
/** Сколько строк занимает блок очереди над строкой ввода, самое большее. */
const QUEUE_REACH = 60;
/** В каком хвосте экрана ищется заголовок меню. */
const MENU_REACH = 40;

const ESCAPE = /\x1b(?:\[([0-9;:?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/y;

/** Снимает оформление и запоминает, какие знаки тусклые. */
function strip(line: string): Row {
  let text = '';
  const dim = new Set<number>();
  const lit = new Set<number>();
  let faint = false;
  let back = false;
  let inks = 0;
  let styled = false;
  /** Длина текста в момент последней управляющей последовательности. */
  let seamAt = -1;
  let seam = false;
  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b) {
      ESCAPE.lastIndex = i;
      const found = ESCAPE.exec(line);
      if (found) {
        styled = true;
        seamAt = text.length;
        if (seamAt === 1 || seamAt === 2) seam = true;
        if (found[2] === 'm') {
          faint = nextFaint(found[1] ?? '', faint);
          back = nextBack(found[1] ?? '', back);
          if (setsInk(found[1] ?? '')) inks++;
        }
        i = ESCAPE.lastIndex;
        continue;
      }
    }
    if (faint) dim.add(text.length);
    if (back) lit.add(text.length);
    text += line[i];
    i++;
  }
  return { text: text.replace(/\s+$/u, ''), dim, lit, inks, styled, glued: styled && !seam && text.length > 2 };
}

/** Задаёт ли SGR-последовательность цвет текста: 30–37, 90–97 и `38;…`; сброс (39, 0) —
 *  нет. Числа внутри цвета кодами не считаются. */
function setsInk(params: string): boolean {
  const parts = params.split(';');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] === '' ? 0 : Number(parts[i]);
    if (code === 38) return true;
    if (code === 48 || code === 58) i += parts[i + 1] === '5' ? 2 : parts[i + 1] === '2' ? 4 : 0;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) return true;
  }
  return false;
}

/** Есть ли фон после SGR-последовательности: 40–47, 100–107 и `48;…` ставят его, 49 и 0
 *  снимают. Числа внутри цвета (`38;5;n`, `48;2;r;g;b`) кодами не считаются. */
function nextBack(params: string, back: boolean): boolean {
  const parts = params.split(';');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] === '' ? 0 : Number(parts[i]);
    if (code === 38 || code === 48 || code === 58) {
      if (code === 48) back = true;
      i += parts[i + 1] === '5' ? 2 : parts[i + 1] === '2' ? 4 : 0;
    } else if (code === 0 || code === 49) back = false;
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) back = true;
  }
  return back;
}

/** Тусклость после SGR-последовательности. Цвета вида `38;2;r;g;b` несут свои числа,
 *  и двойка среди них — не «тусклый». */
function nextFaint(params: string, faint: boolean): boolean {
  const parts = params.split(';');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] === '' ? 0 : Number(parts[i]);
    if (code === 38 || code === 48 || code === 58) {
      i += parts[i + 1] === '5' ? 2 : parts[i + 1] === '2' ? 4 : 0;
    } else if (code === 0 || code === 22) faint = false;
    else if (code === 2) faint = true;
  }
  return faint;
}

function blank(row: Row | undefined): boolean {
  return row === undefined || row.text.trim() === '';
}

function lastFilled(rows: Row[], from: number): number {
  let i = from;
  while (i >= 0 && blank(rows[i])) i--;
  return i;
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

/** Строка из одной псевдографики: линейка рамки или разделитель внутри диалога. */
function isSeparator(text: string): boolean {
  return /^[\s─━╌╍┄┈▔═]+$/u.test(text) && text.trim().length >= 4;
}

/** Приглашение «вопрос ждёт» на экране: какую клавишу профиля оно называет и сколько
 *  вопросов ждёт, если агент это рисует. */
export interface PendingInvite {
  key: PendingSign['key'];
  count?: number;
}

/** Приглашение «вопрос ждёт» у строки ввода агента. Нет строки ввода или приглашения —
 *  `undefined`. Тот же разбор, что ставит `pending` в `readScreen`. */
export function readPending(lines: string[], profile: AgentProfile): PendingInvite | undefined {
  const rows = lines.map(strip);
  const bottom = lastFilled(rows, rows.length - 1);
  if (bottom < 0) return undefined;
  const seen: Seen = {};
  readAbove(rows, trayOf(rows, bottom, profile).last, profile, seen);
  return seen.invite;
}

/** Каким признаком профиля узнан диалог на экране (вопрос или запрос разрешения). Экран
 *  не диалог — `undefined`. Тот же разбор, что в `readScreen`. */
export function readDialogSign(lines: string[], profile: AgentProfile): DialogSign | undefined {
  const rows = lines.map(strip);
  const bottom = lastFilled(rows, rows.length - 1);
  if (bottom < 0) return undefined;
  const seen: Seen = {};
  readAbove(rows, trayOf(rows, bottom, profile).last, profile, seen);
  return seen.dialog;
}

/** Как агент называет свой режим в подвале строки ввода (`modeLine` профиля) — в том числе
 *  режим, которого в профиле нет. Нет строки ввода или подвал режим не называет — `undefined`. */
export function readModeName(lines: string[], profile: AgentProfile): string | undefined {
  const sign = profile.screen.modeLine;
  if (!sign) return undefined;
  const rows = lines.map(strip);
  const last = lastFilled(rows, rows.length - 1);
  if (last < 0) return undefined;
  const box = findBox(rows, trayOf(rows, last, profile).last, profile);
  if (typeof box === 'string') return undefined;
  return sign.exec(box.footer)?.[1];
}

/** Что разбор экрана заметил попутно. */
interface Seen {
  invite?: PendingInvite;
  dialog?: DialogSign;
}

export function readScreen(lines: string[], profile: AgentProfile): ScreenState {
  const rows = lines.map(strip);
  const bottom = lastFilled(rows, rows.length - 1);
  if (bottom < 0) return unknown('empty screen');
  const tray = trayOf(rows, bottom, profile);
  const state = readAbove(rows, tray.last, profile);
  // Неузнанный экран фоновых не называет: список под ним ничего не доказывает.
  if (state.kind === 'unknown' || tray.agents.length === 0) return state;
  // Список нарисован — число из подвала рядом с ним лишнее.
  const { agentCount: _count, ...rest } = state;
  return { ...rest, agents: tray.agents };
}

/** Экран без списка под подвалом: `last` — его последняя строка. */
function readAbove(
  rows: Row[],
  last: number,
  profile: AgentProfile,
  seen: Seen = {},
): ScreenState {
  const signs = profile.screen;

  // Подсказка под вариантами бывает перенесена на две строки.
  const above = lastFilled(rows, last - 1);
  let hinted = false;
  for (const dialog of signs.dialogs) {
    if (!dialog.footer) continue;
    const at = [last, above].find((i) => i >= 0 && dialog.footer!.test(rows[i]!.text.trim()));
    if (at === undefined) continue;
    hinted = true;
    // Подсказка целиком: в узкой панели она занимает две строки.
    const hint = rows
      .slice(at, last + 1)
      .map((row) => row.text.trim())
      .filter((text) => text !== '')
      .join(' ');
    const question = readDialog(rows, at - 1, dialog, profile, hint);
    if (question) {
      seen.dialog = dialog;
      return { kind: dialog.kind, question };
    }
  }

  const menu = readMenu(rows, last, profile);
  if (menu) return { kind: 'menu', menu };

  const box = findBox(rows, last, profile);
  if (typeof box !== 'string') return readBox(rows, box, profile, seen);

  for (const dialog of signs.dialogs) {
    if (dialog.footer || !dialog.title) continue;
    const question = readDialog(rows, last, dialog, profile);
    if (question) {
      seen.dialog = dialog;
      return { kind: dialog.kind, question };
    }
  }
  if (hinted) return unknown('dialog not recognized');
  if (optionOf(rows[last]!.text, profile)) return unknown('dialog cut off');
  return unknown(box);
}

/** Неузнанный экран и правило, которое на нём не сошлось. Причина — слова из этого
 *  файла: текст с экрана в неё не попадает, она уходит в интерфейс и диагностику. */
function unknown(why: string): ScreenState {
  return { kind: 'unknown', why };
}

/** Список под подвалом (`tray` профиля): `last` — последняя строка экрана над ним,
 *  `agents` — его строки, кроме первой («main»). Списка нет или он устроен иначе —
 *  прежняя последняя строка и пусто: лишнее под подвалом экран не узнаёт. */
function trayOf(rows: Row[], last: number, profile: AgentProfile): { last: number; agents: BackgroundAgent[] } {
  const none = { last, agents: [] };
  const tray = profile.screen.tray;
  if (!tray) return none;
  let head = last;
  while (head >= 0 && !blank(rows[head]) && tray.item.test(rows[head]!.text)) head--;
  head++;
  const count = last - head;
  if (count < 1 || count > tray.max || !tray.head.test(rows[head]!.text)) return none;
  if (head < 2 || !blank(rows[head - 1]) || blank(rows[head - 2])) return none;
  const agents: BackgroundAgent[] = [];
  for (let i = head + 1; i <= last; i++) {
    const found = tray.entry.exec(rows[i]!.text);
    if (found) agents.push(agentOf(found[1]!, found[2]));
  }
  return { last: head - 2, agents };
}

/** Строка списка: тип, а за ним колонками — задача и «2m 2s · ↓ 94.3k tokens». Время и
 *  токены читаются только из последней колонки и только если в ней больше ничего нет. */
function agentOf(type: string, rest: string | undefined): BackgroundAgent {
  const parts = (rest ?? '').split(/\s{2,}/u).filter((part) => part !== '');
  const tail = parts[parts.length - 1];
  let elapsed: number | undefined;
  let tokens: number | undefined;
  if (tail !== undefined && TRAY_TAIL.test(tail)) {
    elapsed = secondsOf(tail);
    tokens = tokensOf(tail);
    parts.pop();
  }
  const task = parts.join('  ');
  return {
    type,
    ...(task ? { task } : {}),
    ...(elapsed === undefined ? {} : { elapsed }),
    ...(tokens === undefined ? {} : { tokens }),
  };
}

/** Колонка времени и токенов целиком: «30s», «2m 2s · ↓ 94.3k tokens», «↓ 12 tokens». */
const TRAY_TAIL =
  /^(?=\S)(?:(?:\d+h\s*)?(?:\d+m\s*)?\d+s)?(?:\s*·\s*)?(?:[↓↑]\s*\d+(?:\.\d+)?[kKmM]?\s+tokens)?$/u;

/** Счётчики фоновой работы из подвала: пункт, целиком совпавший с признаком профиля. */
function backgroundOf(box: Box, profile: AgentProfile): { shells?: number; agentCount?: number } {
  const signs = profile.screen.background;
  if (!signs) return {};
  const out: { shells?: number; agentCount?: number } = {};
  // Пункты читаются и из подвала целиком (пункт перенесён на две строки), и построчно
  // (за пунктом стоит незнакомая строка).
  for (const item of [box.footer, ...box.lines].flatMap((text) => text.split(signs.sep))) {
    const shells = signs.shells.exec(item.trim());
    if (shells) out.shells = Number(shells[1]);
    const agents = signs.agents.exec(item.trim());
    if (agents) out.agentCount = Number(agents[1]);
  }
  return out;
}

/** Список команд, который агент показывает над строкой ввода по «/». Нет списка или
 *  нет самой строки ввода — пусто. */
export function readPopup(lines: string[], profile: AgentProfile): ChatCommand[] {
  return popupOf(lines, profile).list;
}

/** Имя команды, на которой стоит указатель списка по «/»: её исполнит клавиша отправки.
 *  Списка нет или указателя в нём нет — `undefined`. */
export function readPopupPick(lines: string[], profile: AgentProfile): string | undefined {
  return popupOf(lines, profile).pick;
}

function popupOf(lines: string[], profile: AgentProfile): { list: ChatCommand[]; pick?: string } {
  const rows = lines.map(strip);
  const last = lastFilled(rows, rows.length - 1);
  if (last < 0) return { list: [] };
  const box = findBox(rows, trayOf(rows, last, profile).last, profile);
  if (typeof box === 'string') return { list: [] };
  const signs = profile.screen;

  let pick: string | undefined;
  const out: ChatCommand[] = [];
  let more: string[] = [];
  let i = box.top - 1;
  // У `open` список отделён от строки ввода одной пустой строкой.
  if (signs.box === 'open' && blank(rows[i])) i--;
  for (; i >= 0; i--) {
    const text = rows[i]!.text;
    const found = signs.popup.exec(text);
    if (found) {
      const hint = [found[2] ?? '', ...more].join(' ').trim();
      out.push({ name: found[1]!, ...(hint ? { hint } : {}), source: 'screen' });
      if (text.trimStart().startsWith(signs.prompt)) pick = found[1]!;
      more = [];
      continue;
    }
    const tail = signs.popupMore?.exec(text);
    if (!tail || more.length >= EXTRA_LIMIT) break;
    more.unshift(tail[1]!);
  }
  return { list: out.reverse(), ...(pick === undefined ? {} : { pick }) };
}

/** Открыт ли над строкой ввода список подстановки (`picker` профиля): его подсказка —
 *  последняя непустая строка над строкой ввода. Нет строки ввода — нет и списка. */
export function readPicker(lines: string[], profile: AgentProfile): boolean {
  const sign = profile.screen.picker;
  if (!sign) return false;
  const rows = lines.map(strip);
  const last = lastFilled(rows, rows.length - 1);
  if (last < 0) return false;
  const box = findBox(rows, trayOf(rows, last, profile).last, profile);
  if (typeof box === 'string') return false;
  const at = lastFilled(rows, box.top - 1);
  return at >= 0 && sign.test(rows[at]!.text);
}

function readMenu(rows: Row[], last: number, profile: AgentProfile): string | undefined {
  const bottom = rows[last]!.text.trim();
  const from = Math.max(0, last - MENU_REACH);
  for (const menu of profile.screen.menus) {
    if (menu.footer ? !menu.footer.test(bottom) : !optionOf(rows[last]!.text, profile)) continue;
    for (let i = last; i >= from; i--) {
      if (menu.sign.test(rows[i]!.text.trim())) return menu.id;
    }
  }
  return undefined;
}

interface OptionLine {
  key: string;
  label: string;
  /** Пояснение в той же строке, за колонкой пробелов после подписи. */
  hint: string;
  /** Колонка, с которой начинается подпись. */
  column: number;
  selected: boolean;
  checked?: boolean;
}

/** Строка варианта: «❯ 1. Yes», «  2. [ ] Банан», «› 1. Red      пояснение». */
function optionOf(text: string, profile: AgentProfile): OptionLine | null {
  const found = /^(\s*)(?:(\S)\s+)?(\d{1,2})\.\s+(?:\[(.)\]\s+)?(\S.*)$/u.exec(text);
  if (!found) return null;
  const pointer = found[2];
  if (pointer !== undefined && pointer !== profile.screen.prompt) return null;
  const rest = found[5]!;
  // Пояснение в той же строке отделено от подписи колонкой пробелов.
  const parts = rest.split(/\s{2,}/u);
  return {
    key: found[3]!,
    label: parts[0]!,
    hint: parts.slice(1).join(' ').trim(),
    column: text.length - rest.length,
    selected: pointer !== undefined,
    ...(found[4] === undefined ? {} : { checked: found[4] !== ' ' }),
  };
}

/** Диалог с вариантами, нижняя строка которого — `bottom`. Варианты читаются снизу
 *  вверх до первого; над ними — шапка с заголовком. Любая нестыковка — не диалог. */
function readDialog(
  rows: Row[],
  bottom: number,
  dialog: DialogSign,
  profile: AgentProfile,
  /** Подсказка под вариантами одной строкой — по ней узнаётся поле заметки. */
  hint = '',
): ScreenQuestion | null {
  const signs = profile.screen;
  // Открытое поле заметки стоит между вариантами и подсказкой. Его строка снимается до
  // разбора вариантов: набранное в нём может выглядеть как вариант («5. …»).
  let notes: string | undefined;
  if (dialog.notes?.open.test(hint)) {
    const at = lastFilled(rows, bottom);
    const found = at < 0 ? null : dialog.notes.line.exec(rows[at]!.text);
    if (!found) return null;
    // Заглушка пустого поля нарисована тусклым, как в строке ввода.
    const start = rows[at]!.text.length - found[1]!.length;
    notes = rows[at]!.dim.has(start) ? '' : found[1]!;
    bottom = at - 1;
  }
  const options: ScreenOption[] = [];
  let extra: Row[] = [];
  let ruleBelow = false;
  let top = -1;
  for (let i = bottom; i >= 0; i--) {
    const row = rows[i]!;
    if (blank(row)) continue;
    if (isSeparator(row.text)) {
      ruleBelow = true;
      continue;
    }
    const line = optionOf(row.text, profile);
    if (!line) {
      extra.push(row);
      if (extra.length > EXTRA_LIMIT) return null;
      continue;
    }
    let label = dialog.answered ? line.label.replace(dialog.answered, '') : line.label;
    const about = line.hint ? [line.hint] : [];
    // Строки под вариантом собраны снизу вверх — разворачиваем. Всё, что не перенос
    // подписи, — пояснение варианта.
    for (const more of extra.reverse()) {
      // Кнопка отправки вопроса с отметками стоит под последним вариантом, левее пояснений.
      if (
        line.checked !== undefined &&
        dialog.submitRow?.test(more.text) === true &&
        indentOf(more.text) < line.column
      ) {
        continue;
      }
      if (dialog.below === 'label' && indentOf(more.text) === line.column) {
        label += ` ${more.text.trim()}`;
      } else about.push(more.text.trim());
    }
    extra = [];
    const free = signs.free.test(label) || (dialog.freeBeforeRule === true && ruleBelow);
    ruleBelow = false;
    options.push({
      key: line.key,
      label,
      ...(about.length > 0 ? { hint: about.join(' ') } : {}),
      ...(line.selected ? { selected: true } : {}),
      ...(line.checked === undefined ? {} : { checked: line.checked }),
      ...(free ? { free: true } : {}),
    });
    if (line.key === '1') {
      top = i;
      break;
    }
  }
  if (top < 0 || options.length < 2 || extra.length > 0) return null;
  options.reverse();
  if (dialog.freeLast) options[options.length - 1]!.free = true;
  if (options.some((option, index) => option.key !== String(index + 1))) return null;
  const pointed = options.filter((option) => option.selected).length;
  if (pointed > 1) return null;
  const multi = options.some((option) => option.checked !== undefined);
  // Диалог агента всегда показывает указатель. Не на варианте он бывает только у вопроса
  // с отметками — там он стоит и на строке отправки. Без указателя это не диалог, а
  // нумерованный текст, похожий на него.
  if (pointed === 0 && !multi) return null;

  const head = readHead(rows, top - 1, dialog, profile);
  if (!head) return null;
  if (dialog.strip === true && !head.strip) return null;
  // Свой ответ заметкой: подсказка — одна из двух измеренных, и вариант, к которому
  // заметка идёт, стоит последним.
  const noted =
    dialog.notes !== undefined &&
    (notes !== undefined || dialog.notes.closed.test(hint)) &&
    dialog.notes.other.test(options[options.length - 1]!.label);
  if (notes !== undefined && !noted) return null;
  const freeText = noted || options.some((option) => option.free);
  const step = head.steps ? head.steps.findIndex((item) => item.current) + 1 : 0;
  // Вопросы одной серии бывают с одним текстом и вариантами: отпечаток серии несёт ещё
  // название текущего вопроса. Одиночный вопрос (шаг отправки не в счёт) — отпечаток прежний.
  const series = (head.steps?.filter((item) => !item.submit).length ?? 0) > 1;
  const named = series && step > 0 && !head.steps![step - 1]!.submit;
  const stampBody = named
    ? `${head.body}\u0004${head.steps![step - 1]!.label}`
    : head.place
      ? `${head.body}\u0005${head.place}`
      : head.body;
  return {
    stamp: questionStamp(head.title, options, stampBody),
    title: head.title,
    ...(head.body ? { body: head.body } : {}),
    options,
    ...(multi ? { multi: true } : {}),
    ...(freeText ? { freeText: true } : {}),
    ...(notes === undefined ? {} : { notes }),
    ...(head.steps ? { steps: head.steps } : {}),
    ...(step > 0 ? { step } : {}),
  };
}

/** Шаги полосы над вопросом; текущий — тот, чей знак нарисован с фоном. */
function stepsOf(row: Row, profile: AgentProfile): ScreenStep[] | undefined {
  const signs = profile.screen.steps;
  if (!signs) return undefined;
  const steps: ScreenStep[] = [];
  for (const found of row.text.matchAll(signs.item)) {
    steps.push({
      label: found[2]!,
      ...(found[1] === signs.done ? { done: true } : {}),
      ...(found[1] === signs.submit ? { submit: true } : {}),
      ...(row.lit.has(found.index) ? { current: true } : {}),
    });
  }
  // Два выделенных шага — полоса прочитана неверно: текущим не назван ни один.
  if (steps.filter((item) => item.current).length > 1) for (const item of steps) delete item.current;
  return steps.length > 0 ? steps : undefined;
}

/** Шапка диалога над вариантами: абзацы до линейки рамки или двойной пустой строки.
 *  Заголовок — абзац, начинающийся с `dialog.title`, а без него — последний. */
function readHead(
  rows: Row[],
  from: number,
  dialog: DialogSign,
  profile: AgentProfile,
): { title: string; body: string; steps?: ScreenStep[]; place?: string; strip: boolean } | null {
  const signs = profile.screen;
  let steps: ScreenStep[] | undefined;
  let strip = false;
  const paragraphs: string[][] = [];
  let current: string[] = [];
  const close = (): void => {
    if (current.length > 0) paragraphs.unshift(current);
    current = [];
  };
  let gap = 0;
  let seen = false;
  let under = dialog.under === undefined;
  let place: string | undefined;
  for (let i = from; i >= 0 && from - i < HEAD_LIMIT; i--) {
    const text = rows[i]!.text;
    if (signs.rule.test(text)) break;
    if (dialog.under?.test(text)) {
      under = true;
      break;
    }
    if (text.trim() === '') {
      gap++;
      // Диалог под заголовком блока кончается самим заголовком: пустые строки, сколько бы
      // их ни было, только делят абзацы вопроса.
      if (seen && gap >= 2 && dialog.under === undefined) break;
      close();
      continue;
    }
    gap = 0;
    if (isSeparator(text)) {
      close();
      continue;
    }
    // Сообщение очереди над вопросом: его первая строка и собранные под ней продолжения.
    if (dialog.skipQueue === true && signs.queue.rows?.text.test(text) === true) {
      current = [];
      continue;
    }
    seen = true;
    const counted = place === undefined ? dialog.counter?.exec(text.trim()) : undefined;
    if (counted) {
      if (Number(counted[2]) > 1) place = `${counted[1]}/${counted[2]}`;
      close();
      continue;
    }
    if (signs.chip.test(text.trim())) {
      if (dialog.notCounter?.test(text.trim())) return null;
      strip = true;
      steps ??= stepsOf(rows[i]!, profile);
      close();
      continue;
    }
    current.unshift(text.trim());
  }
  close();
  if (!under || paragraphs.length === 0) return null;

  // Под заголовком блока вопрос стоит первым абзацем, пояснение — под ним.
  const at = dialog.title
    ? paragraphs.findIndex((lines) => dialog.title!.test(lines[0]!))
    : dialog.under
      ? 0
      : paragraphs.length - 1;
  if (at < 0) return null;
  const title = paragraphs[at]!.join(' ');
  const body = paragraphs
    .filter((_, index) => index !== at)
    .map((lines) => lines.join('\n'))
    .join('\n');
  return { title, body, ...(steps ? { steps } : {}), ...(place ? { place } : {}), strip };
}

/** Строка ввода агента внизу экрана — или причина, по которой её там нет. */
function findBox(rows: Row[], last: number, profile: AgentProfile): Box | string {
  const signs = profile.screen;
  // Переписки агента на экране нет вовсе — это не оборванный экран, а чужой.
  const missing = (): string =>
    rows.some((row) => signs.talk.test(row.text)) ? 'no input frame' : 'no agent on screen';

  if (signs.box === 'ruled') {
    // Агента у строки ввода узнаёт сама рамка: две линейки и знак ввода между ними. Что
    // стоит под нижней линейкой — подвал: он читается, а не сверяется, и незнакомая строка
    // в нём экран неузнанным не делает. Предел высоты подвала — чтобы рамкой не стала
    // пара линеек из переписки далеко над низом экрана.
    let bottom = last;
    while (bottom >= 0 && last - bottom <= FOOTER_REACH && !signs.rule.test(rows[bottom]!.text)) bottom--;
    if (bottom >= 1 && signs.rule.test(rows[bottom]!.text)) {
      return ruledBox(rows, bottom, last, profile) ?? 'input frame malformed';
    }
    // Рамка есть, но выше: под её подвалом слишком много того, чего профиль не знает.
    for (let i = bottom; i >= 1; i--) {
      if (signs.rule.test(rows[i]!.text) && ruledBox(rows, i, i, profile)) {
        return 'content below footer';
      }
    }
    return missing();
  }

  // `open`: строка ввода — последний на экране блок, начатый знаком ввода с начала строки;
  // под ним пустая строка и подвал — непрерывные строки с отступом до конца экрана. Подвал
  // читается, а не сверяется: строку состояния собирает пользователь, а строка подсказок
  // под ней бывает пустой, с подсказками или с одним уведомлением справа.
  const strange = (): string =>
    rows.some((row) => signs.talk.test(row.text)) ? 'footer not recognized' : 'no agent on screen';
  const reach = (signs.footerLines ?? 1) + 1;
  let head = last;
  while (head >= 0 && last - head < reach && !blank(rows[head]) && rows[head]!.text.startsWith('  ')) head--;
  // Низ экрана без отступа — не подвал: переписка, оболочка, диалог.
  if (head === last) return strange();
  // Над подвалом обязана быть пустая строка: иначе он выше предела или приклеен к тексту.
  if (head < 0 || !blank(rows[head])) return 'no input frame';
  const block = rows.slice(head + 1, last + 1).map((row) => row.text);
  // Подсказки меню выглядят как подвал, а указатель списка — как знак ввода.
  if (block.some((text) => signs.notFooter?.test(text))) return strange();
  const end = lastFilled(rows, head);
  if (end < 0) return 'no input frame';
  let first = end;
  while (first >= 0 && !startsInput(rows[first]!.text, signs.prompt)) {
    const text = rows[first]!.text;
    if (text === '' || !text.startsWith('  ')) return 'no input frame';
    first--;
  }
  if (first < 0) return 'no input frame';
  // Тем же знаком Codex рисует указатель списков и меню. Строку ввода от пункта списка
  // отличают три вещи. Над строкой ввода всегда пустая строка (или верх экрана): пункт, над
  // которым вплотную стоят другие, — список. Знак строки ввода нарисован отдельно от текста
  // (смена оформления за ним или за пробелом), указатель списка — одним куском с пунктом. И
  // в строке без оформления пронумерованный пункт под указателем, у которого ниже стоит ещё
  // один пронумерованный, — варианты меню, а не набранный текст.
  if (first > 0 && !blank(rows[first - 1])) return 'dialog not recognized';
  if (rows[first]!.glued) return 'dialog not recognized';
  // Правило номеров — только для строки без оформления: там знак от текста не отличить.
  // С оформлением всё уже решено: знак нарисован отдельно — это строка ввода, и
  // нумерованные строки под ней — набранный список.
  if (!rows[first]!.styled && optionOf(rows[first]!.text, profile)) {
    for (let i = first + 1; i <= end; i++) {
      const below = optionOf(rows[i]!.text, profile);
      if (below && !below.selected) return 'dialog not recognized';
    }
  }
  const footer = block.join('  ');
  return { top: first, first, last: end, footer, items: itemsOf(footer, profile), lines: block.map((text) => text.trim()) };
}

function itemsOf(footer: string, profile: AgentProfile): string[] {
  const sep = profile.screen.statusLine?.sep;
  if (!sep) return [];
  return footer
    .split(sep)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** После знака Claude ставит неразрывный пробел, Codex — обычный. */
function startsInput(text: string, prompt: string): boolean {
  return text === prompt || (text.startsWith(prompt) && /^[ \u00a0]/u.test(text.slice(prompt.length)));
}

/** Рамка `ruled` с нижней линейкой `bottom`; подвал — строки под ней до `last`. */
function ruledBox(rows: Row[], bottom: number, last: number, profile: AgentProfile): Box | null {
  const signs = profile.screen;
  let top = bottom - 1;
  while (top >= 0 && !signs.rule.test(rows[top]!.text)) top--;
  if (top < 0 || top === bottom - 1) return null;
  if (!startsInput(rows[top + 1]!.text, signs.prompt)) return null;
  for (let i = top + 2; i < bottom; i++) {
    const text = rows[i]!.text;
    if (text !== '' && !text.startsWith('  ')) return null;
  }
  const lines = rows.slice(bottom + 1, last + 1).map((row) => row.text.trim());
  const footer = lines.join(' ');
  return { top, first: top + 1, last: bottom - 1, footer, items: itemsOf(footer, profile), lines };
}

/** Приглашение «вопрос ждёт»: признак в подвале либо блок прямо над строкой ввода —
 *  последние непустые строки над ней, от строки с отступом вверх до заголовка. */
function pendingOf(rows: Row[], box: Box, profile: AgentProfile): PendingInvite | undefined {
  for (const sign of profile.screen.pending ?? []) {
    if (sign.footer?.test(box.footer)) return { key: sign.key };
    const block = sign.block;
    if (!block) continue;
    const end = lastFilled(rows, box.top - 1);
    let head = end;
    while (head >= 0 && end - head < STATUS_REACH && /^\s/u.test(rows[head]!.text)) head--;
    if (head < 0 || head === end || !block.head.test(rows[head]!.text)) continue;
    for (let i = head + 1; i < end; i++) {
      const found = block.count.exec(rows[i]!.text);
      const hint = rows[i + 1]!;
      if (found && block.hint.test(hint.text) && hint.dim.size > 0) return { key: sign.key, count: Number(found[1]) };
    }
  }
  return undefined;
}

function readBox(
  rows: Row[],
  box: Box,
  profile: AgentProfile,
  seen: Seen = {},
): ScreenState {
  const signs = profile.screen;
  const head = rows[box.first]!;
  const start = signs.prompt.length + 1;
  // Заглушка нарисована тусклым: это подсказка агента, а не набранный текст.
  const placeholder = head.dim.has(start);
  const input = placeholder
    ? ''
    : rows
        .slice(box.first, box.last + 1)
        .map((row, index) => (index === 0 ? row.text.slice(start) : row.text.slice(2)))
        .join('\n')
        .replace(/\s+$/u, '');

  let status: string | undefined;
  let elapsed: number | undefined;
  let tokens: number | undefined;
  let waiting: number | undefined;
  // Строка ожидания считается состоянием, только пока между ней и строкой ввода нет
  // переписки: выше по экрану она же стоит строкой прошлого хода.
  let fresh = signs.waiting !== undefined;
  let queued = 0;
  let under = -1;
  let statusAt = -1;
  const reach = Math.max(0, box.top - STATUS_REACH);
  for (let i = box.top - 1; i >= reach; i--) {
    const text = rows[i]!.text;
    if (status === undefined) {
      const found = signs.status.exec(text);
      if (found) {
        statusAt = i;
        status = found[1]!;
        elapsed = secondsOf(found[2]);
        tokens = tokensOf(found[2]);
        // Очередь `under` и строка ожидания стоят выше строки работы — ищем дальше;
        // без них всё найдено.
        if (!signs.queue.under && !signs.waiting) break;
        continue;
      }
    }
    if (fresh && text !== '') {
      const found = signs.waiting!.exec(text);
      if (found) waiting = Number(found[1]);
      // Строки с отступом — подсказки и подписи под строкой работы, не переписка.
      if (found || !/^\s/u.test(text)) fresh = false;
    }
    if (signs.queue.under) {
      if (signs.queue.under.test(text)) under = i;
    } else if (signs.queue.item.test(text)) queued++;
  }
  // Беседа короткая, панель высокая — блок очереди стоит далеко над строкой работы:
  // подпись очереди тогда первая непустая строка над ней.
  if (under < 0 && signs.queue.under && statusAt >= 0) {
    const far = lastFilled(rows, statusAt - 1);
    if (far >= 0 && signs.queue.under.test(rows[far]!.text)) under = far;
  }
  let queue: QueuedMessage[] | undefined;
  /** Последняя строка блока очереди — под ней ищется подпись клавиши возврата. */
  let queueEnd = -1;
  if (under >= 0) {
    // Сообщения стоят над подписью, между ними — по пустой строке; у сообщения из
    // нескольких строк знак только в первой.
    let top = under;
    let i = under - 1;
    while (i >= 0) {
      let first = i;
      while (
        first >= 0 &&
        !signs.queue.item.test(rows[first]!.text) &&
        rows[first]!.text !== '' &&
        rows[first]!.text.startsWith('  ')
      ) {
        first--;
      }
      if (first < 0 || !signs.queue.item.test(rows[first]!.text)) break;
      // Реплика беседы над очередью начинается тем же знаком, но меняет цвет после него.
      if (signs.queue.rows?.flat === true && rows[first]!.inks > 1) break;
      queued++;
      top = first;
      i = blank(rows[first - 1]) ? first - 2 : first - 1;
    }
    queue = queueTexts(rows, top, under - 1, signs.queue);
  } else if (!signs.queue.under && queued > 0) {
    // Блок прямо над строкой ввода: строки с отступом вверх до заголовка без отступа.
    const end = lastFilled(rows, box.top - 1);
    let top = end + 1;
    const inBlock = (at: number): boolean => at >= 0 && /^\s{2}\S|^\s{4}/u.test(rows[at]!.text);
    // Пустая строка внутри блока — абзац в сообщении: над ней обязана стоять строка блока.
    while (
      top - 1 >= 0 &&
      end - top < QUEUE_REACH &&
      (inBlock(top - 1) || (blank(rows[top - 1]) && inBlock(top - 2)))
    ) {
      top--;
    }
    if (top <= end && top >= 1 && !blank(rows[top - 1]) && !/^\s/u.test(rows[top - 1]!.text)) {
      queue = queueTexts(rows, top, end, signs.queue);
      queueEnd = end;
    }
  }
  if (queue) queued = Math.max(queued, queue.length);

  // Состояние из строки состояния: строки работы над вводом может не быть на экране.
  const state = signs.statusLine;
  const busy = state ? box.items.find((item) => state.working.test(item)) : undefined;
  const ready = state ? box.items.some((item) => state.idle.test(item)) : false;
  status ??= busy;
  // Ожидание фоновых агентов работой само не считается: ход агента окончен, строка
  // ввода принимает запрос сразу; работу называют строка работы и подвал.
  const working = status !== undefined || signs.working?.test(box.footer) === true;
  const model = modelOf(box.items, profile);
  const mode = modeOf(box.footer, profile, model !== undefined || busy !== undefined || ready);
  const invite = pendingOf(rows, box, profile);
  if (invite) seen.invite = invite;
  // Клавишу возврата из очереди называет сам экран; годится она только при пустой строке
  // ввода и только когда в очереди нет вопроса — ему та же клавиша отвечает.
  const edit = signs.queue.edit;
  let queueEdit: 'last' | 'all' | undefined;
  if (edit && queue && queue.length > 0 && input === '' && !invite) {
    const named =
      edit.where === 'placeholder'
        ? placeholder && edit.sign.test(head.text.slice(start).trim())
        : queueEnd >= 0 && edit.sign.test(rows[queueEnd]!.text);
    if (named) queueEdit = edit.scope;
  }
  // «Отправить сейчас» называет подпись, под которой стоит очередь; строка ввода пуста.
  const queueSend =
    profile.keys.sendNow !== undefined && under >= 0 && !!queue && queue.length > 0 && input === '' && !invite;
  return {
    kind: working ? 'working' : 'idle',
    ...(status === undefined ? {} : { status }),
    ...(elapsed === undefined ? {} : { elapsed }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(waiting === undefined ? {} : { waiting }),
    ...(mode === undefined ? {} : { mode }),
    input,
    ...(queued > 0 ? { queued } : {}),
    ...(queue && queue.length > 0 ? { queue } : {}),
    ...(queueEdit === undefined ? {} : { queueEdit }),
    ...(queueSend ? { queueSend: true } : {}),
    ...(model === undefined ? {} : { model }),
    ...backgroundOf(box, profile),
    ...(invite ? { pending: true } : {}),
  };
}

/** Тексты сообщений очереди в строках `from…to`, сверху вниз. Строка, которая не сообщение
 *  и не его продолжение, сообщение закрывает: её собственные продолжения ничьи. Профиль
 *  тексты не описывает — `undefined`. */
function queueTexts(rows: Row[], from: number, to: number, sign: QueueSign): QueuedMessage[] | undefined {
  const shape = sign.rows;
  if (!shape) return undefined;
  const out: QueuedMessage[] = [];
  let open: { lines: string[]; cut: boolean } | undefined;
  const close = (): void => {
    if (open) out.push({ text: open.lines.join('\n'), ...(open.cut ? { cut: true } : {}) });
    open = undefined;
  };
  for (let i = from; i <= to; i++) {
    const text = rows[i]!.text;
    const first = shape.text.exec(text);
    if (first) {
      close();
      open = { lines: [first[1]!], cut: false };
      continue;
    }
    if (open && shape.cut?.test(text)) {
      open.cut = true;
      continue;
    }
    if (open && sign.edit?.where === 'below' && sign.edit.sign.test(text)) {
      close();
      continue;
    }
    // Пустая строка внутри сообщения (абзац): за ней обязано идти его продолжение.
    if (open && !open.cut && text.trim() === '' && i < to) {
      const next = rows[i + 1]!.text;
      if (!shape.text.test(next) && (shape.cut?.test(next) || (next.trim() !== '' && shape.more.test(next)))) {
        open.lines.push('');
        continue;
      }
    }
    const more = open && !open.cut ? shape.more.exec(text) : null;
    if (more) open!.lines.push(more[1]!);
    else close();
  }
  close();
  return out;
}

/** «6s · ↓ 179 tokens», «1m 05s» → секунды; времени нет — `undefined`. */
function secondsOf(text: string | undefined): number | undefined {
  const found = /(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s\b/u.exec(text ?? '');
  if (!found) return undefined;
  return Number(found[1] ?? 0) * 3600 + Number(found[2] ?? 0) * 60 + Number(found[3]);
}

/** «6s · ↓ 179 tokens», «↑ 2.1k tokens» → число токенов; их в строке нет — `undefined`. */
function tokensOf(text: string | undefined): number | undefined {
  const found = /[↓↑]\s*(\d+(?:\.\d+)?)([kKmM]?)\s+tokens\b/u.exec(text ?? '');
  if (!found) return undefined;
  const scale = found[2] === '' ? 1 : /k/i.test(found[2]!) ? 1_000 : 1_000_000;
  return Math.round(Number(found[1]) * scale);
}

/** Модель среди пунктов строки состояния: имя из профиля, а у модели, которой в
 *  профиле ещё нет, — одно слово с уровнем рассуждений за ним. Уровень отбрасывается. */
function modelOf(items: string[], profile: AgentProfile): string | undefined {
  let guess: string | undefined;
  for (const item of items) {
    const words = item.split(/\s+/u);
    const effort = words.length > 1 && profile.efforts.includes(words[words.length - 1]!);
    if (effort) words.pop();
    const name = words.join(' ');
    if (profile.models.some((model) => model.match.test(name))) return name;
    if (effort && words.length === 1 && !/[\/~]/u.test(name)) guess ??= name;
  }
  return guess;
}

/** Режим из подвала. Режим без признака (обычный у Codex) называется, только когда
 *  подвал — действительно строка состояния (`stated`: в нём нашлись модель или
 *  состояние), а не разовая подсказка на её месте. */
function modeOf(footer: string, profile: AgentProfile, stated: boolean): string | undefined {
  const named = profile.modes.find((mode) => mode.sign?.test(footer));
  if (named) return named.id;
  if (!stated) return undefined;
  return profile.modes.find((mode) => !mode.sign)?.id;
}
