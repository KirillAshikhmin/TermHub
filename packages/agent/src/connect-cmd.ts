// Команда `termhub connect` и её тестируемое ядро connectAgent.
//
// connectAgent(store, relayUrl, agentId) — «ssh через relay»: одно WS-соединение к
// relay, connect → E2E-хендшейк с агентом (hello → hello-ok → hello-fin → два
// secretstream-потока), мультиплекс терминалов по channel фрейма. Зеркало
// агентского RelayLink (роль клиента — 'client') и Node-порт web RelayTransport, но
// promise-ориентированный и БЕЗ реконнекта: для CLI обрыв = конец сессии (как ssh).
//
// connectCommand — тонкая TTY-обёртка: raw-mode stdin ↔ stdout, RESIZE по SIGWINCH,
// выход по `~.` (в начале строки, как ssh) или Ctrl-]. Ядро тестируется отдельно,
// TTY-обёртка — нет.

import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import {
  decodeFrame,
  encodeFrame,
  frameJson,
  FrameType,
  fromB64,
  initCrypto,
  jsonFrame,
  makeDecryptor,
  makeEncryptor,
  sessionKeys,
  sign,
  verify,
  handshakeTranscript,
  serverHandshakeTranscript,
  toB64,
  type Decryptor,
  type Encryptor,
  type Frame,
  type Identity,
  type SessionInfo,
} from '@termhub/protocol';
import type { ClientStore, KnownAgent } from './client-store.js';
import { loadClientStore } from './client-store.js';

/** Контрольный канал (LIST/LIST_RESULT) — как у агента, всегда 0. */
const CONTROL_CHANNEL = 0;
/** Терминалы нумеруются с 1 (0 занят контролем). */
const FIRST_TERM_CHANNEL = 1;
/** Тайм-аут ответа на LIST (покрывает и начальный хендшейк). */
const LIST_TIMEOUT_MS = 15_000;
/** Тайм-аут установления E2E-потока (connect→connected→hello→streaming). */
const CONNECT_TIMEOUT_MS = 15_000;
/** Байт Ctrl-] — аварийный выход из терминала. */
const CTRL_RBRACKET = 0x1d;
/** Байты тильды и точки — ssh-подобная escape-последовательность `~.`. */
const TILDE = 0x7e;
const DOT = 0x2e;
const LF = 0x0a;
const CR = 0x0d;
/** Размеры терминала по умолчанию, если stdout не TTY. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Длина челленджа свежести; должна совпадать с CHALLENGE_BYTES агента. */
const CHALLENGE_BYTES = 32;
/** Коды ошибок relay, которые допустимо показывать дословно (см. describeError). */
const RELAY_ERROR_CODES = new Set([
  'agent-offline',
  'too-many-clients',
  'no-room',
  'room-taken',
  'too-many-attempts',
  'bad-json',
  'unknown-type',
  'already-registered',
  'already-connected',
  'bad-register',
  'bad-edpub',
  'bad-signature',
  'no-challenge',
  'bad-connect',
  'bad-pair-open',
  'bad-pair-join',
]);

const utf8dec = new TextDecoder();

/** Опции открытия удалённого терминала. */
export interface OpenTermOpts {
  cols: number;
  rows: number;
  onData: (bytes: Uint8Array) => void;
  /** Сессия/агент закрылись (CLOSE/ERROR по каналу или обрыв соединения). */
  onClose: () => void;
}

