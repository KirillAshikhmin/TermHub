// Живое состояние и действия чата: что сейчас на экране агента в сессии и нажатия клавиш
// за человека — отправить запрос, ответить на вопрос, прервать, сменить режим, открыть
// меню модели, сжать контекст, забрать текст из строки агента.
//
// Правило модуля — «не распознали — молчим». Перед любыми клавишами экран перечитывается;
// каждый следующий шаг многошагового действия ждёт, пока экран подтвердит предыдущий, и
// при первой нестыковке действие останавливается причиной `stale` — дальше клавиши не
// идут. Чат не клиент tmux: чтение и ввод — одноразовые вызовы `pane-io`, размер окна
// они не трогают.

import fsp from 'node:fs/promises';
import os from 'node:os';

import type {
  ActResult,
  AgentId,
  ChatAction,
  ChatFailure,
  LiveResult,
  ScreenOption,
  ScreenState,
} from '@termhub/protocol/chat';

import { profileOf, isTested, type AgentProfile, type NotesSign } from './agent-profiles.js';
import { readPending, readPicker, readPopup, readPopupPick, readScreen, type PendingInvite } from './agent-screen.js';
import { resolve as resolvePane, HEAD_BYTES, type TranscriptResult } from './agent-transcript.js';
import { capturePane, pasteText, sendKeys, type PaneShot } from './pane-io.js';
import { isExistingSessionName } from './tmux-session.js';

/** Версия и модель агента — то, чего экран не называет. */
export interface AgentInfo {
  version?: string;
  model?: string;
}

/** Источники — единственный шов: живой tmux, определитель и чтение транскрипта
 *  подменяются здесь и только здесь. */
export interface LiveSources {
  home: string;
  /** Сокет tmux рабочих сессий (в проде — config.TMUX_SOCKET). */
  socketName?: string;
  capture(session: string): Promise<PaneShot>;
  /** `pane` — адрес из снимка: клавиши идут в панель, чей экран сверяли. */
  send(session: string, bytes: Uint8Array, pane?: string): Promise<void>;
  paste(session: string, text: string, pane?: string): Promise<void>;
  resolve(pane: string): Promise<TranscriptResult>;
  /** Версия и модель: `file` — текущий файл беседы (его может ещё не быть),
   *  `command` — команда панели. */
  version(agent: AgentId, file: string | undefined, command: string): Promise<AgentInfo>;
  sleep(ms: number): Promise<void>;
}

/** Шаг опроса экрана после клавиш. */
const STEP_MS = 120;
/** Сколько ждать, что экран подтвердит шаг. */
const SETTLE_MS = 2400;
/** Сколько опросов подряд экран обязан не меняться, чтобы считаться устоявшимся. */
const CALM_STEPS = 2;
/** Сколько ждать меню модели (история 49а). */
const MENU_MS = 5000;
/** Пауза между нажатиями стирания строки: в замере они шли раздельно. */
const KEY_GAP_MS = 300;
/** Хвост транскрипта, в котором ищутся версия и модель. */
const TAIL_BYTES = 256 * 1024;

/** Путь ответа с несколькими отметками: клавиша перехода к подтверждению и подпись
 *  варианта, который отправляет ответы. Измерено только у Claude (docs/native-agent-ui). */
const MULTI_FLOW: Partial<Record<AgentId, { next: string; submit: RegExp }>> = {
  claude: { next: '\x1b[C', submit: /^Submit answers$/ },
};

const UNKNOWN: ScreenState = { kind: 'unknown' };
const encoder = new TextEncoder();

/** Состояние экрана агента в сессии. Не бросает: любой сбой — причиной отказа. */
export async function sessionLive(session: string, sources?: Partial<LiveSources>): Promise<LiveResult> {
  const src = withDefaults(sources);
  try {
    const ctx = await look(session, src);
    if (!ctx.ok) return ctx;
    const { profile, screen } = ctx;
    const info = await src.version(ctx.agent, ctx.file, ctx.command).catch((): AgentInfo => ({}));
    // Экран называет модель сейчас (Codex), транскрипт — по последнему ответу.
    const model = screen.model ?? info.model;
    return {
      ok: true,
      agent: ctx.agent,
      ...(info.version === undefined ? {} : { version: info.version }),
      tested: isTested(ctx.agent, info.version),
      ...(model === undefined ? {} : { model }),
      screen,
      modes: profile.modes.map(({ id, label }) => ({ id, label })),
      models: profile.models.map(({ id, label }) => ({ id, label })),
    };
  } catch (err) {
    return fail('lookup-failed', `cannot read the screen of ${session}: ${describe(err)}`);
  }
}

