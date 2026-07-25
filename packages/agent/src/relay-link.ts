// E2E-мост агента через relay. Держит WS-подключение к relay (register/challenge/
// prove + реконнект с backoff), принимает пейринг по коду (pair-open → openPair →
// обмен identity → saveAuthorized) и обслуживает удалённых клиентов: plaintext-
// хендшейк hello/hello-ok/hello-fin → два secretstream-потока → внутри — фреймы
// (LIST/OPEN/DATA/RESIZE/CREATE/KILL/PING). Relay содержимое не видит.

import fsp from 'node:fs/promises';
import path from 'node:path';

import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';

import {
  sign,
  verify,
  handshakeTranscript,
  fingerprint,
  fromB64,
  generatePairingCode,
  pairKey,
  sealPair,
  openPair,
  sessionKeys,
  makeEncryptor,
  makeDecryptor,
  encodeFrame,
  decodeFrame,
  jsonFrame,
  frameJson,
  toB64,
  FrameType,
  type Identity,
  type Frame,
  type Encryptor,
  type Decryptor,
  type SessionInfo,
  type FileEntry,
  type FileContent,
  type FileInfo,
} from '@termhub/protocol';
import type { AuthorizedDevice } from './config.js';
import { saveAuthorized, parseScope } from './config.js';
import type { DeviceScope } from './config.js';
import type { SessionService } from './sessions.js';

/** Минимум для управления сном из relay-моста (структурно совместим с Caffeinate). */
interface CaffeinateCtl {
  readonly supported: boolean;
  isActive(): boolean;
  set(on: boolean): void;
}

/** Минимум для web-push из relay-моста (структурно совместим с PushService). */
interface PushCtl {
  vapidPublicKey(): string;
  subscribe(sub: unknown): Promise<void>;
}

/** Минимум для файлового браузера из relay-моста (структурно совместим с FileService). */
interface FilesCtl {
  listDir(root: string, subpath: string): Promise<FileEntry[]>;
  readFile(root: string, subpath: string): Promise<FileContent>;
  statFile(root: string, subpath: string): Promise<{ size: number; mime: string; kind: string }>;
  readChunk(root: string, subpath: string, offset: number, len: number): Promise<Uint8Array>;
  statFull(root: string, subpath: string): Promise<FileInfo>;
  remove(root: string, subpath: string): Promise<void>;
  move(root: string, subpath: string, destRoot: string, dest: string): Promise<void>;
  copy(root: string, subpath: string, destRoot: string, dest: string): Promise<void>;
  writeFile(root: string, subpath: string, content: string): Promise<void>;
}
import { attachTerminal, type TerminalHandle } from './bridge.js';
import { runRepoAction } from './vcs.js';
import { runFileOp } from './files.js';
import type { VcsService } from './vcs.js';

/** TTL кода пейринга — 5 минут (совпадает с relay). */
const PAIR_TTL_MS = 5 * 60 * 1000;
/** Backoff реконнекта: старт 1 с, удвоение до потолка 30 с. */
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** Тайм-аут ожидания регистрации (для openPairing при недоступном relay). */
const READY_TIMEOUT_MS = 5000;
/** Размер челленджа свежести в хендшейке (замена replay-уязвимому детерминизму). */
const CHALLENGE_BYTES = 32;
/** Ed25519-публичный ключ — 32 байта. */
const ED25519_PUB_BYTES = 32;
/** Размеры терминала по умолчанию при OPEN (клиент затем шлёт RESIZE). */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Тайм-аут pre-hello клиента: не дошёл до streaming за это время → слот освобождается. */
const HELLO_TIMEOUT_MS = 5_000;
/** Максимум одновременных pre-streaming (pending) клиентов на агента: дешёвый заслон
 *  от заваливания per-agent cap relay полу-открытыми сессиями (relay pending не видит). */
const MAX_PENDING_HELLO_PER_AGENT = 8;

/** Потолок одновременных терминалов на одного клиента (каждый = процесс tmux + pty). */
const MAX_TERMINALS_PER_CLIENT = 12;
/** Потолок одного чанка скачивания: клиент просит 256 КиБ, потолок с большим запасом. */
const MAX_FILE_CHUNK = 4 * 1024 * 1024;
/** Backpressure pty→WS relay (зеркало bridge.ts для LAN-пути). */
const WS_HIGH_WATER = 1 << 20; // 1 MiB — порог паузы pty
const WS_LOW_WATER = 256 * 1024; // 256 KiB — порог возобновления
const WS_DRAIN_INTERVAL_MS = 50;

/** Кадры, на которых сверка с authorized идёт БЕЗ кэша (редкие, но привилегированные
 *  или дорогие): отзыв устройства обязан действовать на них мгновенно. */
const FRESH_AUTH_CHECK = new Set<FrameType>([
  FrameType.Open,
  FrameType.Create,
  FrameType.Kill,
  FrameType.RenameSession,
  FrameType.Share,
  FrameType.Devices,
  FrameType.Revoke,
  FrameType.FileOp,
  FrameType.Repo,
  FrameType.PushSubscribe,
  FrameType.Caffeinate,
]);

/** Как часто перечитывать authorized.json для сверки живых соединений (кэш на кадрах). */
const REVOKE_RECHECK_MS = 1_000;
/** Как часто выселять отозванные, но молчащие соединения. */
const REVOKE_SWEEP_MS = 5_000;

const utf8dec = new TextDecoder();

/** Состояние обслуживаемого клиента (эволюционирует по хендшейку). */
type ClientState = 'hello' | 'fin' | 'streaming' | 'closed';