/** Ручка живого удалённого терминала. */
export interface OpenTerm {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** Удалённый агент через relay: список сессий + мультиплекс терминалов. */
export interface RemoteAgent {
  /** Резолвится по установлении E2E-потока; реджектится при отказе/обрыве до потока. */
  readonly ready: Promise<void>;
  list(): Promise<SessionInfo[]>;
  open(session: string, opts: OpenTermOpts): OpenTerm;
  close(): void;
}

/** Состояние WS-соединения по мере хендшейка. */
type LinkState = 'connecting' | 'handshaking' | 'streaming' | 'closed';

/** Живой терминал в connId-канале (мультиплекс по channel). */
interface TermEntry {
  channel: number;
  session: string;
  opts: OpenTermOpts;
}

interface PendingList {
  resolve: (sessions: SessionInfo[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Клиентская сторона E2E-моста через relay (одно соединение, без реконнекта). */
class RemoteConn implements RemoteAgent {
  readonly ready: Promise<void>;

  private readonly ws: WebSocket;
  private readonly identity: Identity;
  private readonly agentId: string;
  private readonly agentEdPub: Uint8Array;

  private state: LinkState = 'connecting';
  private encryptor?: Encryptor;
  private decryptor?: Decryptor;
  /** Свежий челлендж этой сессии: агент подписывает им свой header, и без валидной
   *  подписи мы не входим в streaming (защита от переигрывания записанного потока). */
  private challenge?: Uint8Array;
  private outbox: Uint8Array[] = [];
  private readonly terminals = new Map<number, TermEntry>();
  private nextChannel = FIRST_TERM_CHANNEL;
  private pendingList: PendingList[] = [];
  private failure?: Error;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private readySettled = false;
  private connectTimer?: ReturnType<typeof setTimeout>;

  constructor(identity: Identity, relayUrl: string, agent: KnownAgent) {
    this.identity = identity;
    this.agentId = agent.agentId;
    this.agentEdPub = fromB64(agent.agentEdPub);
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Не рушим процесс unhandledRejection, если вызывающий не подписался на ready.
    this.ready.catch(() => {});

    const ws = new WebSocket(relayUrl);
    this.ws = ws;
    ws.on('open', () => this.send({ t: 'connect', agentId: this.agentId }));
    ws.on('message', (data: Buffer, isBinary: boolean) => this.onMessage(data, isBinary));
    ws.on('close', () => this.onClose());
    ws.on('error', () => {
      /* за ошибкой всегда следует close — обработка там */
    });

    // Страховка от зависания: если за CONNECT_TIMEOUT_MS поток не установлен
    // (relay/агент молчат, нет hello-ok), реджектим ready и рвём сокет.
    this.connectTimer = setTimeout(() => this.onConnectTimeout(), CONNECT_TIMEOUT_MS);
    if (typeof this.connectTimer.unref === 'function') this.connectTimer.unref();
  }

  // ── Приём ────────────────────────────────────────────────────────────────

  private onMessage(data: Buffer, isBinary: boolean): void {
    const buf = Array.isArray(data) ? Buffer.concat(data) : data;
    if (isBinary) {
      this.onBinary(new Uint8Array(buf));
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(buf.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.t === 'connected') this.startHandshake();
    else if (msg.t === 'error') {
      // Relay отклонил подключение (agent-offline/too-many-clients). Сохраняем
      // причину и СРАЗУ рвём сокет: onClose реджектит ready+pending этой ошибкой —
      // иначе, если relay не закроет WS, connect висел бы вечно.
      this.failure = new Error(this.describeError(String(msg.code ?? 'unknown')));
      this.dropSocket();
    }
  }

  /** Сообщение по коду ошибки relay. Код приходит от НЕдоверенной стороны и печатается
   *  в терминал оператора до всякой аутентификации, поэтому в текст попадают только
   *  known-коды: произвольная строка позволяла бы вписать OSC 52 и подменить буфер
   *  обмена (termhub setup включает set-clipboard в tmux). */
  private describeError(code: string): string {
    if (code === 'agent-offline') return 'Agent is currently offline (not connected to relay).';
    if (code === 'too-many-clients') return 'Too many clients connected to the agent.';
    if (RELAY_ERROR_CODES.has(code)) return `Relay rejected the connection (${code}).`;
    return 'Relay rejected the connection.';
  }

  /** Plaintext hello в DATA-фрейме (канал 0). edPub — по нему агент находит
   *  authorized-запись (адресация, аналог connId) и делает ECDH. Имя устройства НЕ
   *  шлём: агент знает его из своего authorized.json по fingerprint(edPub), а
   *  недоверенный relay не должен видеть hostname клиента. nonce — наш челлендж
   *  свежести, которым агент обязан подписать hello-ok. */
  private startHandshake(): void {
    this.state = 'handshaking';
    this.challenge = new Uint8Array(randomBytes(CHALLENGE_BYTES));
    this.sendRaw(
      jsonFrame(FrameType.Data, 0, {
        t: 'hello',
        edPub: toB64(this.identity.edPub),
        nonce: toB64(this.challenge),
      }),
    );
  }

  private onBinary(payload: Uint8Array): void {
    if (this.state === 'handshaking') return this.onHandshakeFrame(payload);
    if (this.state !== 'streaming' || !this.decryptor) return;
    let plain: Uint8Array;
    try {
      plain = this.decryptor.pull(payload);
    } catch {
      // Подделка/рассинхрон потока — рвём соединение (onClose завершит сессии).
      this.dropSocket();
      return;
    }
    let frame: Frame;
    try {
      frame = decodeFrame(plain);
    } catch {
      return;
    }
    this.dispatch(frame);
  }

  private onHandshakeFrame(payload: Uint8Array): void {
    let frame: Frame;
    try {
      frame = decodeFrame(payload);
    } catch {
      return;
    }
    if (frame.type === FrameType.Error) {
      // Агент отверг устройство (не в authorized) — реконнект не поможет, нужен пейринг.
      this.failure = new Error('Agent rejected the device: it is not authorized (pair again).');
      this.dropSocket();
      return;
    }
    if (frame.type !== FrameType.Data) return;
    let msg: { t?: unknown; header?: unknown; nonce?: unknown; sig?: unknown };
    try {
      msg = JSON.parse(utf8dec.decode(frame.payload)) as {
        t?: unknown;
        header?: unknown;
        nonce?: unknown;
        sig?: unknown;
      };
    } catch {
      return;
    }
    if (msg.t !== 'hello-ok' || typeof msg.header !== 'string') return;
    // Челлендж свежести обязателен (см. handshakeTranscript): без него не начинаем.
    if (typeof msg.nonce !== 'string') return;

    const serverHeader = fromB64(msg.header);
    // Подпись агента над (наш челлендж ‖ его header) закреплённым agentEdPub. Без неё
    // недоверенный relay мог бы, не связываясь с агентом вовсе, отдать записанный
    // hello-ok и записанные чанки: ключи выводятся из статических Ed25519, поэтому
    // старый поток расшифровался бы снова и отрисовался как живая сессия.
    if (typeof msg.sig !== 'string' || !this.challenge) {
      this.failure = new Error('Agent did not authenticate the session (relay may be replaying it).');
      this.dropSocket();
      return;
    }
    let serverOk = false;
    try {
      serverOk = verify(this.agentEdPub, serverHandshakeTranscript(this.challenge, serverHeader), fromB64(msg.sig));
    } catch {
      serverOk = false;
    }
    if (!serverOk) {
      this.failure = new Error('Agent signature rejected (relay may be replaying a recorded session).');
      this.dropSocket();
      return;
    }
    this.challenge = undefined; // одноразовый

    const { rx, tx } = sessionKeys('client', this.identity, this.agentEdPub);
    this.encryptor = makeEncryptor(tx);
    this.decryptor = makeDecryptor(rx, serverHeader);
    const sig = sign(
      this.identity.edSec,
      handshakeTranscript(fromB64(msg.nonce), this.encryptor.header, serverHeader),
    );
    this.sendRaw(
      jsonFrame(FrameType.Data, 0, { t: 'hello-fin', header: toB64(this.encryptor.header), sig: toB64(sig) }),
    );
    this.state = 'streaming';
    this.onStreamReady();
  }

  /** Поток установлен: пере-открываем терминалы (OPEN) и сливаем очередь (RESIZE/DATA). */
  private onStreamReady(): void {
    for (const entry of this.terminals.values())
      this.sendEncrypted(jsonFrame(FrameType.Open, entry.channel, { session: entry.session }));
    const queued = this.outbox;
    this.outbox = [];
    for (const bytes of queued) this.sendEncrypted(bytes);
    this.settleReady();
  }

  private dispatch(frame: Frame): void {
    switch (frame.type) {
      case FrameType.ListResult: {
        const pending = this.pendingList.shift();
        if (!pending) return;
        clearTimeout(pending.timer);
        let sessions: SessionInfo[] = [];
        try {
          sessions = frameJson<{ sessions: SessionInfo[] }>(frame).sessions ?? [];
        } catch {
          sessions = [];
        }
        pending.resolve(sessions);
        return;
      }
      case FrameType.OpenOk:
        return; // подтверждение открытия терминала — состояние не храним
      case FrameType.Data:
        this.terminals.get(frame.channel)?.opts.onData(frame.payload);
        return;
      case FrameType.Close:
      case FrameType.Error: {
        const entry = this.terminals.get(frame.channel);
        if (!entry) return; // контрольный канал (CREATE/KILL-ошибка) — молча
        this.terminals.delete(frame.channel);
        entry.opts.onClose();
        return;
      }
      default:
        return; // BELL/PONG и пр. — игнорируем
    }
  }

  private onClose(): void {
    if (this.state === 'closed') return;
    const wasStreaming = this.state === 'streaming';
    this.state = 'closed';
    this.encryptor = undefined;
    this.decryptor = undefined;
    for (const pending of this.pendingList) {
      clearTimeout(pending.timer);
      pending.reject(this.failure ?? new Error('Connection to relay closed.'));
    }
    this.pendingList = [];
    const terminals = [...this.terminals.values()];
    this.terminals.clear();
    for (const entry of terminals) entry.opts.onClose();
    // ready ещё не резолвился (обрыв до потока) — реджектим осмысленной причиной.
    if (!wasStreaming) this.rejectReadyOnce(this.failure ?? new Error('Failed to establish a connection to the agent.'));
  }

  private settleReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.clearConnectTimer();
    this.resolveReady();
  }

  private rejectReadyOnce(err: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.clearConnectTimer();
    this.rejectReady(err);
  }

  private clearConnectTimer(): void {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  /** Поток не установлен за отведённое время — реджектим ready и рвём сокет. */
  private onConnectTimeout(): void {
    if (this.readySettled) return;
    this.failure = new Error('Failed to connect to the agent (connection setup timed out).');
    this.dropSocket();
    this.rejectReadyOnce(this.failure);
  }

  private dropSocket(): void {
    try {
      this.ws.close();
    } catch {
      /* уже закрыт — идемпотентно */
    }
  }

  // ── Отправка ───────────────────────────────────────────────────────────────

  /** Ставит фрейм в поток (шифрует) или в очередь до установления потока. */
  private sendFrame(frameBytes: Uint8Array): void {
    if (this.state === 'streaming') this.sendEncrypted(frameBytes);
    else this.outbox.push(frameBytes);
  }

  private sendEncrypted(frameBytes: Uint8Array): void {
    if (!this.encryptor || this.ws.readyState !== WebSocket.OPEN) return;
    // Клиент шлёт ЧИСТЫЕ байты — relay сам добавит [connId] в сторону агента.
    this.ws.send(this.encryptor.push(frameBytes), { binary: true });
  }

  /** Plaintext-фрейм хендшейка (hello / hello-fin) — до установления потоков. */
  private sendRaw(frameBytes: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frameBytes, { binary: true });
  }

  private send(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // ── RemoteAgent API ──────────────────────────────────────────────────────────

  async list(): Promise<SessionInfo[]> {
    await this.ready;
    return new Promise<SessionInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingList = this.pendingList.filter((p) => p.timer !== timer);
        reject(new Error('Timed out waiting for the session list.'));
      }, LIST_TIMEOUT_MS);
      this.pendingList.push({ resolve, reject, timer });
      this.sendFrame(encodeFrame({ type: FrameType.List, channel: CONTROL_CHANNEL, payload: new Uint8Array(0) }));
    });
  }