/** Действие чата: клавиши в панель агента после сверки экрана. Не бросает. Действия
 *  одной сессии идут строго по очереди — два сразу перемешали бы клавиши. */
export function sessionAct(session: string, action: ChatAction, sources?: Partial<LiveSources>): Promise<ActResult> {
  const src = withDefaults(sources);
  return sessionQueue(session, src.socketName, async () => {
    try {
      const ctx = await look(session, src);
      if (!ctx.ok) return ctx;
      return await run(ctx, action);
    } catch (err) {
      return fail('lookup-failed', `cannot act in ${session}: ${describe(err)}`);
    }
  });
}

/** Очередь клавиш сессии (ключ — сокет tmux и имя сессии): всё, что нажимает клавиши в
 *  панели агента, идёт через неё — действия чата и сверка списка команд. */
export function sessionQueue<T>(session: string, socketName: string | undefined, job: () => Promise<T>): Promise<T> {
  return serial(`${socketName ?? ''}\u0000${session}`, job);
}

interface Ctx {
  ok: true;
  session: string;
  src: LiveSources;
  agent: AgentId;
  profile: AgentProfile;
  pane: string;
  command: string;
  file: string | undefined;
  screen: ScreenState;
  /** Приглашение «вопрос ждёт» на этом экране: какая клавиша им названа. */
  invite: PendingInvite | undefined;
}

/** Сессия → снимок экрана → агент панели → распознанный экран. */
async function look(session: string, src: LiveSources): Promise<Ctx | ChatFailure> {
  if (!isExistingSessionName(session)) return fail('lookup-failed', `session name is not a session name: «${session}»`);
  let shot: PaneShot;
  try {
    shot = await src.capture(session);
  } catch (err) {
    return fail('lookup-failed', `cannot read the screen of ${session}: ${describe(err)}`);
  }
  const found = await src.resolve(shot.pane);
  let agent: AgentId;
  let file: string | undefined;
  if (found.ok) {
    if (found.agent === 'opencode') return fail('unknown-format', 'chat is not available for opencode sessions');
    agent = found.agent;
    file = found.files.at(-1);
  } else if (found.reason === 'no-transcript' && claudeCommand(shot.command)) {
    // Агент есть, беседы на диске ещё нет (её не начинали): чат обязан дать написать
    // первый запрос. Агента называет команда панели — Claude зовёт процесс версией.
    agent = 'claude';
  } else {
    return { ok: false, reason: found.reason, detail: found.detail };
  }
  const profile = profileOf(agent);
  return {
    ok: true,
    session,
    src,
    agent,
    profile,
    pane: shot.pane,
    command: shot.command,
    file,
    screen: readScreen(shot.lines, profile),
    invite: readPending(shot.lines, profile),
  };
}

function claudeCommand(command: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(command) || /^claude\b/.test(command);
}

/** Экран той же панели заново. Активной стала другая панель — экран «не узнан»:
 *  сверять чужой экран и слать по нему клавиши нельзя. */
async function peek(ctx: Ctx): Promise<ScreenState> {
  const shot = await ctx.src.capture(ctx.session);
  if (shot.pane !== ctx.pane) return UNKNOWN;
  return readScreen(shot.lines, ctx.profile);
}

interface Seen {
  screen: ScreenState;
  invite: PendingInvite | undefined;
  lines: string[];
}

/** То же, что `peek`, но со строками экрана и приглашением «вопрос ждёт». */
async function peekSeen(ctx: Ctx): Promise<Seen> {
  const shot = await ctx.src.capture(ctx.session);
  if (shot.pane !== ctx.pane) return { screen: UNKNOWN, invite: undefined, lines: [] };
  return {
    screen: readScreen(shot.lines, ctx.profile),
    invite: readPending(shot.lines, ctx.profile),
    lines: shot.lines,
  };
}

