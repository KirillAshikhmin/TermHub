// E2E-мост агента через relay. Держит WS-подключение к relay (register/challenge/
// prove + реконнект с backoff), принимает пейринг по коду (pair-open → openPair →
// обмен identity → saveAuthorized) и обслуживает удалённых клиентов: plaintext-
// хендшейк hello/hello-ok/hello-fin → два secretstream-потока → внутри — фреймы
// (LIST/OPEN/DATA/RESIZE/CREATE/KILL/PING). Relay содержимое не видит.

import { WebSocket } from 'ws';
import {
  sign,
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
import { saveAuthorized } from './config.js';
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
  }

  /** Останавливает мост: реконнект отменяется, клиенты/пейринг закрываются. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.settleReady(new Error('RelayLink остановлен'));
    this.failPairing(new Error('RelayLink остановлен'));
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
    this.failPairing(new Error('заменён новым пейрингом'));

    let resolveFn!: (d: AuthorizedDevice) => void;
    let rejectFn!: (e: Error) => void;
    const done = new Promise<AuthorizedDevice>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    // Защита от unhandledRejection, если вызывающий не дождётся done (тайм-аут/stop).
    done.catch(() => {});

    const timer = setTimeout(() => this.failPairing(new Error('Срок действия кода пейринга истёк')), PAIR_TTL_MS);
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
    this.failPairing(new Error('Соединение с relay потеряно'));
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
          return this.failPairing(new Error(`Пейринг закрыт relay: ${String(msg.reason ?? 'unknown')}`));
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
    const device = this.authorized().find((d) => d.fingerprint === fp);
    if (!device) return this.rejectClient(s, 'unauthorized', 'device not authorized');

    const { rx, tx } = sessionKeys('server', this.identity, edPub);
    s.fingerprint = fp;
    s.scope = device.scope; // ограничение гостя (одна сессия / права); undefined — полный доступ

    s.rxKey = rx;
    s.encryptor = makeEncryptor(tx);
    this.sendPlain(s.connId, jsonFrame(FrameType.Data, 0, { t: 'hello-ok', header: toB64(s.encryptor.header) }));
    s.state = 'fin';
  }

  private handleFin(s: ClientSession, payload: Uint8Array): void {
    const frame = decodeFrame(payload);
    if (frame.type !== FrameType.Data) return this.rejectClient(s, 'bad-fin', 'expected hello-fin');
    const fin = JSON.parse(utf8dec.decode(frame.payload)) as { t?: unknown; header?: unknown };
    if (fin.t !== 'hello-fin' || typeof fin.header !== 'string' || !s.rxKey)
      return this.rejectClient(s, 'bad-fin', 'malformed hello-fin');
    s.decryptor = makeDecryptor(s.rxKey, fromB64(fin.header));
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
    // Гость (scope задан): управляющие операции запрещены, ввод — только с правом
    // записи, файлы — только с правом files. Фильтрация сессий — в doList/doOpen.
    const scope = s.scope;
    if (scope) {
      switch (frame.type) {
        case FrameType.Create:
        case FrameType.Kill:
        case FrameType.Dirs:
        case FrameType.Caffeinate:
        case FrameType.PushKey:
        case FrameType.PushSubscribe:
        case FrameType.Share:
        case FrameType.Devices:
        case FrameType.Revoke:
          return;
        case FrameType.Data:
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
      case FrameType.Caffeinate:
        return this.doCaffeinate(s, frame);
      case FrameType.PushKey:
        this.sendFrameBytes(s, jsonFrame(FrameType.PushKeyResult, 0, { key: this.push?.vapidPublicKey() ?? '' }));
        return;
      case FrameType.PushSubscribe:
        void this.doPushSubscribe(frame);
        return;
      case FrameType.Dirs:
        void this.doDirs(s);
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
      if (!this.vcs) throw new Error('репозиторий недоступен');
      // commit/pull/push/переключение-создание-удаление веток меняют данные —
      // только с правом записи (для гостя со scope).
      if (
        ['commit', 'pull', 'push', 'checkout', 'create-branch', 'delete-branch'].includes(String(req.action)) &&
        s.scope &&
        !s.scope.write
      )
        throw new Error('нет прав на запись');
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
      if (!this.files) throw new Error('файловый браузер недоступен');
      if (String(req.action) !== 'stat-full' && s.scope && !s.scope.write) {
        throw new Error('нет прав на запись');
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
    let req: { root?: string; path?: string };
    try {
      req = frameJson<{ root?: string; path?: string }>(frame);
    } catch {
      req = {};
    }
    try {
      if (!this.files) throw new Error('файловый браузер недоступен');
      const entries = await this.files.listDir(req.root ?? '', req.path ?? '');
      this.sendFrameBytes(s, jsonFrame(FrameType.FilesListResult, 0, { entries }));
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.FilesListResult, 0, { error: (err as Error).message }));
    }
  }

  /** Чтение файла файлового браузера через relay. */
  private async doFileRead(s: ClientSession, frame: Frame): Promise<void> {
    let req: { root?: string; path?: string };
    try {
      req = frameJson<{ root?: string; path?: string }>(frame);
    } catch {
      req = {};
    }
    try {
      if (!this.files) throw new Error('файловый браузер недоступен');
      const content = await this.files.readFile(req.root ?? '', req.path ?? '');
      this.sendFrameBytes(s, jsonFrame(FrameType.FileReadResult, 0, { content }));
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.FileReadResult, 0, { error: (err as Error).message }));
    }
  }

  /** Метаданные файла (размер/mime/тип) через relay — для стриминга. */
  private async doFileStat(s: ClientSession, frame: Frame): Promise<void> {
    let req: { root?: string; path?: string };
    try {
      req = frameJson<{ root?: string; path?: string }>(frame);
    } catch {
      req = {};
    }
    try {
      if (!this.files) throw new Error('файловый браузер недоступен');
      const stat = await this.files.statFile(req.root ?? '', req.path ?? '');
      this.sendFrameBytes(s, jsonFrame(FrameType.FileStatResult, 0, { stat }));
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.FileStatResult, 0, { error: (err as Error).message }));
    }
  }

  /** Чтение диапазона байт файла через relay (blob-стриминг клиента). */
  private async doFileChunk(s: ClientSession, frame: Frame): Promise<void> {
    let req: { root?: string; path?: string; offset?: number; len?: number };
    try {
      req = frameJson<{ root?: string; path?: string; offset?: number; len?: number }>(frame);
    } catch {
      req = {};
    }
    try {
      if (!this.files) throw new Error('файловый браузер недоступен');
      const len = req.len ?? 0;
      const bytes = await this.files.readChunk(req.root ?? '', req.path ?? '', req.offset ?? 0, len);
      this.sendFrameBytes(
        s,
        jsonFrame(FrameType.FileChunkData, 0, { data: Buffer.from(bytes).toString('base64'), eof: bytes.length < len }),
      );
    } catch (err) {
      this.sendFrameBytes(s, jsonFrame(FrameType.FileChunkData, 0, { error: (err as Error).message }));
    }
  }

  /** Каталоги под корнями сессий через relay (для модалки создания — выбор из списка). */
  private async doDirs(s: ClientSession): Promise<void> {
    let dirs: { root: string; dirs: string[] }[] = [];
    try {
      dirs = await this.sessions.dirs();
    } catch {
      dirs = [];
    }
    this.sendFrameBytes(s, jsonFrame(FrameType.DirsResult, 0, { dirs }));
  }

  /** Генерация кода пейринга через relay (владелец): openPairing(scope) → код. */
  private async doShare(s: ClientSession, frame: Frame): Promise<void> {
    let scope: DeviceScope | undefined;
    try {
      const raw = frameJson<{ scope?: { session?: unknown; write?: unknown; files?: unknown } }>(frame).scope;
      scope =
        raw && typeof raw.session === 'string' && /^[\w.-]{1,40}$/.test(raw.session)
          ? { session: raw.session, write: raw.write === true, files: raw.files === true }
          : undefined;
    } catch {
      scope = undefined;
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
    this.sendFrameBytes(s, jsonFrame(FrameType.DevicesResult, 0, { devices: this.authorized() }));
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
    // Повторная сверка authorized на КАЖДЫЙ новый терминал: если устройство отозвали
    // (revoke) уже при живом streaming-коннекте, новые OPEN отклоняем и рвём сессию.
    // Существующие терминалы до дисконнекта продолжают работать (задокументировано).
    if (s.fingerprint && !this.authorized().some((d) => d.fingerprint === s.fingerprint)) {
      this.sendFrameBytes(s, jsonFrame(FrameType.Error, channel, { code: 'revoked', message: 'device revoked' }));
      return this.rejectClient(s, 'revoked', 'device revoked');
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
    try {
      await this.sessions.create({
        name: String(req.name ?? ''),
        root: String(req.root ?? ''),
        dir: String(req.dir ?? ''),
        preset: req.preset as 'zsh' | 'claude',
      });
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
        reject(new Error('Relay не подключён (тайм-аут ожидания регистрации)'));
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