  open(session: string, opts: OpenTermOpts): OpenTerm {
    const channel = this.nextChannel++;
    const entry: TermEntry = { channel, session, opts };
    this.terminals.set(channel, entry);
    // OPEN шлём сразу только если поток установлен; иначе его отправит onStreamReady.
    if (this.state === 'streaming') this.sendEncrypted(jsonFrame(FrameType.Open, channel, { session }));
    this.sendFrame(jsonFrame(FrameType.Resize, channel, { cols: opts.cols, rows: opts.rows }));
    return {
      write: (bytes) => this.sendFrame(encodeFrame({ type: FrameType.Data, channel, payload: bytes })),
      resize: (cols, rows) => this.sendFrame(jsonFrame(FrameType.Resize, channel, { cols, rows })),
      close: () => {
        if (this.terminals.delete(channel) && this.state === 'streaming')
          this.sendFrame(jsonFrame(FrameType.Close, channel, {}));
      },
    };
  }

  close(): void {
    for (const pending of this.pendingList) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed.'));
    }
    this.pendingList = [];
    this.terminals.clear();
    this.rejectReadyOnce(new Error('Connection closed.'));
    try {
      this.ws.close();
    } catch {
      /* уже закрыт — идемпотентно */
    }
  }
}

/** Открывает удалённого агента (ядро, переиспользуется командой и тестами). */
export function connectAgent(store: ClientStore, relayUrl: string, agentId: string): RemoteAgent {
  const known = store.get(agentId);
  if (!known) throw new Error(`Agent "${agentId}" not found among known agents. Run first: termhub pair`);
  return new RemoteConn(store.identity, relayUrl, known);
}