/** Ждёт, пока экран подтвердит шаг. `met: false` — срок вышел, экран — последний. */
async function until(
  ctx: Ctx,
  ok: (screen: ScreenState) => boolean,
  ms: number = SETTLE_MS,
): Promise<{ screen: ScreenState; met: boolean }> {
  let screen: ScreenState = UNKNOWN;
  for (let i = Math.ceil(ms / STEP_MS); i > 0; i--) {
    await ctx.src.sleep(STEP_MS);
    screen = await peek(ctx);
    if (ok(screen)) return { screen, met: true };
  }
  return { screen, met: false };
}

function press(ctx: Ctx, keys: string): Promise<void> {
  return ctx.src.send(ctx.session, encoder.encode(keys), ctx.pane);
}

/** Строка ввода агента на экране: ждёт или работает. */
function atInput(screen: ScreenState): boolean {
  return screen.kind === 'idle' || screen.kind === 'working';
}

function differs(a: ScreenState, b: ScreenState): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

async function run(ctx: Ctx, action: ChatAction): Promise<ActResult> {
  const { screen, profile } = ctx;
  if (action.kind === 'interrupt') {
    // На ожидании ввода прерывать нечего, а Esc там не безобиден (два подряд у Claude —
    // меню отката).
    if (screen.kind === 'idle') return done(screen);
    await press(ctx, profile.keys.interrupt);
    return done((await until(ctx, (s) => differs(s, screen))).screen);
  }
  if (screen.kind === 'unknown' || screen.kind === 'menu') {
    return fail('stale', `agent screen is ${screen.kind === 'menu' ? 'a menu' : 'not recognized'}`);
  }
  switch (action.kind) {
    case 'prompt':
      return prompt(ctx, action);
    case 'answer':
      return answer(ctx, action);
    case 'show-question':
      return showQuestion(ctx);
    case 'step':
      return step(ctx, action);
    case 'mode':
      return mode(ctx, action.to);
    case 'model':
      return command(ctx, profile.commands.model, 'model');
    case 'compact':
      return command(ctx, profile.commands.compact);
    case 'take-input':
      return takeInput(ctx);
    default:
      return fail('unsupported', 'unknown action');
  }
}

async function prompt(ctx: Ctx, action: Extract<ChatAction, { kind: 'prompt' }>): Promise<ActResult> {
  const { screen, profile } = ctx;
  if (!atInput(screen)) return fail('stale', 'agent is not at its input line');
  const text = typeof action.text === 'string' ? action.text.replace(/\s+$/u, '') : '';
  if (text.trim() === '') return fail('unsupported', 'empty prompt');
  if (screen.input) {
    if (action.over !== true) return fail('stale', 'agent input line already has text');
    // Стирание строки у работающего агента — это его клавиша прерывания.
    if (screen.kind !== 'idle') return fail('busy', 'agent is working: its input line cannot be cleared now');
    const cleared = await clearInput(ctx);
    if (!cleared) return fail('stale', 'agent input line did not clear');
  }
  // Список упоминаний открывается с задержкой, и при нём клавиша очереди вставляет
  // выбранное: такой текст работающему агенту не шлём вовсе.
  if (screen.kind === 'working' && profile.keys.queue !== undefined && profile.screen.mention?.test(text)) {
    return fail(
      'busy',
      'agent is working: a message ending with an @mention can be sent when the agent finishes its turn',
    );
  }
  await ctx.src.paste(ctx.session, text, ctx.pane);
  const typed = await until(ctx, (s) => atInput(s) && !!s.input);
  if (!typed.met) {
    // Экран после вставки не узнан: стирать по нему нечем, вслепую клавиши не идут.
    const left = profile.keys.queue !== undefined && screen.kind === 'working' && !atInput(typed.screen);
    return fail(
      'stale',
      `pasted text did not show up in the agent input line${left ? '; it may be left in the agent input line' : ''}`,
    );
  }
  // Работающему агенту запрос ставится в очередь клавишей профиля, если она у него своя.
  let working = typed.screen.kind === 'working';
  if (profile.keys.queue !== undefined) {
    const checked = await checkLists(ctx);
    if (typeof checked !== 'boolean') return checked;
    working = checked;
  }
  const queue = working ? profile.keys.queue : undefined;
  await press(ctx, queue ?? profile.keys.submit);
  const sent = await until(ctx, (s) => !atInput(s) || !s.input);
  if (queue === undefined || sent.met) return done(sent.screen);
  // Клавиша очереди текст не забрала. Строка до вставки была пуста — в ней только наше.
  const swept = await sweepInput(ctx, sent.screen);
  return fail(
    'stale',
    `the agent did not queue the message; the pasted text ${swept ? 'was removed from' : 'is left in'} the agent input line`,
  );
}

