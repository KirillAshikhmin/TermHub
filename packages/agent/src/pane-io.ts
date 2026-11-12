// Одноразовые чтение экрана и ввод в активную панель сессии — мимо терминального
// подключения (`Link`). Чат не должен становиться клиентом tmux: ни `refresh-client -C`,
// ни `switch-client` здесь нет и быть не может, поэтому размер окна от чтения экрана и
// от клавиш не меняется. Каждый вызов — отдельный запуск tmux через общий `runTmux`.

import { findSessionId, SESSION_ID_FORMAT } from './tmux-session.js';
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
/** Предел вставки: текст едет аргументами одной команды tmux. */
export const PASTE_LIMIT = 64 * 1024;

const META_FORMAT =
  '#{session_name}:#{window_id}.#{pane_id}\t#{alternate_on}\t#{pane_width}\t#{pane_height}\t#{pane_current_command}';
/** Несуществующая цель отвечает пустыми полями при коде 0 — такой «адрес» не адрес. */
const META_RE = /^(.+:@\d+\.(%\d+))\t([01])\t(\d+)\t(\d+)\t(.*)$/;
const PANE_ID_RE = /%\d+$/;

/** Имя сначала разрешается в ID: tmux трактует даже `=$0:` как ID, а не как имя. */
async function sessionTarget(session: string, socketName: string | undefined): Promise<string> {
  const rows = await runTmux(['list-sessions', '-F', SESSION_ID_FORMAT], { socketName, timeoutMs: TMUX_TIMEOUT_MS });
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
 *  клавиши идут в ту панель, чей экран сверяли, даже если активной стала другая. */
export async function sendKeys(
  session: string,
  socketName: string | undefined,
  bytes: Uint8Array,
  pane?: string,
): Promise<void> {
  if (bytes.length === 0) return;
  const pinned = pane === undefined ? undefined : PANE_ID_RE.exec(pane)?.[0];
  const target = pinned ?? (await sessionTarget(session, socketName));
  const hex = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) hex[i] = bytes[i]!.toString(16).padStart(2, '0');
  await runTmux(['send-keys', '-t', target, '-H', ...hex], { socketName, timeoutMs: TMUX_TIMEOUT_MS });
}

/** Текст одной вставкой (bracketed paste): переносы строк внутри неё программа не примет
 *  за отправку. Управляющие байты из текста выброшены — иначе текст сам закрыл бы
 *  вставку и дописал клавиши от своего имени. */
export async function pasteText(
  session: string,
  socketName: string | undefined,
  text: string,
  pane?: string,
): Promise<void> {
  const clean = text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n/g, '\r');
  const body = new TextEncoder().encode(`\x1b[200~${clean}\x1b[201~`);
  if (body.length > PASTE_LIMIT) throw new Error(`text is too long to paste: ${body.length} bytes`);
  await sendKeys(session, socketName, body, pane);
}