// ── Команда CLI (TTY-обёртка) ─────────────────────────────────────────────────

/** Разбирает `connect [agentId|имя] [--session <имя>]`. */
function parseConnectArgs(args: string[]): { target?: string; session?: string } {
  let target: string | undefined;
  let session: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--session') {
      session = args[++i];
    } else if (a.startsWith('--session=')) {
      session = a.slice('--session='.length);
    } else if (!a.startsWith('-') && target === undefined) {
      target = a;
    }
  }
  return { target, session };
}

/** Резолвит известного агента: по имени/agentId, либо единственного. */
function resolveAgent(store: ClientStore, target?: string): KnownAgent {
  const all = store.list();
  if (all.length === 0) throw new Error('No known agents. Run first: termhub pair <code> --relay <url>');
  if (target) {
    const found = store.get(target);
    if (!found) throw new Error(`Agent "${target}" not found. List them: termhub connect (no arguments).`);
    return found;
  }
  if (all.length === 1) return all[0]!;
  throw new Error('Multiple known agents — specify a name or agentId: termhub connect <name>');
}

/** Печатает нумерованный список сессий агента + подсказку. */
function printSessions(agent: KnownAgent, sessions: SessionInfo[]): void {
  console.log(`Agent ${agent.name} (${agent.agentId}):`);
  if (sessions.length === 0) {
    console.log('  (no active sessions)');
    return;
  }
  sessions.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.name}  [${s.command}]  ${s.path}`);
  });
  console.log(`\nConnect: termhub connect ${agent.name} --session <name>`);
}

/** Гонит raw-mode терминал stdin ↔ удалённая сессия; резолвится по выходу. */
function runTerminal(agent: RemoteAgent, session: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;

    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onStdin);
      stdout.removeListener('resize', onResize);
      if (stdin.isTTY) {
        try {
          stdin.setRawMode(wasRaw);
        } catch {
          /* ignore */
        }
      }
      stdin.pause();
      term.close();
      agent.close();
    };

    const term = agent.open(session, {
      cols: stdout.columns ?? DEFAULT_COLS,
      rows: stdout.rows ?? DEFAULT_ROWS,
      onData: (bytes) => stdout.write(Buffer.from(bytes)),
      onClose: () => {
        cleanup();
        process.stderr.write('\r\n[termhub] Session closed.\r\n');
        resolve(0);
      },
    });

    const onResize = (): void => term.resize(stdout.columns ?? DEFAULT_COLS, stdout.rows ?? DEFAULT_ROWS);

    // ssh-подобный детектор выхода: `~.` в начале строки или Ctrl-]. Тильда в начале
    // строки удерживается; если следом не «.», отдаём удержанную тильду вместе с
    // байтом дальше (состояние живёт между чанками stdin).
    let atLineStart = true;
    let tildeHeld = false;
    const onStdin = (chunk: Buffer): void => {
      const out: number[] = [];
      for (const b of chunk) {
        if (tildeHeld) {
          tildeHeld = false;
          if (b === DOT) {
            if (out.length) term.write(Uint8Array.from(out));
            cleanup();
            process.stderr.write('\r\n[termhub] Disconnected.\r\n');
            resolve(0);
            return;
          }
          if (b === TILDE) {
            // `~~` в начале строки → ОДИН литеральный `~` (как ssh); второй гасит escape.
            out.push(TILDE);
            atLineStart = false;
            continue;
          }
          out.push(TILDE, b);
          atLineStart = b === LF || b === CR;
          continue;
        }
        if (b === CTRL_RBRACKET) {
          if (out.length) term.write(Uint8Array.from(out));
          cleanup();
          process.stderr.write('\r\n[termhub] Disconnected.\r\n');
          resolve(0);
          return;
        }
        if (atLineStart && b === TILDE) {
          tildeHeld = true;
          continue;
        }
        out.push(b);
        atLineStart = b === LF || b === CR;
      }
      if (out.length) term.write(Uint8Array.from(out));
    };

    if (stdin.isTTY) {
      try {
        stdin.setRawMode(true);
      } catch {
        /* не TTY-совместимый stdin — работаем без raw-режима */
      }
    }
    stdin.resume();
    stdin.on('data', onStdin);
    stdout.on('resize', onResize);
    onResize(); // первый RESIZE сразу
  });
}

/** Точка входа команды `termhub connect`. */
export async function connectCommand(args: string[]): Promise<number> {
  await initCrypto();
  const store = loadClientStore();
  const { target, session } = parseConnectArgs(args);

  let agent: KnownAgent;
  try {
    agent = resolveAgent(store, target);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  // connectAgent синхронно создаёт WebSocket — битый relayUrl из known-agents.json
  // бросил бы сырой stack. Ловим и печатаем аккуратную ошибку.
  let remote: RemoteAgent;
  try {
    remote = connectAgent(store, agent.relayUrl, agent.agentId);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  try {
    await remote.ready;
  } catch (err) {
    console.error((err as Error).message);
    remote.close();
    return 1;
  }

  if (!session) {
    let sessions: SessionInfo[];
    try {
      sessions = await remote.list();
    } catch (err) {
      console.error((err as Error).message);
      remote.close();
      return 1;
    }
    printSessions(agent, sessions);
    remote.close();
    return 0;
  }

  process.stderr.write(`[termhub] Connecting to ${agent.name}:${session} (exit: ~.  or Ctrl-])\r\n`);
  return runTerminal(remote, session);
}