/** Сверка после вставки у агента с клавишей очереди: работает ли он (`true`) — либо отказ,
 *  если клавиша отправила бы не то, что набрано. Тогда вставленное убирается, клавиши
 *  отправки и очереди не идут. Отказ дают: список упоминаний над строкой; список команд,
 *  если набранное не та его строка, что будет исполнена (у работающего — не единственная
 *  строка целиком: только это измерено); у работающего — команда одним словом без списка
 *  (что делает там клавиша очереди, не измерено). */
async function checkLists(ctx: Ctx): Promise<boolean | ChatFailure> {
  const seen = await peekSeen(ctx);
  const input = seen.screen.input;
  if (!atInput(seen.screen) || !input) {
    return fail('stale', 'the agent screen changed after the paste; the pasted text may be left in the agent input line');
  }
  const working = seen.screen.kind === 'working';
  const list = readPopup(seen.lines, ctx.profile);
  let why: string | undefined;
  if (readPicker(seen.lines, ctx.profile)) why = 'the agent shows a completion list at its input line';
  else if (list.length > 0) {
    const exact = working
      ? list.length === 1 && `/${list[0]!.name}` === input
      : `/${readPopupPick(seen.lines, ctx.profile) ?? ''}` === input;
    if (!exact) why = 'the agent shows a completion list at its input line and the text is not the command it would run';
  } else if (working && /^\/\S*$/u.test(input)) why = 'the agent is working and does not list this command';
  if (why === undefined) return working;
  const swept = await sweepInput(ctx, seen.screen);
  return fail(
    working ? 'busy' : 'stale',
    `${why}${working ? ': the command can be sent when the agent finishes its turn' : ''}; the pasted text ${swept ? 'was removed from' : 'is left in'} the agent input line`,
  );
}

/** Убирает текст из строки ввода агента клавишей `clearBusy` профиля: она стирает строку
 *  и работу не трогает. Нажатие идёт только по экрану со строкой ввода, и строка непуста;
 *  строк несколько — нажатий до двух на строку (текст, затем перенос). */
async function sweepInput(ctx: Ctx, from: ScreenState): Promise<boolean> {
  const key = ctx.profile.keys.clearBusy;
  if (key === undefined) return false;
  let now = from;
  const limit = 2 * (now.input ?? '').split('\n').length + 2;
  for (let i = 0; i < limit && atInput(now) && !!now.input; i++) {
    await press(ctx, key);
    await ctx.src.sleep(KEY_GAP_MS);
    now = await peek(ctx);
  }
  return atInput(now) && now.input === '';
}

/** Стирает строку ввода агента клавишами профиля. Только при непустой строке и только
 *  на ожидании ввода — это проверяет вызывающий. */
async function clearInput(ctx: Ctx): Promise<ScreenState | null> {
  for (const key of ctx.profile.keys.clearInput) {
    await press(ctx, key);
    await ctx.src.sleep(KEY_GAP_MS);
  }
  const after = await until(ctx, (s) => s.kind === 'idle' && s.input === '');
  return after.met ? after.screen : null;
}

async function takeInput(ctx: Ctx): Promise<ActResult> {
  const { screen } = ctx;
  if (!atInput(screen)) return fail('stale', 'agent is not at its input line');
  const taken = screen.input ?? '';
  if (taken === '') return { ok: true, screen, taken };
  if (screen.kind !== 'idle') return fail('busy', 'agent is working: its input line cannot be cleared now');
  const cleared = await clearInput(ctx);
  if (!cleared) return fail('stale', 'agent input line did not clear');
  return { ok: true, screen: cleared, taken };
}

/** Команда агента: набрать в пустой строке, убедиться, что набралась она, отправить.
 *  `menu` — меню, которое команда обязана открыть: тогда ждём его. */