interface ClientSession {
  connId: number;
  state: ClientState;
  /** fingerprint(edPub) клиента из hello — для повторной сверки authorized при OPEN. */
  fingerprint?: string;
  /** Ограничение доступа гостя (из authorized-записи); undefined — полный доступ. */
  scope?: DeviceScope;
  /** rx-ключ (client→agent), нужен для makeDecryptor на шаге hello-fin. */
  rxKey?: Uint8Array;
  /** Одноразовый челлендж, отданный в hello-ok: клиент подписывает его в hello-fin. */
  challenge?: Uint8Array;
  /** Ed25519-ключ клиента (для проверки подписи хендшейка). */
  edPub?: Uint8Array;
  encryptor?: Encryptor;
  decryptor?: Decryptor;
  /** Таймер pre-hello: гасится при переходе в streaming и в disposeClient. */
  helloTimer?: ReturnType<typeof setTimeout>;
  /** channel → живой терминал (мультиплекс нескольких pty в одном connId). */
  terminals: Map<number, TerminalHandle>;
}

/** Активный пейринг: ждёт hello клиента в комнате roomId. */
interface PairingState {
  roomId: string;
  key: Uint8Array;
  resolve: (d: AuthorizedDevice) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  /** Ограничение доступа для спариваемого устройства (шаринг одной сессии). */
  scope?: DeviceScope;
}

/** Ожидающий регистрации (whenReady). */
interface ReadyWaiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Мост агента через relay: одно WS-соединение, реконнект, пейринг, клиенты. */
export class RelayLink {
  private readonly url: string;
  private readonly identity: Identity;
  private readonly authorized: () => AuthorizedDevice[];
  private readonly sessions: SessionService;
  private readonly caffeinate?: CaffeinateCtl;
  private readonly push?: PushCtl;
  private readonly files?: FilesCtl;
  private readonly vcs?: VcsService;
  private readonly socketName?: string;
  private readonly attach: typeof attachTerminal;
  private readonly helloTimeoutMs: number;

  private ws?: WebSocket;
  private stopped = false;
  private registered = false;
  private agentId = '';
  /** Кэш множества допущенных отпечатков: authorized.json лежит на диске, а кадры идут
   *  потоком (каждое нажатие клавиши), поэтому читать файл на кадр нельзя. TTL делает
   *  отзыв заметным не позже REVOKE_RECHECK_MS даже если он сделан ДРУГИМ процессом
   *  (`termhub revoke`) или правкой файла руками. */
  private authorizedFps = new Set<string>();
  private authorizedAt = 0;
  /** Таймер выселения отозванных устройств, которые молчат (сами кадров не шлют, но
   *  продолжали бы получать вывод открытых терминалов). */
  private revokeSweep?: ReturnType<typeof setInterval>;
  /** Таймер слива буфера WS: жив, пока pty на паузе из-за backpressure. */
  private drainTimer?: ReturnType<typeof setInterval>;
  private backoff = BACKOFF_START_MS;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private readonly clients = new Map<number, ClientSession>();
  private pairing?: PairingState;
  private readyWaiters: ReadyWaiter[] = [];

  constructor(opts: {
    url: string;
    identity: Identity;
    authorized: () => AuthorizedDevice[];
    sessions: SessionService;
    /** Управление сном Mac (caffeinate) для удалённого тумблера; необязательно. */
    caffeinate?: CaffeinateCtl;
    /** Web-push (VAPID-ключ + подписка) для удалённых пушей; необязательно. */
    push?: PushCtl;
    /** Файловый браузер (листинг/чтение в корнях) для удалённого доступа; необязательно. */
    files?: FilesCtl;
    vcs?: VcsService;
    socketName?: string;
    /** Тайм-аут pre-hello клиента (по умолчанию 5 с); в тестах занижается. */
    helloTimeoutMs?: number;
    /** Инжектируется в тестах; по умолчанию — реальный attachTerminal. */
    attach?: typeof attachTerminal;
  }) {
    this.url = opts.url;
    this.identity = opts.identity;
    this.authorized = opts.authorized;
    this.sessions = opts.sessions;
    this.caffeinate = opts.caffeinate;
    this.push = opts.push;
    this.files = opts.files;
    this.vcs = opts.vcs;
    this.socketName = opts.socketName;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.attach = opts.attach ?? attachTerminal;
  }

  /** Подключается к relay и держит соединение (реконнект — до stop()). */
  start(): void {
    this.stopped = false;
    this.connect();
    // Выселяем отозванные устройства, даже если они молчат (иначе продолжали бы получать
    // вывод уже открытых терминалов). Покрывает и отзыв из другого процесса.
    this.revokeSweep ??= setInterval(() => this.evictRevoked(), REVOKE_SWEEP_MS);
    if (typeof this.revokeSweep.unref === 'function') this.revokeSweep.unref();
  }

  /** Отпечаток всё ещё в authorized? Результат кэшируется на REVOKE_RECHECK_MS. */
  private isStillAuthorized(fp: string): boolean {
    const now = Date.now();
    if (now - this.authorizedAt > REVOKE_RECHECK_MS) {
      this.authorizedAt = now;
      this.authorizedFps = new Set(this.authorized().map((d) => d.fingerprint));
    }
    return this.authorizedFps.has(fp);
  }

  /** Сбрасывает кэш допущенных (после отзыва в этом же процессе — чтобы без задержки). */
  private invalidateAuthorized(): void {
    this.authorizedAt = 0;
  }

  /** Требует, чтобы запрошенный путь лежал внутри каталога расшаренной сессии.
   *  Для владельца (scope нет) — без ограничений. Для гостя ограничение корнями
   *  недостаточно: «поделиться ОДНОЙ сессией» не должно открывать все sessionRoots,
   *  а раньше гость с files:true видел весь файловый браузер (ограничение было в UI). */
  private async assertScopedPath(s: ClientSession, root: string, subpath: string): Promise<void> {
    const scope = s.scope;
    if (!scope) return;
    const sess = (await this.sessions.list()).find((x) => x.name === scope.session);
    if (!sess) throw new Error('shared session not found');
    const realDir = await fsp.realpath(sess.path);
    const abs = path.resolve(root, subpath);
    const real = await fsp.realpath(abs).catch(() => abs);
    if (real !== realDir && !real.startsWith(realDir + path.sep))
      throw new Error('path outside shared session');
  }

