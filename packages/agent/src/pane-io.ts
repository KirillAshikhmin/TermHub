// Одноразовые чтение экрана и ввод в активную панель сессии — мимо терминального
// подключения (`Link`). Чат не должен становиться клиентом tmux: ни `refresh-client -C`,
// ни `switch-client` здесь нет и быть не может, поэтому размер окна от чтения экрана и
// от клавиш не меняется. Каждый вызов — отдельный запуск tmux через общий `runTmux`.

import { findSessionId, SESSION_ID_FORMAT } from './tmux-session.js';
import { spawn } from 'node:child_process';

import { runTmux } from './tmux-run.js';

/** Снимок видимого экрана активной панели. */
export interface PaneShot {
  /** Строки экрана с оформлением (`capture-pane -p -e`) — такими их ждёт `readScreen`. */
  lines: string[];
  /** Панель в альтернативном буфере. */
  alt: boolean;
  cols: number;
  rows: number;
  /** Адрес панели в виде, которого ждёт определитель: `сессия:@окно.%панель`. */
  pane: string;
  /** Команда панели (`pane_current_command`): Claude называет процесс номером версии. */
  command: string;
}

const TMUX_TIMEOUT_MS = 3000;
/** Предел вставки целиком, вместе со скобками bracketed paste. */
export const PASTE_LIMIT = 64 * 1024;
/** Байтов в одной команде `send-keys -H`: каждый байт — отдельный аргумент, а tmux
 *  принимает команду не длиннее 1000 аргументов и 16 КиБ сообщения серверу. Замер на
 *  tmux 3.7c: 996 байтов (плюс четыре аргумента самой команды) проходят, 997 —
 *  «command too long». Запас двукратный. */
const KEYS_CHUNK = 512;

/** Чем запускается tmux: подменяется только в тесте обрыва посреди вставки. */
type TmuxRunner = typeof runTmux;

const META_FORMAT =
  '#{session_name}:#{window_id}.#{pane_id}\t#{alternate_on}\t#{pane_width}\t#{pane_height}\t#{pane_current_command}';
/** Несуществующая цель отвечает пустыми полями при коде 0 — такой «адрес» не адрес. */
const META_RE = /^(.+:@\d+\.(%\d+))\t([01])\t(\d+)\t(\d+)\t(.*)$/;
const PANE_ID_RE = /%\d+$/;

/** Имя сначала разрешается в ID: tmux трактует даже `=$0:` как ID, а не как имя. */
async function sessionTarget(
  session: string,
  socketName: string | undefined,
  run: TmuxRunner = runTmux,
): Promise<string> {
  const rows = await run(['list-sessions', '-F', SESSION_ID_FORMAT], { socketName, timeoutMs: TMUX_TIMEOUT_MS });
  return `${findSessionId(rows, session)}:`;
}

/** Видимый экран активной панели сессии. Сессии нет, сервера нет, панель не названа —
 *  исключение, а не пустой экран: пустой экран распознался бы как «не узнан». */
export async function capturePane(session: string, socketName: string | undefined): Promise<PaneShot> {
  const target = await sessionTarget(session, socketName);
  // Одним запуском: сведения о панели и её экран относятся к одному моменту.
  const out = await runTmux(
    ['display-message', '-p', '-t', target, META_FORMAT, ';', 'capture-pane', '-p', '-e', '-t', target],
    { socketName, timeoutMs: TMUX_TIMEOUT_MS },
  );
  const cut = out.indexOf('\n');
  const meta = META_RE.exec(cut < 0 ? out : out.slice(0, cut));
  if (!meta) throw new Error(`session ${session} has no active pane`);
  const body = cut < 0 ? '' : out.slice(cut + 1);
  const lines = (body.endsWith('\n') ? body.slice(0, -1) : body).split('\n');
  return {
    lines,
    alt: meta[3] === '1',
    cols: Number(meta[4]),
    rows: Number(meta[5]),
    pane: meta[1]!,
    command: meta[6]!,
  };
}

/** Байты в панель — как нажатия клавиш (`send-keys -H`). `pane` — адрес из снимка:
 *  клавиши идут в ту панель, чей экран сверяли, даже если активной стала другая.
 *  Длинный ввод идёт кусками строго по очереди: в одну команду tmux он не помещается. */