async function command(ctx: Ctx, name: string, menu?: string): Promise<ActResult> {
  const { screen, profile } = ctx;
  if (screen.kind === 'working') return fail('busy', 'agent is working');
  if (screen.kind !== 'idle') return fail('stale', 'agent is not at its input line');
  if (screen.input) return fail('stale', 'agent input line already has text');
  const line = `/${name}`;
  await press(ctx, line);
  const typed = await until(ctx, (s) => s.kind === 'idle' && s.input === line);
  if (!typed.met) return fail('stale', `command ${line} did not show up in the agent input line`);
  await press(ctx, profile.keys.submit);
  // Меню не открылось — отвечаем фактическим экраном: открылось ли, решает вызывающий.
  const after = menu
    ? await until(ctx, (s) => s.kind === 'menu' && s.menu === menu, MENU_MS)
    : await until(ctx, (s) => differs(s, typed.screen));
  return done(after.screen);
}

/** Режим: клавиша цикла до нужного, с проверкой экраном после каждого нажатия и не
 *  больше числа режимов. Нажатие, после которого режим не сменился, — последнее. */
async function mode(ctx: Ctx, to: unknown): Promise<ActResult> {
  const { profile } = ctx;
  if (!profile.modes.some((m) => m.id === to)) return fail('unsupported', 'agent has no such mode');
  let now = ctx.screen;
  if (!atInput(now) || now.mode === undefined) return fail('stale', 'agent mode is not readable on screen');
  for (let i = 0; i < profile.modes.length && now.mode !== to; i++) {
    const before = now.mode;
    await press(ctx, profile.keys.modeCycle);
    const next = await until(ctx, (s) => atInput(s) && s.mode !== undefined && s.mode !== before);
    if (!atInput(next.screen)) return fail('stale', 'agent screen changed while switching the mode');
    now = next.screen;
    if (!next.met) break;
  }
  return done(now);
}

/** Ожидающий вопрос: агент говорит о нём приглашением и показывает по клавише. Клавишу
 *  называет приглашение, которое сейчас на экране; идёт она один раз. Обычное
 *  приглашение обязано открыть вопрос — иначе отказ. Приглашение `anyScreen`: после
 *  клавиши ждём устоявшийся экран и отдаём его как есть — вопрос, иной экран или
 *  неузнанный (чат покажет его окошком терминала); ни повторных, ни возвратных клавиш.
 *  Приглашение осталось на месте прежним — клавиша не сработала, `stale`. */
async function showQuestion(ctx: Ctx): Promise<ActResult> {
  const { screen, profile, invite } = ctx;
  if (!atInput(screen) || screen.pending !== true || !invite) {
    return fail('stale', 'no pending question on the agent screen');
  }
  const key = profile.keys[invite.key];
  if (key === undefined) return fail('unsupported', 'agent has no key to show a pending question');
  const sign = profile.screen.pending?.find((item) => item.key === invite.key);
  await press(ctx, key);
  const isQuestion = (s: ScreenState): boolean =>
    (s.kind === 'question' || s.kind === 'permission') && s.question !== undefined;
  if (sign?.anyScreen !== true) {
    const opened = await until(ctx, isQuestion);
    return opened.met ? done(opened.screen) : fail('stale', 'the pending question did not open');
  }
  let last: Seen = { screen: UNKNOWN, invite: undefined, lines: [] };
  let calm = 0;
  for (let i = Math.ceil(SETTLE_MS / STEP_MS); i > 0; i--) {
    await ctx.src.sleep(STEP_MS);
    const now = await peekSeen(ctx);
    if (isQuestion(now.screen)) return done(now.screen);
    calm = sameLines(now.lines, last.lines) ? calm + 1 : 0;
    last = now;
    // Приглашения прежнего вида нет, и экран перестал меняться — он и есть ответ.
    if (!sameInvite(now.invite, invite) && calm >= CALM_STEPS) break;
  }
  if (sameInvite(last.invite, invite)) return fail('stale', 'the pending question prompt did not change');
  return done(last.screen);
}