  /** Рвёт соединения устройств, которых больше нет в authorized. */
  private evictRevoked(): void {
    for (const [connId, s] of [...this.clients]) {
      if (s.fingerprint && !this.isStillAuthorized(s.fingerprint)) {
        this.send({ t: 'client-close', connId });
        this.disposeClient(connId);
      }
    }
  }

  /** Останавливает мост: реконнект отменяется, клиенты/пейринг закрываются. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.revokeSweep) {
      clearInterval(this.revokeSweep);
      this.revokeSweep = undefined;
    }
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.settleReady(new Error('RelayLink stopped'));
    this.failPairing(new Error('RelayLink stopped'));
    this.disposeAllClients();
    const ws = this.ws;
    this.ws = undefined;
    this.registered = false;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      try {
        ws.close();
      } catch {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        resolve();
      }, 1000);
      if (typeof t.unref === 'function') t.unref();
    });
  }

  /** Открывает пейринг: генерит код, отдаёт его + промис завершения. `scope` —
   *  ограничение доступа для спариваемого устройства (шаринг одной сессии). */
  async openPairing(
    scope?: DeviceScope,
  ): Promise<{ code: string; expiresAt: number; done: Promise<AuthorizedDevice> }> {
    const { code, roomId, secret } = generatePairingCode();
    const key = pairKey(secret);
    this.failPairing(new Error('replaced by a new pairing'));

    let resolveFn!: (d: AuthorizedDevice) => void;
    let rejectFn!: (e: Error) => void;
    const done = new Promise<AuthorizedDevice>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    // Защита от unhandledRejection, если вызывающий не дождётся done (тайм-аут/stop).
    done.catch(() => {});

    const timer = setTimeout(() => this.failPairing(new Error('Pairing code expired')), PAIR_TTL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const pairing: PairingState = { roomId, key, resolve: resolveFn, reject: rejectFn, timer, settled: false, scope };
    this.pairing = pairing;

    try {
      await this.whenReady();
    } catch (err) {
      this.failPairing(err as Error);
      throw err;
    }
    // За время ожидания пейринг мог быть заменён/истечь — шлём pair-open только если он всё ещё активен.
    if (this.pairing === pairing && !pairing.settled) this.send({ t: 'pair-open', roomId });
    return { code, expiresAt: Date.now() + PAIR_TTL_MS, done };
  }

  // ── Соединение и register-хендшейк ──────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    this.registered = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => this.send({ t: 'register', edPub: toB64(this.identity.edPub) }));
    ws.on('message', (data: Buffer, isBinary: boolean) => this.onMessage(ws, data, isBinary));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => {
      /* за ошибкой всегда следует close — реконнект там */
    });
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return; // устаревший сокет (после stop/replace)
    this.ws = undefined;
    this.registered = false;
    this.disposeAllClients();
    this.failPairing(new Error('Connection to relay lost'));
    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    console.warn(`[relay-link] disconnected, reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  private onMessage(ws: WebSocket, data: Buffer, isBinary: boolean): void {
    if (this.ws !== ws) return;
    const buf = Array.isArray(data) ? Buffer.concat(data) : data;
    if (isBinary) {
      this.onBinary(buf);
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
    // relay недоверенный: бросок в любом обработчике не должен ронять message-listener.
    try {
      switch (msg.t) {
        case 'challenge':
          return this.onChallenge(msg);
        case 'registered':
          return this.onRegistered(msg);
        case 'client-open':
          return this.onClientOpen(msg);
        case 'client-close':
          return this.onClientCloseFromRelay(msg);
        case 'pair-msg':
          return this.onPairMsg(msg);
        case 'pair-closed':
          return this.failPairing(new Error(`Pairing closed by relay: ${String(msg.reason ?? 'unknown')}`));
        default:
          return; // pair-peer-left, error, connected и пр. — игнорируем
      }
    } catch (err) {
      console.error('[relay-link] error handling relay message:', err);
    }
  }

  private onChallenge(msg: Record<string, unknown>): void {
    if (typeof msg.nonce !== 'string') return;
    const nonce = fromB64(msg.nonce);
    this.send({ t: 'prove', sig: toB64(sign(this.identity.edSec, nonce)) });
  }

  private onRegistered(msg: Record<string, unknown>): void {
    this.registered = true;
    this.agentId = String(msg.agentId ?? '');
    this.backoff = BACKOFF_START_MS;
    this.settleReady(null);
    console.log(`[relay-link] registered as ${this.agentId}`);
  }

  /** Диагностический статус связи с relay (для /api/diag). */
  status(): { configured: true; connected: boolean; agentId: string; clients: number } {
    return { configured: true, connected: this.registered, agentId: this.agentId, clients: this.clients.size };
  }

  // ── Пейринг (роль агента) ────────────────────────────────────────────────────

  private onPairMsg(msg: Record<string, unknown>): void {
    const p = this.pairing;
    if (!p || p.settled || typeof msg.data !== 'string') return;

    let hello: { edPub?: unknown; name?: unknown };
    try {
      hello = openPair<{ edPub?: unknown; name?: unknown }>(p.key, fromB64(msg.data));
    } catch {
      // Неверный секрет/подделка — попытка сгорела на relay, done не трогаем.
      return;
    }
    if (typeof hello.edPub !== 'string' || typeof hello.name !== 'string') return;
    const edPub = fromB64(hello.edPub);
    if (edPub.length !== ED25519_PUB_BYTES) return;

    const device: AuthorizedDevice = {
      name: hello.name,
      edPub: hello.edPub,
      fingerprint: fingerprint(edPub),
      addedAt: Date.now(),
      ...(p.scope ? { scope: p.scope } : {}),
    };
    // Персист с дедупом по отпечатку (повторный пейринг того же устройства — замена).
    const others = this.authorized().filter((d) => d.fingerprint !== device.fingerprint);
    saveAuthorized([...others, device]);
    this.invalidateAuthorized(); // новое устройство должно быть видно сверке сразу

    this.send({ t: 'pair-msg', data: toB64(sealPair(p.key, { edPub: toB64(this.identity.edPub), ok: true })) });

    p.settled = true;
    clearTimeout(p.timer);
    this.pairing = undefined;
    p.resolve(device);
    console.log(`[relay-link] paired device ${device.name} (${device.fingerprint})`);
  }

  private failPairing(err: Error): void {
    const p = this.pairing;
    this.pairing = undefined;
    if (!p || p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    p.reject(err);
  }

  // ── Обслуживание клиентов ────────────────────────────────────────────────────

  private onClientOpen(msg: Record<string, unknown>): void {
    const connId = Number(msg.connId);
    if (!Number.isInteger(connId)) return;
    // Повторный client-open на занятый connId раньше молча затирал живую сессию в Map:
    // её pty оставались висеть без владельца (утечка процессов), а поток шифрования
    // рассинхронизировался. Старую сессию корректно закрываем.
    if (this.clients.has(connId)) this.disposeClient(connId);
    const session: ClientSession = { connId, state: 'hello', terminals: new Map() };
    // Cap на pending (не подтвердивших streaming) клиентов. relay видит их как обычных
    // клиентов и держит слот до дисконнекта; отозванное/враждебное устройство знает
    // публичный agentId и могло бы полу-открытыми сессиями исчерпать per-agent cap relay.
    // Pending-статус виден только агенту — заслон ставим здесь.
    let pending = 0;
    for (const s of this.clients.values()) if (s.state !== 'streaming') pending += 1;
    if (pending >= MAX_PENDING_HELLO_PER_AGENT) return this.rejectClient(session, 'too-many-pending', 'too many pending clients');
    // Идл-таймаут pre-hello: не дошёл до streaming за helloTimeoutMs — освобождаем слот.
    session.helloTimer = setTimeout(() => {
      if (session.state !== 'streaming') this.rejectClient(session, 'hello-timeout', 'handshake timeout');
    }, this.helloTimeoutMs);
    if (typeof session.helloTimer.unref === 'function') session.helloTimer.unref();
    this.clients.set(connId, session);
  }

  private onClientCloseFromRelay(msg: Record<string, unknown>): void {
    const connId = Number(msg.connId);
    if (Number.isInteger(connId)) this.disposeClient(connId);
  }

  /** Бинарь от relay: [connId:u32 BE][payload]. payload — plaintext-фрейм (хендшейк) или secretstream-chunk. */
  private onBinary(buf: Buffer): void {
    if (buf.length < 4) return;
    const connId = buf.readUInt32BE(0);
    const session = this.clients.get(connId);
    if (!session || session.state === 'closed') return;
    const payload = new Uint8Array(buf.subarray(4));
    try {
      if (session.state === 'hello') this.handleHello(session, payload);
      else if (session.state === 'fin') this.handleFin(session, payload);
      else this.handleStreaming(session, payload);
    } catch {
      this.rejectClient(session, 'internal', 'internal error');
    }
  }

  private handleHello(s: ClientSession, payload: Uint8Array): void {
    const frame = decodeFrame(payload);
    if (frame.type !== FrameType.Data) return this.rejectClient(s, 'bad-hello', 'expected hello');
    // Клиент шлёт ТОЛЬКО edPub — это адресация (аналог connId): по нему находим
    // authorized-запись. Имя устройства берём из неё (сохранено при пейринге), из
    // hello его больше не принимаем — недоверенный relay не должен видеть hostname.
    const hello = JSON.parse(utf8dec.decode(frame.payload)) as { t?: unknown; edPub?: unknown };
    if (hello.t !== 'hello' || typeof hello.edPub !== 'string')
      return this.rejectClient(s, 'bad-hello', 'malformed hello');

    const edPub = fromB64(hello.edPub);
    if (edPub.length !== ED25519_PUB_BYTES) return this.rejectClient(s, 'bad-hello', 'bad edPub length');
    const fp = fingerprint(edPub);
    const devices = this.authorized();
    const device = devices.find((d) => d.fingerprint === fp);
    if (!device) return this.rejectClient(s, 'unauthorized', 'device not authorized');
    // Освежаем кэш этим же чтением: иначе только что спарившееся устройство могло бы
    // быть отвергнуто как «отозванное» на первом же кадре из-за устаревшего снимка.
    this.authorizedFps = new Set(devices.map((d) => d.fingerprint));
    this.authorizedAt = Date.now();

    const { rx, tx } = sessionKeys('server', this.identity, edPub);
    s.fingerprint = fp;
    s.scope = device.scope; // ограничение гостя (одна сессия / права); undefined — полный доступ

    s.rxKey = rx;
    s.encryptor = makeEncryptor(tx);
    // Свежесть: сессионные ключи выводятся ТОЛЬКО из статических Ed25519-ключей, поэтому
    // сам по себе поток детерминирован — записанный сеанс расшифровался бы повторно, и
    // недоверенный relay мог бы переиграть набранные пользователем команды. Челлендж
    // привязывает сессию ко времени: без свежей подписи клиента в streaming не пускаем.
    s.challenge = randomBytes(CHALLENGE_BYTES);
    s.edPub = edPub;
    this.sendPlain(
      s.connId,
      jsonFrame(FrameType.Data, 0, {
        t: 'hello-ok',
        header: toB64(s.encryptor.header),
        nonce: toB64(s.challenge),
      }),
    );
    s.state = 'fin';
  }

  private handleFin(s: ClientSession, payload: Uint8Array): void {
    const frame = decodeFrame(payload);
    if (frame.type !== FrameType.Data) return this.rejectClient(s, 'bad-fin', 'expected hello-fin');
    const fin = JSON.parse(utf8dec.decode(frame.payload)) as { t?: unknown; header?: unknown; sig?: unknown };
    if (fin.t !== 'hello-fin' || typeof fin.header !== 'string' || !s.rxKey || !s.challenge || !s.edPub)
      return this.rejectClient(s, 'bad-fin', 'malformed hello-fin');
    // Подпись клиента над (челлендж ‖ его header ‖ наш header) долговременным ключом.
    // Челлендж свежий, поэтому записанный ранее hello-fin здесь не пройдёт — это и
    // закрывает переигрывание сессии недоверенным relay. Привязка обоих header'ов не
    // даёт подставить к валидной подписи чужие (записанные) потоки.
    if (typeof fin.sig !== 'string') return this.rejectClient(s, 'bad-fin', 'missing handshake signature');
    const clientHeader = fromB64(fin.header);
    const transcript = handshakeTranscript(s.challenge, clientHeader, s.encryptor!.header);
    let sigOk = false;
    try {
      sigOk = verify(s.edPub, transcript, fromB64(fin.sig));
    } catch {
      sigOk = false;
    }
    if (!sigOk) return this.rejectClient(s, 'bad-signature', 'handshake signature rejected');
    s.challenge = undefined; // одноразовый
    s.decryptor = makeDecryptor(s.rxKey, clientHeader);
    s.state = 'streaming';
    if (s.helloTimer) {
      clearTimeout(s.helloTimer);
      s.helloTimer = undefined;
    }
  }

  private handleStreaming(s: ClientSession, payload: Uint8Array): void {
    if (!s.decryptor) return;
    const frame = decodeFrame(s.decryptor.pull(payload));
    this.handleAppFrame(s, frame);
  }

  private handleAppFrame(s: ClientSession, frame: Frame): void {
    // Отзыв обязан действовать НЕМЕДЛЕННО, в том числе на уже открытое соединение.
    // Раньше сверка с authorized была ровно в одном месте (doOpen), поэтому отозванное
    // устройство продолжало читать/писать файлы и даже выписывало себе новый код
    // пейринга через Share — отзыв обходился навсегда.
    // Дорогие и привилегированные кадры (открытие терминала, управление устройствами,
    // мутации) сверяем БЕЗ кэша — отзыв на них действует мгновенно. Потоковые кадры
    // (Data/Resize) идут по кэшу: читать файл на каждое нажатие клавиши нельзя.
    if (FRESH_AUTH_CHECK.has(frame.type)) this.invalidateAuthorized();
    if (s.fingerprint && !this.isStillAuthorized(s.fingerprint)) {
      // Сообщаем причину в потоке (клиент покажет «устройство отозвано»), затем рвём.
      this.sendFrameBytes(s, jsonFrame(FrameType.Error, frame.channel, { code: 'revoked', message: 'device revoked' }));
      this.rejectClient(s, 'revoked', 'device revoked');
      return;
    }
    // Гость (scope задан): управляющие операции запрещены, ввод — только с правом
    // записи, файлы — только с правом files. Фильтрация сессий — в doList/doOpen.
    const scope = s.scope;
    if (scope) {
      switch (frame.type) {
        case FrameType.Create:
          // Гостю создание запрещено. Отвечаем явной ошибкой, а не молчаливым drop:
          // клиент ждёт CreateOk и иначе крутит спиннер до тайм-аута. code
          // create-failed уже понимает relay-transport (отклоняет ожидающий create).
          this.sendFrameBytes(
            s,
            jsonFrame(FrameType.Error, frame.channel, {
              code: 'create-failed',
              message: 'Guest access: creating sessions is not allowed',
            }),
          );
          return;
        case FrameType.Kill:
        case FrameType.RenameSession:
        case FrameType.Dirs:
        case FrameType.Caffeinate:
        case FrameType.PushKey:
        case FrameType.PushSubscribe:
        case FrameType.Share:
        case FrameType.Devices:
        case FrameType.Revoke:
          this.sendFrameBytes(
            s,
            jsonFrame(FrameType.Error, frame.channel, { code: 'forbidden', message: 'Guest access: operation not allowed' }),
          );
          return;
        case FrameType.Data:
          if (!scope.write) return;
          break;
        case FrameType.Resize:
          // Размер общий для всех клиентов сессии: гость «только для просмотра» не
          // должен перекраивать окно владельцу.
          if (!scope.write) return;
          break;
        case FrameType.FilesList:
        case FrameType.FileRead:
        case FrameType.FileStat:
        case FrameType.FileChunk:
        case FrameType.Repo:
        case FrameType.FileOp:
          // Чтение — с правом files; мутации (repo commit, файловые move/copy/remove)
          // дополнительно требуют write (в doRepo/doFileOp).
          if (!scope.files) return;
          break;
        default:
          break;
      }
    }
    switch (frame.type) {
      case FrameType.List:
        void this.doList(s);
        return;
      case FrameType.Open:
        return this.doOpen(s, frame);
      case FrameType.Data: {
        const t = s.terminals.get(frame.channel);
        if (t) t.write(frame.payload);
        return;
      }
      case FrameType.Resize: {
        const t = s.terminals.get(frame.channel);
        if (!t) return;
        let dims: { cols: number; rows: number };
        try {
          dims = frameJson<{ cols: number; rows: number }>(frame);
        } catch {
          return; // битый RESIZE игнорируем, сессию не рвём
        }
        t.resize(dims.cols, dims.rows);
        return;
      }
      case FrameType.Close: {
        const t = s.terminals.get(frame.channel);
        if (t) {
          t.dispose();
          s.terminals.delete(frame.channel);
        }
        return;
      }
      case FrameType.Create:
        void this.doCreate(s, frame);
        return;
      case FrameType.Kill:
        void this.doKill(s, frame);
        return;
      case FrameType.RenameSession:
        void this.doRename(s, frame);
        return;
      case FrameType.Caffeinate:
        return this.doCaffeinate(s, frame);
      case FrameType.PushKey:
        this.sendFrameBytes(s, jsonFrame(FrameType.PushKeyResult, 0, { key: this.push?.vapidPublicKey() ?? '' }));
        return;
      case FrameType.PushSubscribe:
        void this.doPushSubscribe(frame);
        return;
      case FrameType.Dirs:
        void this.doDirs(s, frame);
        return;
      case FrameType.FilesList:
        void this.doFilesList(s, frame);
        return;
      case FrameType.FileRead:
        void this.doFileRead(s, frame);
        return;
      case FrameType.FileStat:
        void this.doFileStat(s, frame);
        return;
      case FrameType.FileChunk:
        void this.doFileChunk(s, frame);
        return;
      case FrameType.Repo:
        void this.doRepo(s, frame);
        return;
      case FrameType.FileOp:
        void this.doFileOp(s, frame);
        return;
      case FrameType.Share:
        void this.doShare(s, frame);
        return;
      case FrameType.Devices:
        this.sendFrameBytes(s, jsonFrame(FrameType.DevicesResult, 0, { devices: this.authorized() }));
        return;
      case FrameType.Revoke:
        void this.doRevoke(s, frame);
        return;
      case FrameType.Ping:
        this.sendFrameBytes(s, encodeFrame({ type: FrameType.Pong, channel: frame.channel, payload: new Uint8Array(0) }));
        return;
      default:
        return;
    }
  }

  private async doList(s: ClientSession): Promise<void> {
    let sessions: SessionInfo[] = [];
    try {
      sessions = await this.sessions.list();
    } catch {
      sessions = [];
    }
    // Гость видит только свою сессию.
    if (s.scope) sessions = sessions.filter((sess) => sess.name === s.scope!.session);
    this.sendFrameBytes(s, jsonFrame(FrameType.ListResult, 0, { sessions, scope: s.scope ?? null }));
  }

  /** Caffeinate через relay: пустой payload — запрос состояния; `{active}` — установка.
   *  Ответ всегда CaffeinateResult `{active, supported}`. Без контроллера — supported:false. */
  private doCaffeinate(s: ClientSession, frame: Frame): void {
    if (this.caffeinate?.supported) {
      let req: { active?: boolean } = {};
      try {
        req = frameJson<{ active?: boolean }>(frame);
      } catch {
        req = {};
      }
      if (typeof req.active === 'boolean') this.caffeinate.set(req.active);
    }
    this.sendFrameBytes(
      s,
      jsonFrame(FrameType.CaffeinateResult, 0, {
        active: this.caffeinate?.isActive() ?? false,
        supported: this.caffeinate?.supported ?? false,
      }),
    );
  }

  /** VCS-операции (git/svn/hg) через relay. id — для сопоставления ответа; commit
   *  дополнительно требует scope.write (для гостя со scope). */
  private async doRepo(s: ClientSession, frame: Frame): Promise<void> {
    let req: Record<string, unknown>;
    try {
      req = frameJson<Record<string, unknown>>(frame);
    } catch {
      req = {};
    }
    const id = typeof req.id === 'number' ? req.id : 0;
    try {
      if (!this.vcs) throw new Error('repository unavailable');
      // commit/pull/push/переключение-создание-удаление веток меняют данные —
      // только с правом записи (для гостя со scope).
      if (
        ['commit', 'pull', 'push', 'checkout', 'create-branch', 'delete-branch'].includes(String(req.action)) &&
        s.scope &&
        !s.scope.write
      )
        throw new Error('no write permission');
      // `log` с fetch=true дёргает сеть (git fetch --all / hg pull) от имени владельца —
      // гостю «только для просмотра» это недоступно.
      if (req.fetch === true && s.scope && !s.scope.write) throw new Error('no write permission');
      await this.assertScopedPath(s, String(req.root ?? ''), String(req.path ?? ''));
      const result = await runRepoAction(this.vcs, req);
      this.sendFrameBytes(s, jsonFrame(FrameType.RepoResult, 0, { id, result }));
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.RepoResult, 0, { id, error: (err as Error).message }));
    }
  }

  /** Файловые операции через relay (stat-full/remove/move/copy). Мутации требуют
   *  scope.write; stat-full — только чтение (scope.files). id — для сопоставления. */
  private async doFileOp(s: ClientSession, frame: Frame): Promise<void> {
    let req: Record<string, unknown>;
    try {
      req = frameJson<Record<string, unknown>>(frame);
    } catch {
      req = {};
    }
    const id = typeof req.id === 'number' ? req.id : 0;
    try {
      if (!this.files) throw new Error('file browser unavailable');
      if (String(req.action) !== 'stat-full' && s.scope && !s.scope.write) {
        throw new Error('no write permission');
      }
      const opRoot = String(req.root ?? '');
      await this.assertScopedPath(s, opRoot, String(req.path ?? ''));
      // move/copy имеют назначение — его тоже держим внутри расшаренной сессии.
      if (req.dest !== undefined) {
        await this.assertScopedPath(s, String(req.destRoot ?? opRoot), String(req.dest ?? ''));
      }
      const result = await runFileOp(this.files, req);
      this.sendFrameBytes(s, jsonFrame(FrameType.FileOpResult, 0, { id, result }));
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.FileOpResult, 0, { id, error: (err as Error).message }));
    }
  }

  /** Листинг директории файлового браузера через relay. Ошибка (вне корня) —
   *  в поле `error` результата, сессию не рвём. */
  private async doFilesList(s: ClientSession, frame: Frame): Promise<void> {
    let req: { id?: number; root?: string; path?: string };
    try {
      req = frameJson<{ id?: number; root?: string; path?: string }>(frame);
    } catch {
      req = {};
    }
    const id = req.id;
    try {
      if (!this.files) throw new Error('file browser unavailable');
      await this.assertScopedPath(s, req.root ?? '', req.path ?? '');
      const entries = await this.files.listDir(req.root ?? '', req.path ?? '');
      this.sendFrameBytes(s, jsonFrame(FrameType.FilesListResult, 0, { id, entries }));
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.FilesListResult, 0, { id, error: (err as Error).message }));
    }
  }

  /** Чтение файла файлового браузера через relay. */
  private async doFileRead(s: ClientSession, frame: Frame): Promise<void> {
    let req: { id?: number; root?: string; path?: string };
    try {
      req = frameJson<{ id?: number; root?: string; path?: string }>(frame);
    } catch {
      req = {};
    }
    const id = req.id;
    try {
      if (!this.files) throw new Error('file browser unavailable');
      await this.assertScopedPath(s, req.root ?? '', req.path ?? '');
      const content = await this.files.readFile(req.root ?? '', req.path ?? '');
      this.sendFrameBytes(s, jsonFrame(FrameType.FileReadResult, 0, { id, content }));
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.FileReadResult, 0, { id, error: (err as Error).message }));
    }
  }

  /** Метаданные файла (размер/mime/тип) через relay — для стриминга. */
  private async doFileStat(s: ClientSession, frame: Frame): Promise<void> {
    let req: { id?: number; root?: string; path?: string };
    try {
      req = frameJson<{ id?: number; root?: string; path?: string }>(frame);
    } catch {
      req = {};
    }
    const id = req.id;
    try {
      if (!this.files) throw new Error('file browser unavailable');
      await this.assertScopedPath(s, req.root ?? '', req.path ?? '');
      const stat = await this.files.statFile(req.root ?? '', req.path ?? '');
      this.sendFrameBytes(s, jsonFrame(FrameType.FileStatResult, 0, { id, stat }));
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.FileStatResult, 0, { id, error: (err as Error).message }));
    }
  }

  /** Чтение диапазона байт файла через relay (blob-стриминг клиента). */
  private async doFileChunk(s: ClientSession, frame: Frame): Promise<void> {
    let req: { id?: number; root?: string; path?: string; offset?: number; len?: number };
    try {
      req = frameJson<{ id?: number; root?: string; path?: string; offset?: number; len?: number }>(frame);
    } catch {
      req = {};
    }
    const id = req.id;
    try {
      if (!this.files) throw new Error('file browser unavailable');
      await this.assertScopedPath(s, req.root ?? '', req.path ?? '');
      // Кламп: `len` приходит от клиента и уходит в Buffer.alloc — без потолка это
      // запрос на аллокацию произвольного размера (память агента).
      const len = Math.min(Math.max(Math.trunc(req.len ?? 0), 0), MAX_FILE_CHUNK);
      const bytes = await this.files.readChunk(req.root ?? '', req.path ?? '', req.offset ?? 0, len);
      this.sendFrameBytes(
        s,
        jsonFrame(FrameType.FileChunkData, 0, { id, data: Buffer.from(bytes).toString('base64'), eof: bytes.length < len }),
      );
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.FileChunkData, 0, { id, error: (err as Error).message }));
    }
  }

  /** Каталоги под корнями сессий через relay (для модалки создания — выбор из списка). */
  private async doDirs(s: ClientSession, frame: Frame): Promise<void> {
    let id: number | undefined;
    try {
      id = frameJson<{ id?: number }>(frame).id;
    } catch {
      id = undefined;
    }
    let dirs: { root: string; dirs: string[] }[] = [];
    try {
      dirs = await this.sessions.dirs();
    } catch {
      dirs = [];
    }
    this.sendFrameBytes(s, jsonFrame(FrameType.DirsResult, 0, { id, dirs }));
  }

  /** Генерация кода пейринга через relay (владелец): openPairing(scope) → код. */
  private async doShare(s: ClientSession, frame: Frame): Promise<void> {
    let scope: DeviceScope | undefined;
    try {
      // FAIL-CLOSED, как в server.ts: невалидный scope НЕ понижаем до полного доступа.
      const parsed = parseScope(frameJson<{ scope?: unknown }>(frame).scope);
      if (parsed === 'invalid') {
        this.sendFrameBytes(s, jsonFrame(FrameType.ShareResult, 0, { error: 'invalid scope' }));
        return;
      }
      scope = parsed === 'full' ? undefined : parsed;
    } catch {
      this.sendFrameBytes(s, jsonFrame(FrameType.ShareResult, 0, { error: 'invalid scope' }));
      return;
    }
    try {
      const p = await this.openPairing(scope);
      this.sendFrameBytes(s, jsonFrame(FrameType.ShareResult, 0, { code: p.code, expiresAt: p.expiresAt }));
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.ShareResult, 0, { error: (err as Error).message }));
    }
  }

  /** Отзыв устройства по отпечатку через relay (владелец) → обновлённый список. */
  private doRevoke(s: ClientSession, frame: Frame): void {
    let fp = '';
    try {
      fp = frameJson<{ fingerprint?: string }>(frame).fingerprint ?? '';
    } catch {
      return;
    }
    if (!fp) return;
    saveAuthorized(this.authorized().filter((d) => d.fingerprint !== fp));
    this.invalidateAuthorized(); // без задержки TTL
    this.sendFrameBytes(s, jsonFrame(FrameType.DevicesResult, 0, { devices: this.authorized() }));
    this.evictRevoked(); // рвём живые соединения отозванного устройства прямо сейчас
  }

  /** Push-подписка через relay: сохраняет присланную подписку в PushService.
   *  Fire-and-forget (как CREATE): агент не подтверждает — клиент best-effort. */
  private async doPushSubscribe(frame: Frame): Promise<void> {
    if (!this.push) return;
    let req: { subscription?: unknown };
    try {
      req = frameJson<{ subscription?: unknown }>(frame);
    } catch {
      return;
    }
    if (req.subscription === undefined) return;
    try {
      await this.push.subscribe(req.subscription);
    } catch {
      // Невалидная подписка / ошибка сохранения — не рвём сессию.
    }
  }

  private doOpen(s: ClientSession, frame: Frame): void {
    const channel = frame.channel;
    if (s.terminals.has(channel)) return;
    // Сверка authorized выполняется в handleAppFrame на КАЖДЫЙ кадр (включая этот),
    // поэтому отдельная проверка здесь больше не нужна.
    // Потолок терминалов на клиента: каждый OPEN спавнит `tmux attach` (процесс + pty),
    // а канал выбирает клиент — без лимита даже гость «только для просмотра» открывал
    // бы их пачками и клал машину владельца.
    if (s.terminals.size >= MAX_TERMINALS_PER_CLIENT) {
      this.sendFrameBytes(s, jsonFrame(FrameType.Error, channel, { code: 'too-many-terminals', message: 'too many terminals' }));
      return;
    }
    let req: { session?: unknown };
    try {
      req = frameJson<{ session?: unknown }>(frame);
    } catch {
      return;
    }
    if (typeof req.session !== 'string') return;
    const session = req.session;
    // Гость может открыть только свою сессию.
    if (s.scope && session !== s.scope.session) {
      this.sendFrameBytes(s, jsonFrame(FrameType.Error, channel, { code: 'forbidden', message: 'session not shared' }));
      return;
    }
    const handle = this.attach({
      session,
      socketName: this.socketName,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      onData: (b) => this.sendFrameBytes(s, encodeFrame({ type: FrameType.Data, channel, payload: b })),
      onBell: (sess) => this.sendFrameBytes(s, jsonFrame(FrameType.Bell, channel, { session: sess })),
      onExit: () => {
        this.sendFrameBytes(s, jsonFrame(FrameType.Close, channel, { session }));
        s.terminals.delete(channel);
      },
    });
    s.terminals.set(channel, handle);
    this.sendFrameBytes(s, jsonFrame(FrameType.OpenOk, channel, { session }));
  }

  private async doCreate(s: ClientSession, frame: Frame): Promise<void> {
    let req: { name?: unknown; root?: unknown; dir?: unknown; preset?: unknown };
    try {
      req = frameJson(frame);
    } catch {
      return;
    }
    const name = String(req.name ?? '');
    try {
      await this.sessions.create({
        name,
        root: String(req.root ?? ''),
        dir: String(req.dir ?? ''),
        preset: req.preset as 'zsh' | 'claude',
      });
      // Подтверждаем создание (сессия уже существует) — клиент дожидается, чтобы
      // навигация ушла на готовую сессию, а не на ещё несуществующую.
      this.sendFrameBytes(s, jsonFrame(FrameType.CreateOk, frame.channel, { session: name }));
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.Error, frame.channel, { code: 'create-failed', message: (err as Error).message }));
    }
  }

  private async doKill(s: ClientSession, frame: Frame): Promise<void> {
    let req: { session?: unknown };
    try {
      req = frameJson<{ session?: unknown }>(frame);
    } catch {
      return;
    }
    if (typeof req.session !== 'string') return;
    try {
      await this.sessions.kill(req.session);
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.Error, frame.channel, { code: 'kill-failed', message: (err as Error).message }));
    }
  }

  private async doRename(s: ClientSession, frame: Frame): Promise<void> {
    let req: { from?: unknown; to?: unknown };
    try {
      req = frameJson<{ from?: unknown; to?: unknown }>(frame);
    } catch {
      return;
    }
    if (typeof req.from !== 'string' || typeof req.to !== 'string') return;
    try {
      await this.sessions.rename(req.from, req.to);
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.Error, frame.channel, { code: 'rename-failed', message: (err as Error).message }));
    }
  }

  /** Отклоняет клиента: в фазе хендшейка шлёт plaintext ERROR-фрейм, затем закрывает. */
  private rejectClient(s: ClientSession, code: string, message: string): void {
    if (s.state === 'closed') return;
    if (s.state === 'hello' || s.state === 'fin')
      this.sendPlain(s.connId, jsonFrame(FrameType.Error, 0, { code, message }));
    this.send({ t: 'client-close', connId: s.connId });
    this.disposeClient(s.connId);
  }

  private disposeClient(connId: number): void {
    const s = this.clients.get(connId);
    if (!s) return;
    this.clients.delete(connId);
    s.state = 'closed';
    if (s.helloTimer) {
      clearTimeout(s.helloTimer);
      s.helloTimer = undefined;
    }
    for (const t of s.terminals.values()) t.dispose();
    s.terminals.clear();
  }

  private disposeAllClients(): void {
    for (const connId of [...this.clients.keys()]) this.disposeClient(connId);
  }

  // ── Отправка ─────────────────────────────────────────────────────────────────

  /** Шифрует фрейм push-потоком клиента и шлёт как [connId][chunk]. */
  private sendFrameBytes(s: ClientSession, frameBytes: Uint8Array): void {
    if (s.state !== 'streaming' || !s.encryptor) return;
    this.sendToClient(s.connId, s.encryptor.push(frameBytes));
  }

  /** Шлёт plaintext-полезную нагрузку клиенту (хендшейк, до потоков). */
  private sendPlain(connId: number, frameBytes: Uint8Array): void {
    this.sendToClient(connId, frameBytes);
  }

  private sendToClient(connId: number, payload: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const out = Buffer.allocUnsafe(4 + payload.length);
    out.writeUInt32BE(connId >>> 0, 0);
    out.set(payload, 4);
    ws.send(out, { binary: true });
    // Backpressure pty→WS (в LAN-пути он есть в bridge.ts, здесь его не было):
    // быстрый вывод (`yes`, `cat bigfile`) при медленном мобильном клиенте раздувал
    // буфер сокета до OOM агента. При переполнении — пауза ВСЕХ pty этого клиента.
    if (ws.bufferedAmount > WS_HIGH_WATER && !this.drainTimer) {
      for (const s of this.clients.values()) for (const t of s.terminals.values()) t.pause();
      this.drainTimer = setInterval(() => {
        const sock = this.ws;
        if (!sock || sock.readyState !== WebSocket.OPEN || sock.bufferedAmount < WS_LOW_WATER) {
          clearInterval(this.drainTimer);
          this.drainTimer = undefined;
          for (const s of this.clients.values()) for (const t of s.terminals.values()) t.resume();
        }
      }, WS_DRAIN_INTERVAL_MS);
      if (typeof this.drainTimer.unref === 'function') this.drainTimer.unref();
    }
  }

  private send(obj: unknown): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ── Готовность (регистрация) ─────────────────────────────────────────────────

  private whenReady(): Promise<void> {
    if (this.registered) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w.timer !== timer);
        reject(new Error('Relay not connected (timed out waiting for registration)'));
      }, READY_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.readyWaiters.push({ resolve, reject, timer });
    });
  }

  private settleReady(err: Error | null): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      if (err) w.reject(err);
      else w.resolve();
    }
  }
}