export async function sendKeys(
  session: string,
  socketName: string | undefined,
  bytes: Uint8Array,
  pane?: string,
  run: TmuxRunner = runTmux,
): Promise<void> {
  if (bytes.length === 0) return;
  const target = await keysTarget(session, socketName, pane, run);
  for (let at = 0; at < bytes.length; at += KEYS_CHUNK) {
    await sendChunk(target, socketName, bytes.subarray(at, at + KEYS_CHUNK), run);
  }
}

async function keysTarget(
  session: string,
  socketName: string | undefined,
  pane: string | undefined,
  run: TmuxRunner,
): Promise<string> {
  const pinned = pane === undefined ? undefined : PANE_ID_RE.exec(pane)?.[0];
  return pinned ?? (await sessionTarget(session, socketName, run));
}

function sendChunk(target: string, socketName: string | undefined, bytes: Uint8Array, run: TmuxRunner): Promise<string> {
  const hex = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) hex[i] = bytes[i]!.toString(16).padStart(2, '0');
  return run(['send-keys', '-t', target, '-H', ...hex], { socketName, timeoutMs: TMUX_TIMEOUT_MS });
}

const PASTE_OPEN = '\x1b[200~';
const PASTE_CLOSE = '\x1b[201~';

/** Текст одной вставкой (bracketed paste): переносы строк внутри неё программа не примет
 *  за отправку. Управляющие байты из текста выброшены — иначе текст сам закрыл бы
 *  вставку и дописал клавиши от своего имени.
 *
 *  Текст идёт кусками `send-keys -H`: открывающая скобка — в первом, закрывающая — в
 *  последнем. Кусок может разрезать многобайтовый знак: `-H` пишет байты панели как есть,
 *  и программа читает их одним потоком. Сорвался кусок посередине — закрывающая скобка
 *  уходит всё равно (иначе программа осталась бы в режиме вставки и приняла бы следующие
 *  клавиши за её продолжение), а вызов отвечает отказом. */
export async function pasteText(
  session: string,
  socketName: string | undefined,
  text: string,
  pane?: string,
  run: TmuxRunner = runTmux,
): Promise<void> {
  const clean = text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n/g, '\r');
  const encoder = new TextEncoder();
  const body = encoder.encode(`${PASTE_OPEN}${clean}${PASTE_CLOSE}`);
  if (body.length > PASTE_LIMIT) throw new Error(`text is too long to paste: ${body.length} bytes`);
  const target = await keysTarget(session, socketName, pane, run);
  let opened = false;
  try {
    for (let at = 0; at < body.length; at += KEYS_CHUNK) {
      await sendChunk(target, socketName, body.subarray(at, at + KEYS_CHUNK), run);
      opened = true;
    }
  } catch (err) {
    // Первый кусок не ушёл — вставка не открыта, закрывать нечего.
    if (opened) await sendChunk(target, socketName, encoder.encode(PASTE_CLOSE), run).catch(() => undefined);
    throw err;
  }
}

/** Погасить флаг звонка окна сессии. Флаг tmux гасит только клиент, показавший окно, а чат
 *  клиентом не бывает (экран он читает разовым `capture-pane`). Поэтому — клиент на миг:
 *  control mode с закрытым вводом выходит сразу, `ignore-size` не даёт ему тронуть размер
 *  окна, `read-only` — ввод (замер на tmux 3.7c: флаг гаснет, клиентов не остаётся;
 *  `select-window` и переключение `monitor-bell` флаг не гасят). Не бросает. */
export async function clearBell(session: string, socketName: string | undefined): Promise<void> {
  let target: string;
  try {
    // Цель подключения — сессия, а не окно: без двоеточия.
    target = (await sessionTarget(session, socketName)).replace(/:$/, '');
  } catch {
    return;
  }
  const args = [...(socketName ? ['-L', socketName] : []), '-C', 'attach-session', '-f', 'ignore-size,read-only', '-t', target];
  await new Promise<void>((done) => {
    const child = spawn('tmux', args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), TMUX_TIMEOUT_MS);
    const end = (): void => {
      clearTimeout(timer);
      done();
    };
    child.once('error', end);
    child.once('exit', end);
  });
}