function sameInvite(a: PendingInvite | undefined, b: PendingInvite): boolean {
  return a !== undefined && a.key === b.key && a.count === b.count;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** Переход к шагу полосы над вопросом: по клавише на шаг, после каждой экран обязан
 *  показать соседний шаг той же полосы — иначе остановка. */
async function step(ctx: Ctx, action: Extract<ChatAction, { kind: 'step' }>): Promise<ActResult> {
  const { screen, profile } = ctx;
  const question = screen.question;
  if (screen.kind !== 'question' || !question) return fail('stale', 'no question on the agent screen');
  if (typeof action.stamp !== 'string' || action.stamp !== question.stamp) {
    return fail('stale', 'the question on the agent screen is a different one');
  }
  const { stepNext, stepPrev } = profile.keys;
  const names = question.steps?.map((item) => item.label);
  if (!names || question.step === undefined || stepNext === undefined || stepPrev === undefined) {
    return fail('unsupported', 'this question has no steps to move between');
  }
  if (!Number.isInteger(action.to) || action.to < 1 || action.to > names.length) {
    return fail('unsupported', 'no such step in the question');
  }
  const bar = names.join('\u0000');
  let now = question.step;
  let last = screen;
  while (now !== action.to) {
    const next = now + (action.to > now ? 1 : -1);
    await press(ctx, action.to > now ? stepNext : stepPrev);
    const moved = await until(
      ctx,
      (s) =>
        s.kind === 'question' &&
        s.question?.step === next &&
        s.question.steps?.map((item) => item.label).join('\u0000') === bar,
    );
    if (!moved.met) return fail('stale', 'the agent screen did not follow the step');
    now = next;
    last = moved.screen;
  }
  return done(last);
}

async function answer(ctx: Ctx, action: Extract<ChatAction, { kind: 'answer' }>): Promise<ActResult> {
  const { screen, profile } = ctx;
  const question = screen.question;
  if ((screen.kind !== 'question' && screen.kind !== 'permission') || !question) {
    return fail('stale', 'no question on the agent screen');
  }
  // Отпечаток считает распознавание по свежему экрану; здесь он только сравнивается.
  if (typeof action.stamp !== 'string' || action.stamp !== question.stamp) {
    return fail('stale', 'the question on the agent screen is a different one');
  }
  const same = (s: ScreenState): boolean => s.kind === screen.kind && s.question?.stamp === question.stamp;
  const stopped = (): ActResult => fail('stale', 'the agent screen did not follow the answer step');
  // Ответ принят, когда вопроса на экране больше нет, а сам экран узнан: кадр посреди
  // перерисовки не успех — ждём следующий; не дождались — отказ.
  const gone = async (): Promise<ActResult> => {
    const after = await until(ctx, (s) => !same(s) && s.kind !== 'unknown');
    return after.met ? done(after.screen) : stopped();
  };

  if (action.text !== undefined) {
    // Свой ответ: клавиша свободного варианта ставит на него указатель, текст набирается
    // в его строке, клавиша отправки отвечает.
    const free = question.options.find((o) => o.free);
    const noted = free ? undefined : notesOf(ctx);
    if ((!free && !noted) || question.multi) return fail('unsupported', 'this question takes no free-text answer');
    const target = free ?? question.options[question.options.length - 1]!;
    if (action.option !== undefined && action.option !== target.key) {
      return fail('unsupported', 'free text goes with the free-text option only');
    }
    const text =
      typeof action.text === 'string'
        ? action.text
            .replace(/\s*[\r\n]+\s*/g, ' ')
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .trim()
        : '';
    if (text === '') return fail('unsupported', 'empty answer');
    if (!free) {
      // Свой ответ заметкой (Codex): указатель стрелкой до последнего варианта, клавиша
      // заметки открывает поле, текст набирается в нём, клавиша отправки отвечает.
      const { optionDown, notes: notesKey } = profile.keys;
      if (optionDown === undefined || notesKey === undefined) {
        return fail('unsupported', 'this question takes no free-text answer');
      }
      const keys = question.options.map((o) => o.key);
      const at = (s: ScreenState): number => keys.indexOf(selectedKey(s) ?? '');
      const last = keys.length - 1;
      if (question.notes !== undefined) {
        // Поле уже открыто: набранное до нас не дополняем, чужой вариант не трогаем.
        if (question.notes !== '') return fail('stale', 'the notes field already has text');
        if (at(screen) !== last) return fail('stale', 'the notes field is open on another option');
      } else {
        let now = at(screen);
        if (now < 0) return fail('stale', 'no pointer in the question');
        while (now < last) {
          const next = now + 1;
          await press(ctx, optionDown);
          const moved = await until(ctx, (s) => same(s) && s.question!.notes === undefined && at(s) === next);
          if (!moved.met) return stopped();
          now = next;
        }
        await press(ctx, notesKey);
        const opened = await until(ctx, (s) => same(s) && s.question!.notes === '' && at(s) === last);
        if (!opened.met) return stopped();
      }
      await press(ctx, text);
      const typed = await until(ctx, (s) => same(s) && !!s.question!.notes && at(s) === last);
      if (!typed.met) return stopped();
      await press(ctx, profile.keys.submit);
      return gone();
    }
    let label = free.label;
    if (free.selected) {
      // Указатель уже на свободном варианте: цифра стала бы текстом. Набранное там
      // до нас не дополняем.
      const blankLabel =
        profile.screen.free.test(label) || profile.screen.dialogs.some((d) => d.freeLast?.test(label) === true);
      if (!blankLabel) return fail('stale', 'the free-text answer already has text');
    } else {
      await press(ctx, free.key);
      const at = await until(ctx, (s) => same(s) && freeOf(s)?.selected === true);
      if (!at.met) return stopped();
      label = freeOf(at.screen)!.label;
    }
    await press(ctx, text);
    const typed = await until(ctx, (s) => {
      const now = freeOf(s);
      return same(s) && now?.selected === true && now.label !== label;
    });
    if (!typed.met) return stopped();
    await press(ctx, profile.keys.submit);
    return gone();
  }

  if (action.options !== undefined) {
    // Несколько отметок: цифра ставит и снимает отметку, затем переход к экрану
    // подтверждения и отправка на нём. Каждый шаг ждёт подтверждения экраном.
    const flow = MULTI_FLOW[ctx.agent];
    if (!question.multi || !flow) return fail('unsupported', 'this question takes a single answer');
    const marks = question.options.filter((o) => o.checked !== undefined && !o.free);
    if (!Array.isArray(action.options) || action.options.some((key) => !marks.some((o) => o.key === key))) {
      return fail('unsupported', 'no such option in the question');
    }
    for (const option of marks) {
      const wanted = action.options.includes(option.key);
      if (option.checked === wanted) continue;
      await press(ctx, option.key);
      const marked = await until(
        ctx,
        (s) => same(s) && s.question!.options.find((o) => o.key === option.key)?.checked === wanted,
      );
      if (!marked.met) return stopped();
    }
    await press(ctx, flow.next);
    // В серии вопросов та же клавиша ведёт к следующему шагу: ответы не отправляются
    // сами — шаг отправки человек видит и подтверждает отдельно.
    if ((question.steps?.filter((item) => !item.submit).length ?? 0) > 1) {
      const moved = await until(ctx, (s) => !same(s) && s.kind === 'question' && s.question?.step !== undefined);
      return moved.met ? done(moved.screen) : stopped();
    }
    const submitOf = (s: ScreenState): ScreenOption | undefined =>
      s.kind === 'question' && s.question && s.question.stamp !== question.stamp && !s.question.multi
        ? s.question.options.find((o) => flow.submit.test(o.label))
        : undefined;
    const review = await until(ctx, (s) => submitOf(s) !== undefined);
    if (!review.met) return stopped();
    await press(ctx, submitOf(review.screen)!.key);
    const reviewStamp = review.screen.question!.stamp;
    const sent = await until(ctx, (s) => s.question?.stamp !== reviewStamp && s.kind !== 'unknown');
    return sent.met ? done(sent.screen) : stopped();
  }

  const option = question.options.find((o) => o.key === action.option);
  if (!option) return fail('unsupported', 'no such option in the question');
  if (option.free) return fail('unsupported', 'the free-text option needs a text');
  if (question.multi) return fail('unsupported', 'this question takes several marks');
  // Цифра варианта отвечает сразу, без клавиши отправки.
  await press(ctx, option.key);
  return gone();
}

/** Поле заметки для своего ответа: вопрос на экране его допускает (`freeText` ставит
 *  распознавание по измеренным подсказкам), и профиль знает, как оно устроено. */
function notesOf(ctx: Ctx): NotesSign | undefined {
  const { screen, profile } = ctx;
  if (screen.question?.freeText !== true) return undefined;
  return profile.screen.dialogs.find((d) => d.kind === screen.kind && d.notes)?.notes;
}

function selectedKey(screen: ScreenState): string | undefined {
  return screen.question?.options.find((o) => o.selected)?.key;
}

function freeOf(screen: ScreenState): ScreenOption | undefined {
  return screen.question?.options.find((o) => o.free);
}

function done(screen: ScreenState): ActResult {
  return { ok: true, screen };
}

function fail(reason: string, detail: string): ChatFailure {
  return { ok: false, reason, detail };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const queues = new Map<string, Promise<unknown>>();

/** Действия одного ключа — по очереди. */
function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

function withDefaults(over?: Partial<LiveSources>): LiveSources {
  const home = over?.home ?? os.homedir();
  const socketName = over?.socketName;
  return {
    home,
    socketName,
    capture: over?.capture ?? ((session) => capturePane(session, socketName)),
    send: over?.send ?? ((session, bytes, pane) => sendKeys(session, socketName, bytes, pane)),
    paste: over?.paste ?? ((session, text, pane) => pasteText(session, socketName, text, pane)),
    resolve: over?.resolve ?? ((pane) => resolvePane(pane, { home, socketName })),
    version: over?.version ?? agentInfo,
    sleep: over?.sleep ?? ((ms) => new Promise((wake) => setTimeout(wake, ms))),
  };
}

const infoCache = new Map<string, { size: number; mtimeMs: number; info: AgentInfo }>();
const INFO_CACHE_MAX = 64;

/** Версия и модель агента из его транскрипта (и из команды панели у Claude). Экран
 *  опрашивается раз в секунду, поэтому ответ помнится, пока файл не изменился. */
export async function agentInfo(agent: AgentId, file: string | undefined, command: string): Promise<AgentInfo> {
  const named = agent === 'claude' ? /^\d+\.\d+\.\d+$/.exec(command)?.[0] : undefined;
  if (!file) return named ? { version: named } : {};
  let info: AgentInfo = {};
  try {
    const stat = await fsp.stat(file);
    const cached = infoCache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) info = cached.info;
    else {
      info = await readInfo(agent, file, stat.size);
      if (infoCache.size >= INFO_CACHE_MAX) infoCache.clear();
      infoCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, info });
    }
  } catch {
    info = {};
  }
  return named ? { ...info, version: named } : info;
}

