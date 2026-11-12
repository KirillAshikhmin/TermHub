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

import { profileOf, isTested, type AgentProfile } from './agent-profiles.js';
import { readScreen } from './agent-screen.js';
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
  return serial(`${src.socketName ?? ''}\u0000${session}`, async () => {
    try {
      const ctx = await look(session, src);
      if (!ctx.ok) return ctx;
      return await run(ctx, action);
    } catch (err) {
      return fail('lookup-failed', `cannot act in ${session}: ${describe(err)}`);
    }
  });
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
  await ctx.src.paste(ctx.session, text, ctx.pane);
  const typed = await until(ctx, (s) => atInput(s) && !!s.input);
  if (!typed.met) return fail('stale', 'pasted text did not show up in the agent input line');
  await press(ctx, profile.keys.submit);
  return done((await until(ctx, (s) => !atInput(s) || !s.input)).screen);
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
  const gone = async (): Promise<ActResult> => done((await until(ctx, (s) => !same(s))).screen);
  const stopped = (): ActResult => fail('stale', 'the agent screen did not follow the answer step');

  if (action.text !== undefined) {
    // Свой ответ: клавиша свободного варианта ставит на него указатель, текст набирается
    // в его строке, клавиша отправки отвечает.
    const free = question.options.find((o) => o.free);
    if (!free || question.multi) return fail('unsupported', 'this question takes no free-text answer');
    if (action.option !== undefined && action.option !== free.key) {
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
    let label = free.label;
    if (free.selected) {
      // Указатель уже на свободном варианте: цифра стала бы текстом. Набранное там
      // до нас не дополняем.
      if (!profile.screen.free.test(label)) return fail('stale', 'the free-text answer already has text');
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
    const submitOf = (s: ScreenState): ScreenOption | undefined =>
      s.kind === 'question' && s.question && s.question.stamp !== question.stamp && !s.question.multi
        ? s.question.options.find((o) => flow.submit.test(o.label))
        : undefined;
    const review = await until(ctx, (s) => submitOf(s) !== undefined);
    if (!review.met) return stopped();
    await press(ctx, submitOf(review.screen)!.key);
    const reviewStamp = review.screen.question!.stamp;
    return done((await until(ctx, (s) => s.question?.stamp !== reviewStamp)).screen);
  }

  const option = question.options.find((o) => o.key === action.option);
  if (!option) return fail('unsupported', 'no such option in the question');
  if (option.free) return fail('unsupported', 'the free-text option needs a text');
  if (question.multi) return fail('unsupported', 'this question takes several marks');
  // Цифра варианта отвечает сразу, без клавиши отправки.
  await press(ctx, option.key);
  return gone();
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