async function readInfo(agent: AgentId, file: string, size: number): Promise<AgentInfo> {
  const handle = await fsp.open(file, 'r');
  try {
    const chunk = async (from: number, length: number): Promise<string> => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, from);
      return buf.subarray(0, bytesRead).toString('utf8');
    };
    const start = Math.max(0, size - TAIL_BYTES);
    const rows = (await chunk(start, size - start)).split('\n');
    // Первая строка хвоста начата не с начала — она битая.
    if (start > 0) rows.shift();
    let version: string | undefined;
    let model: string | undefined;
    if (agent === 'codex') {
      const meta = record((await chunk(0, Math.min(size, HEAD_BYTES))).split('\n')[0] ?? '');
      const cli = field(meta?.payload)?.cli_version;
      if (meta?.type === 'session_meta' && typeof cli === 'string') version = cli;
    }
    // Версию Codex называет только голова файла — в хвосте ищется одна модель.
    const more = (): boolean => model === undefined || (agent === 'claude' && version === undefined);
    for (let i = rows.length - 1; i >= 0 && more(); i--) {
      const rec = record(rows[i]!);
      if (!rec) continue;
      if (agent === 'claude') {
        if (version === undefined && typeof rec.version === 'string') version = rec.version;
        const named = rec.type === 'assistant' ? field(rec.message)?.model : undefined;
        // «<synthetic>» — запись об ошибке, а не ответ модели.
        if (model === undefined && typeof named === 'string' && !named.startsWith('<')) model = named;
      } else {
        const named = rec.type === 'turn_context' ? field(rec.payload)?.model : undefined;
        if (typeof named === 'string') model = named;
      }
    }
    const known = model === undefined ? undefined : profileOf(agent).models.find((m) => m.match.test(model!));
    return {
      ...(version === undefined ? {} : { version }),
      ...(model === undefined ? {} : { model: known?.label ?? model }),
    };
  } finally {
    await handle.close();
  }
}

function record(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    return field(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function field(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
