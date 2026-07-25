// Remote-транспорт клиента: одно WS-соединение к relay, E2E-хендшейк с агентом
// (hello → hello-ok → hello-fin → два secretstream-потока) и мультиплекс
// терминалов по channel фрейма. Зеркало агентского RelayLink (см. agent/relay-link.ts):
// роль клиента — 'client'. Relay содержимого не видит. Тянет libsodium — грузится
// лениво (динамический import из remote.ts), в LAN-бандл не попадает.

import {
  decodeFrame,
  encodeFrame,
  frameJson,
  FrameType,
  jsonFrame,
  makeDecryptor,
  makeEncryptor,
  sessionKeys,
  sign,
  handshakeTranscript,
  type Decryptor,
  type Encryptor,
  type Frame,
  type Identity,
  type SessionInfo,
  type FileEntry,
  type FileContent,
} from '@termhub/protocol';

import { b64, unb64 } from './b64';
import type { CaffeinateState, DeviceInfo, DeviceScope, FileStat, ShareInfo } from './api';
import type {
  CreateSessionInput,
  DirGroup,
  TermChannel,
  TermChannelOpts,
  Transport,
} from './transport';

/** Контрольный канал (LIST/CREATE/KILL/LIST_RESULT) — как у агента, всегда 0. */
const CONTROL_CHANNEL = 0;
/** Терминалы нумеруются с 1 (0 занят контролем). */
const FIRST_TERM_CHANNEL = 1;
/** Тайм-аут ответа на LIST (покрывает и начальный хендшейк). */
const LIST_TIMEOUT_MS = 10_000;
/** Backoff реконнекта: старт 1 с, удвоение до потолка 15 с. */
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 15_000;

const utf8dec = new TextDecoder();

/** Статус relay-линка для оркестратора (баннер «подключение/переподключение»). */
export type LinkStatus = 'connecting' | 'online' | 'reconnecting' | 'unauthorized' | 'closed';

/** Состояние WS-соединения по мере хендшейка. */
type LinkState = 'connecting' | 'handshaking' | 'streaming' | 'closed';

/** Живой терминал (мультиплекс нескольких pty в одном connId). */
interface TermEntry {
  channel: number;
  session: string;
  opts: TermChannelOpts;
  /** true после OPEN_OK; сбрасывается на реконнекте (пере-OPEN). */
  opened: boolean;
}

/** Ожидающий LIST_RESULT (FIFO — за раз в полёте обычно один). */
interface PendingList {
  resolve: (sessions: SessionInfo[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ожидающий CREATE_OK / Error(create-failed) (FIFO — создания сериализованы модалкой). */
interface PendingCreate {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ожидающий CAFFEINATE_RESULT (FIFO). */
interface PendingCaffeinate {
  resolve: (state: CaffeinateState) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ожидающий PUSH_KEY_RESULT (FIFO). */
interface PendingPushKey {
  resolve: (key: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ожидающий DIRS_RESULT (FIFO). */
interface PendingDirs {
  resolve: (groups: DirGroup[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ожидающий FILES_LIST_RESULT (FIFO). */
interface PendingFilesList {
  resolve: (entries: FileEntry[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ожидающий FILE_READ_RESULT (FIFO). */
interface PendingFileRead {
  resolve: (content: FileContent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ожидающий SHARE_RESULT (FIFO). */
interface PendingShare {
  resolve: (info: ShareInfo) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ожидающий DEVICES_RESULT (FIFO) — для devices() и revoke(). */
interface PendingDevices {
  resolve: (devices: DeviceInfo[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ожидающий FILE_STAT_RESULT (FIFO). */
interface PendingFileStat {
  resolve: (stat: FileStat) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ожидающий FILE_CHUNK_DATA (FIFO). */
interface PendingFileChunk {
  resolve: (chunk: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RelayTransportOpts {
  /** ws(s)://host/relay */
  url: string;
  identity: Identity;
  /** Агент: agentId (== fingerprint(edPub)) и его публичный ключ (base64). */
  agent: { agentId: string; edPub: string };
  /** Имя этого устройства (шлётся в hello). */
  clientName: string;
  /** Уведомление оркестратора о статусе линка. */
  onLink?: (status: LinkStatus) => void;
}

/** Remote-транспорт поверх relay с E2E до агента. */
export class RelayTransport implements Transport {
  readonly mode = 'relay' as const;

  /** Поток E2E установлен — соединение готово принимать LIST/CREATE/KILL. */
  get isStreaming(): boolean {
    return this.state === 'streaming';
  }

  /** Ограничение доступа этого клиента (гость), приходит с ListResult; null — полный доступ. */
  private _clientScope: DeviceScope | null = null;
  get clientScope(): DeviceScope | null {
    return this._clientScope;
  }

  private readonly url: string;
  private readonly identity: Identity;
  private readonly agentId: string;
  private readonly agentEdPub: Uint8Array;
  private readonly clientName: string;
  private readonly onLink?: (status: LinkStatus) => void;

  private ws?: WebSocket;
  private state: LinkState = 'connecting';
  private stopped = false;
  private encryptor?: Encryptor;
  private decryptor?: Decryptor;
  /** Кадры, накопленные до установления потока (flush на streaming). */
  private outbox: Uint8Array[] = [];
  private readonly terminals = new Map<number, TermEntry>();
  private nextChannel = FIRST_TERM_CHANNEL;
  private pendingList: PendingList[] = [];
  private pendingCreate: PendingCreate[] = [];
  private pendingCaffeinate: PendingCaffeinate[] = [];
  private pendingPushKey: PendingPushKey[] = [];
  // Сопоставление ответов по id, а НЕ по порядку (FIFO): агент обрабатывает кадры
  // асинхронно, время ответа зависит от размера каталога/файла, а таймаут вырезал
  // ожидающего из середины очереди — дальше все ответы съезжали на один. Для чанков
  // скачивания это давало ТИХУЮ порчу файла (правильный размер, перемешанные куски).
  private pendingDirs = new Map<number, PendingDirs>();
  private pendingFilesList = new Map<number, PendingFilesList>();
  private pendingFileRead = new Map<number, PendingFileRead>();
  private pendingShare: PendingShare[] = [];
  private pendingDevices: PendingDevices[] = [];
  private pendingFileStat = new Map<number, PendingFileStat>();
  private pendingFileChunk = new Map<number, PendingFileChunk>();
  /** Общий счётчик id для файловых/каталожных запросов. */
  private fileReqId = 0;
  // Repo — id-матчинг (Map): diff нескольких файлов может лететь конкурентно, FIFO не годится.
  private pendingRepo = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private repoReqId = 0;
  private pendingFileOp = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private fileOpReqId = 0;
  private backoff = BACKOFF_START_MS;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Был ли поток установлен хоть раз — влияет на статус (connecting vs reconnecting). */
  private everStreamed = false;

  constructor(opts: RelayTransportOpts) {
    this.url = opts.url;
    this.identity = opts.identity;
    this.agentId = opts.agent.agentId;
    this.agentEdPub = unb64(opts.agent.edPub);
    this.clientName = opts.clientName;
    this.onLink = opts.onLink;
    this.connect();
    // Возврат PWA из фона (Android усыпляет WS) / вернулась сеть — реконнектим сразу.
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onVisible);
  }

  private onVisible = (): void => {
    if (document.visibilityState !== 'visible' || this.stopped) return;
    this.backoff = BACKOFF_START_MS; // сброс — следующий цикл (если нужен) снова с 1с
    const dead = !this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.connect();
    } else if (dead) {
      this.connect();
    }
  };

  // ── Соединение и хендшейк ─────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    this.state = 'connecting';
    this.onLink?.(this.everStreamed ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = (): void => this.send({ t: 'connect', agentId: this.agentId });
    ws.onmessage = (ev: MessageEvent): void => this.onMessage(ws, ev);
    ws.onclose = (): void => this.onClose(ws);
    ws.onerror = (): void => {}; // за onerror всегда идёт onclose
  }

  private onMessage(ws: WebSocket, ev: MessageEvent): void {
    if (this.ws !== ws) return;
    if (typeof ev.data === 'string') {
      this.onText(ev.data);
      return;
    }
    if (ev.data instanceof ArrayBuffer) this.onBinary(new Uint8Array(ev.data));
  }

  private onText(data: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== 'object' || parsed === null) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.t === 'connected') this.startHandshake();
    else if (msg.t === 'error') {
      // agent-offline и пр. — соединение закроется, реконнект в onClose.
      this.onLink?.(this.everStreamed ? 'reconnecting' : 'connecting');
    }
  }

  /** Шлёт plaintext hello внутри DATA-фрейма (канал 0) — агент проверит fingerprint. */
  private startHandshake(): void {
    this.state = 'handshaking';
    this.sendRaw(jsonFrame(FrameType.Data, 0, { t: 'hello', edPub: b64(this.identity.edPub), name: this.clientName }));
  }

  private onBinary(payload: Uint8Array): void {
    if (this.state === 'handshaking') {
      this.onHandshakeFrame(payload);
      return;
    }
    if (this.state !== 'streaming' || !this.decryptor) return;
    let plain: Uint8Array;
    try {
      plain = this.decryptor.pull(payload);
    } catch {
      this.dropSocket(); // подделка/рассинхрон — переустановим соединение
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
      this.stopped = true;
      this.onLink?.('unauthorized');
      this.dropSocket();
      return;
    }
    if (frame.type !== FrameType.Data) return;
    let msg: { t?: unknown; header?: unknown; nonce?: unknown };
    try {
      msg = JSON.parse(utf8dec.decode(frame.payload)) as { t?: unknown; header?: unknown; nonce?: unknown };
    } catch {
      return;
    }
    if (msg.t !== 'hello-ok' || typeof msg.header !== 'string') return;
    // Агент обязан прислать челлендж свежести — без него сессию не начинаем (иначе
    // относительно replay мы вернулись бы к старому, уязвимому поведению).
    if (typeof msg.nonce !== 'string') return;

    const { rx, tx } = sessionKeys('client', this.identity, this.agentEdPub);
    this.encryptor = makeEncryptor(tx);
    const serverHeader = unb64(msg.header);
    this.decryptor = makeDecryptor(rx, serverHeader);
    // hello-fin — plaintext (последний кадр до потоков): свой header + подпись
    // транскрипта (челлендж ‖ наш header ‖ header агента) долговременным ключом.
    const sig = sign(this.identity.edSec, handshakeTranscript(unb64(msg.nonce), this.encryptor.header, serverHeader));
    this.sendRaw(
      jsonFrame(FrameType.Data, 0, { t: 'hello-fin', header: b64(this.encryptor.header), sig: b64(sig) }),
    );
    this.state = 'streaming';
    this.everStreamed = true;
    this.backoff = BACKOFF_START_MS;
    this.onLink?.('online');
    this.onStreamReady();
  }

  /**
   * Поток установлен: сначала пере-открываем терминалы (OPEN каждого активного
   * channel), и только потом сливаем очередь. Иначе DATA/RESIZE, накопленные в
   * outbox пока шёл хендшейк (state !== 'streaming'), ушли бы агенту раньше
   * OPEN своего канала и были бы им отброшены — это верно и для первого
   * подключения (терминал мог открыться до завершения хендшейка), и для
   * реконнекта.
   */
  private onStreamReady(): void {
    for (const entry of this.terminals.values()) {
      entry.opened = false;
      this.sendEncrypted(jsonFrame(FrameType.Open, entry.channel, { session: entry.session }));
    }
    const queued = this.outbox;
    this.outbox = [];
    for (const bytes of queued) this.sendEncrypted(bytes);
  }

  /** Достаёт ожидающего по id из ответа. Ответ без id (старый агент) не сопоставляем:
   *  лучше дать запросу честно упасть по таймауту, чем отдать ЧУЖОЙ результат. */
  private takePending<T extends { timer: ReturnType<typeof setTimeout> }>(
    map: Map<number, T>,
    frame: Frame,
  ): T | undefined {
    let id: unknown;
    try {
      id = frameJson<{ id?: unknown }>(frame).id;
    } catch {
      return undefined;
    }
    if (typeof id !== 'number') return undefined;
    const pending = map.get(id);
    if (pending) map.delete(id);
    return pending;
  }

  private dispatch(frame: Frame): void {
    switch (frame.type) {
      case FrameType.ListResult: {
        const pending = this.pendingList.shift();
        if (!pending) return;
        clearTimeout(pending.timer);
        let sessions: SessionInfo[] = [];
        try {
          const r = frameJson<{ sessions: SessionInfo[]; scope?: DeviceScope | null }>(frame);
          sessions = r.sessions ?? [];
          this._clientScope = r.scope ?? null; // ограничение гостя (для read-only UI)
        } catch {
          sessions = [];
        }
        pending.resolve(sessions);
        return;
      }
      case FrameType.CreateOk: {
        const pending = this.pendingCreate.shift();
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.resolve();
        return;
      }
      case FrameType.CaffeinateResult: {
        const pending = this.pendingCaffeinate.shift();
        if (!pending) return;
        clearTimeout(pending.timer);
        let state: CaffeinateState = { active: false, supported: false };
        try {
          state = frameJson<CaffeinateState>(frame);
        } catch {
          state = { active: false, supported: false };
        }
        pending.resolve(state);
        return;
      }
      case FrameType.PushKeyResult: {
        const pending = this.pendingPushKey.shift();
        if (!pending) return;
        clearTimeout(pending.timer);
        let key = '';
        try {
          key = frameJson<{ key: string }>(frame).key ?? '';
        } catch {
          key = '';
        }
        pending.resolve(key);
        return;
      }
      case FrameType.DirsResult: {
        const pending = this.takePending(this.pendingDirs, frame);
        if (!pending) return;
        clearTimeout(pending.timer);
        let groups: DirGroup[] = [];
        try {
          groups = frameJson<{ dirs: DirGroup[] }>(frame).dirs ?? [];
        } catch {
          groups = [];
        }
        pending.resolve(groups);
        return;
      }
      case FrameType.FilesListResult: {
        const pending = this.takePending(this.pendingFilesList, frame);
        if (!pending) return;
        clearTimeout(pending.timer);
        try {
          const r = frameJson<{ entries?: FileEntry[]; error?: string }>(frame);
          if (r.error) pending.reject(new Error(r.error));
          else pending.resolve(r.entries ?? []);
        } catch {
          pending.reject(new Error('bad files-list result'));
        }
        return;
      }
      case FrameType.FileReadResult: {
        const pending = this.takePending(this.pendingFileRead, frame);
        if (!pending) return;
        clearTimeout(pending.timer);
        try {
          const r = frameJson<{ content?: FileContent; error?: string }>(frame);
          if (r.error || !r.content) pending.reject(new Error(r.error ?? 'no content'));
          else pending.resolve(r.content);
        } catch {
          pending.reject(new Error('bad file-read result'));
        }
        return;
      }
      case FrameType.RepoResult: {
        let r: { id?: number; result?: unknown; error?: string };
        try {
          r = frameJson(frame);
        } catch {
          return;
        }
        if (typeof r.id !== 'number') return;
        const pending = this.pendingRepo.get(r.id);
        if (!pending) return;
        this.pendingRepo.delete(r.id);
        clearTimeout(pending.timer);
        if (r.error) pending.reject(new Error(r.error));
        else pending.resolve(r.result);
        return;
      }
      case FrameType.FileOpResult: {
        let r: { id?: number; result?: unknown; error?: string };
        try {
          r = frameJson(frame);
        } catch {
          return;
        }
        if (typeof r.id !== 'number') return;
        const pending = this.pendingFileOp.get(r.id);
        if (!pending) return;
        this.pendingFileOp.delete(r.id);
        clearTimeout(pending.timer);
        if (r.error) pending.reject(new Error(r.error));
        else pending.resolve(r.result);
        return;
      }
      case FrameType.ShareResult: {
        const pending = this.pendingShare.shift();
        if (!pending) return;
        clearTimeout(pending.timer);
        try {
          const r = frameJson<{ code?: string; expiresAt?: number; error?: string }>(frame);
          if (r.error || !r.code) pending.reject(new Error(r.error ?? 'no code'));
          else pending.resolve({ code: r.code, expiresAt: r.expiresAt ?? 0 });
        } catch {
          pending.reject(new Error('bad share result'));
        }
        return;
      }
      case FrameType.DevicesResult: {
        const pending = this.pendingDevices.shift();
        if (!pending) return;
        clearTimeout(pending.timer);
        try {
          pending.resolve(frameJson<{ devices: DeviceInfo[] }>(frame).devices ?? []);
        } catch {
          pending.resolve([]);
        }
        return;
      }
      case FrameType.FileStatResult: {
        const pending = this.takePending(this.pendingFileStat, frame);
        if (!pending) return;
        clearTimeout(pending.timer);
        try {
          const r = frameJson<{ stat?: FileStat; error?: string }>(frame);
          if (r.error || !r.stat) pending.reject(new Error(r.error ?? 'no stat'));
          else pending.resolve(r.stat);
        } catch {
          pending.reject(new Error('bad file-stat'));
        }
        return;
      }
      case FrameType.FileChunkData: {
        const pending = this.takePending(this.pendingFileChunk, frame);
        if (!pending) return;
        clearTimeout(pending.timer);
        try {
          const r = frameJson<{ data?: string; error?: string }>(frame);
          if (r.error) pending.reject(new Error(r.error));
          else pending.resolve(r.data ? Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)) : new Uint8Array(0));
        } catch {
          pending.reject(new Error('bad file-chunk'));
        }
        return;
      }
      case FrameType.OpenOk: {
        const entry = this.terminals.get(frame.channel);
        if (entry && !entry.opened) {
          entry.opened = true;
          entry.opts.onStatus('connected');
        }
        return;
      }
      case FrameType.Data: {
        this.terminals.get(frame.channel)?.opts.onData(frame.payload);
        return;
      }
      case FrameType.Bell: {
        this.terminals.get(frame.channel)?.opts.onBell();
        return;
      }
      case FrameType.Close: {
        const entry = this.terminals.get(frame.channel);
        if (!entry) return;
        this.terminals.delete(frame.channel);
        entry.opts.onStatus('closed');
        entry.opts.onEnd({ kind: 'ended' });
        return;
      }
      case FrameType.Error: {
        const entry = this.terminals.get(frame.channel);
        if (!entry) {
          // Ошибка control-канала. Неудачу CREATE отклоняем в ожидающего create()
          // (модалка покажет сообщение); прочие (KILL/RENAME) — молча.
          let err: { code?: string; message?: string } = {};
          try {
            err = frameJson<{ code?: string; message?: string }>(frame);
          } catch {
            /* битый payload — молча */
          }
          if (err.code === 'create-failed') {
            const pending = this.pendingCreate.shift();
            if (pending) {
              clearTimeout(pending.timer);
              pending.reject(new Error(err.message ?? 'create failed'));
            }
          }
          return;
        }
        let message: string | undefined;
        try {
          const err = frameJson<{ code?: string; message?: string }>(frame);
          message = err.message ?? err.code;
        } catch {
          message = undefined;
        }
        this.terminals.delete(frame.channel);
        entry.opts.onStatus('closed');
        entry.opts.onEnd({ kind: 'error', message });
        return;
      }
      default:
        return; // PONG и пр. — игнорируем
    }
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.state = 'closed';
    this.encryptor = undefined;
    this.decryptor = undefined;
    for (const pending of [
      ...this.pendingList,
      ...this.pendingCreate,
      ...this.pendingCaffeinate,
      ...this.pendingPushKey,

      ...this.pendingShare,
      ...this.pendingDevices,

    ]) {
      clearTimeout(pending.timer);
      pending.reject(new Error('relay disconnected'));
    }
    this.pendingList = [];
    this.pendingCreate = [];
    this.pendingCaffeinate = [];
    this.pendingPushKey = [];

    this.pendingShare = [];
    this.pendingDevices = [];

    // Все id-очереди (Map) — единообразно.
    for (const map of [
      this.pendingRepo,
      this.pendingFileOp,
      this.pendingDirs,
      this.pendingFilesList,
      this.pendingFileRead,
      this.pendingFileStat,
      this.pendingFileChunk,
    ] as Array<Map<number, { timer: ReturnType<typeof setTimeout>; reject: (e: Error) => void }>>) {
      for (const pending of map.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('relay disconnected'));
      }
      map.clear();
    }
    if (this.stopped) {
      this.onLink?.('closed');
      return;
    }
    for (const entry of this.terminals.values()) {
      entry.opened = false;
      entry.opts.onStatus('reconnecting');
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.onLink?.(this.everStreamed ? 'reconnecting' : 'connecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  /** Закрывает текущий сокет (onClose подхватит реконнект, если не stopped). */
  private dropSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close();
    } catch {
      // уже закрыт — идемпотентно
    }
  }

  // ── Отправка ──────────────────────────────────────────────────────────────

  /** Ставит кадр в поток (шифрует) или в очередь до установления потока. */
  private sendFrame(frameBytes: Uint8Array): void {
    if (this.state === 'streaming') this.sendEncrypted(frameBytes);
    else this.outbox.push(frameBytes);
  }

  private sendEncrypted(frameBytes: Uint8Array): void {
    if (!this.encryptor || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Клиент шлёт ЧИСТЫЕ байты — relay сам добавит [connId] в сторону агента.
    this.ws.send(this.encryptor.push(frameBytes));
  }

  /** Plaintext-кадр хендшейка (hello / hello-fin) — до установления потоков. */
  private sendRaw(frameBytes: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frameBytes);
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // ── Transport API ───────────────────────────────────────────────────────────

  list(): Promise<SessionInfo[]> {
    // Поток ещё не установлен (хендшейк/реконнект в процессе) — отказываем сразу,
    // не копим LIST в outbox и не ждём LIST_TIMEOUT_MS: дашборд поллит раз в 3с,
    // и во время обрыва relay каждый такой LIST иначе завис бы в очереди.
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    return new Promise<SessionInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingList = this.pendingList.filter((p) => p.timer !== timer);
        reject(new Error('list timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingList.push({ resolve, reject, timer });
      this.sendFrame(encodeFrame({ type: FrameType.List, channel: CONTROL_CHANNEL, payload: new Uint8Array(0) }));
    });
  }

  create(req: CreateSessionInput): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('relay closed'));
    // Дожидаемся CreateOk (или Error(create-failed)) от агента: создание не мгновенно,
    // а навигация модалки должна уйти на уже существующую сессию (паритет с LAN, где
    // POST ждёт реального tmux new-session).
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCreate = this.pendingCreate.filter((p) => p.timer !== timer);
        reject(new Error('create timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingCreate.push({ resolve, reject, timer });
      this.sendFrame(jsonFrame(FrameType.Create, CONTROL_CHANNEL, req));
    });
  }

  kill(name: string): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('relay closed'));
    this.sendFrame(jsonFrame(FrameType.Kill, CONTROL_CHANNEL, { session: name }));
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('relay closed'));
    // Агент не подтверждает RENAME — отправляем и полагаемся на последующий poll.
    this.sendFrame(jsonFrame(FrameType.RenameSession, CONTROL_CHANNEL, { from, to }));
    return Promise.resolve();
  }

  dirs(): Promise<DirGroup[]> {
    // Каталоги под корнями — через E2E-канал агента (как LIST), чтобы модалка
    // создания давала выбор из списка и в relay-режиме, а не ручной ввод.
    if (!this.isStreaming) return Promise.resolve([]);
    const id = ++this.fileReqId;
    return new Promise<DirGroup[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDirs.delete(id);
        reject(new Error('dirs timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingDirs.set(id, { resolve, reject, timer });
      this.sendFrame(jsonFrame(FrameType.Dirs, CONTROL_CHANNEL, { id }));
    });
  }

  repo<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    const id = ++this.repoReqId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRepo.delete(id);
        reject(new Error('repo timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingRepo.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.sendFrame(jsonFrame(FrameType.Repo, CONTROL_CHANNEL, { id, action, ...params }));
    });
  }

  fileOp<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    const id = ++this.fileOpReqId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFileOp.delete(id);
        reject(new Error('file-op timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingFileOp.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.sendFrame(jsonFrame(FrameType.FileOp, CONTROL_CHANNEL, { id, action, ...params }));
    });
  }

  filesList(root: string, subpath: string): Promise<FileEntry[]> {
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    const id = ++this.fileReqId;
    return new Promise<FileEntry[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFilesList.delete(id);
        reject(new Error('files-list timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingFilesList.set(id, { resolve, reject, timer });
      this.sendFrame(jsonFrame(FrameType.FilesList, CONTROL_CHANNEL, { id, root, path: subpath }));
    });
  }

  fileRead(root: string, subpath: string): Promise<FileContent> {
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    const id = ++this.fileReqId;
    return new Promise<FileContent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFileRead.delete(id);
        reject(new Error('file-read timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingFileRead.set(id, { resolve, reject, timer });
      this.sendFrame(jsonFrame(FrameType.FileRead, CONTROL_CHANNEL, { id, root, path: subpath }));
    });
  }

  fileStat(root: string, subpath: string): Promise<FileStat> {
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    const id = ++this.fileReqId;
    return new Promise<FileStat>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFileStat.delete(id);
        reject(new Error('file-stat timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingFileStat.set(id, { resolve, reject, timer });
      this.sendFrame(jsonFrame(FrameType.FileStat, CONTROL_CHANNEL, { id, root, path: subpath }));
    });
  }

  /** У relay нет HTTP — прямого URL нет, тянем через fileBlob (чанки). */
  downloadUrl(): string | null {
    return null;
  }

  /** Собирает файл в Blob чанками через E2E-канал (blob-стриминг). Транзиентный
   *  таймаут/обрыв relay не рвёт всю загрузку: тот же offset докачивается с бэкоффом
   *  (чанки адресуются по offset — естественная докачка). */
  async fileBlob(root: string, subpath: string, onProgress?: (frac: number) => void): Promise<Blob> {
    const stat = await this.fileStat(root, subpath);
    const CHUNK = 256 * 1024;
    const CHUNK_TIMEOUT_MS = 20_000; // чанк крупнее LIST-запроса — таймаут щедрее
    const RETRIES = 4;
    const parts: BlobPart[] = [];
    let offset = 0;
    while (offset < stat.size) {
      const len = Math.min(CHUNK, stat.size - offset);
      let chunk: Uint8Array | undefined;
      for (let attempt = 0; ; attempt++) {
        if (this.stopped) throw new Error('relay closed');
        try {
          chunk = await this.requestChunk(root, subpath, offset, len, CHUNK_TIMEOUT_MS);
          break;
        } catch (err) {
          if (attempt >= RETRIES) throw err; // исчерпали попытки — пробрасываем ошибку
          await this.sleep(Math.min(1000 * (attempt + 1), 3000)); // бэкофф: ждём восстановления потока
        }
      }
      if (chunk.length === 0) break;
      // TS 5.7 типизирует Uint8Array как Uint8Array<ArrayBufferLike>, а BlobPart ждёт
      // ArrayBuffer; в рантайме Uint8Array — валидный BlobPart, каст точечный и безопасный.
      parts.push(chunk as BlobPart);
      offset += chunk.length;
      onProgress?.(stat.size ? offset / stat.size : 1);
    }
    return new Blob(parts, { type: stat.mime });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  private requestChunk(
    root: string,
    subpath: string,
    offset: number,
    len: number,
    timeoutMs = LIST_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    const id = ++this.fileReqId;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFileChunk.delete(id);
        reject(new Error('file-chunk timeout'));
      }, timeoutMs);
      this.pendingFileChunk.set(id, { resolve, reject, timer });
      this.sendFrame(jsonFrame(FrameType.FileChunk, CONTROL_CHANNEL, { id, root, path: subpath, offset, len }));
    });
  }

  share(scope?: DeviceScope): Promise<ShareInfo> {
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    return new Promise<ShareInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingShare = this.pendingShare.filter((p) => p.timer !== timer);
        reject(new Error('share timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingShare.push({ resolve, reject, timer });
      this.sendFrame(jsonFrame(FrameType.Share, CONTROL_CHANNEL, scope ? { scope } : {}));
    });
  }

  devices(): Promise<DeviceInfo[]> {
    return this.requestDevices(encodeFrame({ type: FrameType.Devices, channel: CONTROL_CHANNEL, payload: new Uint8Array(0) }));
  }

  revoke(fingerprint: string): Promise<void> {
    return this.requestDevices(jsonFrame(FrameType.Revoke, CONTROL_CHANNEL, { fingerprint })).then(() => undefined);
  }

  /** Devices/Revoke — оба ждут DevicesResult (обновлённый список). */
  private requestDevices(frameBytes: Uint8Array): Promise<DeviceInfo[]> {
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    return new Promise<DeviceInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDevices = this.pendingDevices.filter((p) => p.timer !== timer);
        reject(new Error('devices timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingDevices.push({ resolve, reject, timer });
      this.sendFrame(frameBytes);
    });
  }

  caffeinate(): Promise<CaffeinateState> {
    return this.requestCaffeinate({});
  }

  setCaffeinate(active: boolean): Promise<CaffeinateState> {
    return this.requestCaffeinate({ active });
  }

  /** Пустой запрос — состояние; `{active}` — установка. Ждёт CAFFEINATE_RESULT. */
  private requestCaffeinate(req: { active?: boolean }): Promise<CaffeinateState> {
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    return new Promise<CaffeinateState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCaffeinate = this.pendingCaffeinate.filter((p) => p.timer !== timer);
        reject(new Error('caffeinate timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingCaffeinate.push({ resolve, reject, timer });
      this.sendFrame(jsonFrame(FrameType.Caffeinate, CONTROL_CHANNEL, req));
    });
  }

  vapidKey(): Promise<string> {
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPushKey = this.pendingPushKey.filter((p) => p.timer !== timer);
        reject(new Error('vapid-key timeout'));
      }, LIST_TIMEOUT_MS);
      this.pendingPushKey.push({ resolve, reject, timer });
      this.sendFrame(encodeFrame({ type: FrameType.PushKey, channel: CONTROL_CHANNEL, payload: new Uint8Array(0) }));
    });
  }

  subscribePush(subscription: unknown): Promise<void> {
    if (!this.isStreaming) return Promise.reject(new Error('relay not streaming'));
    // Агент не подтверждает подписку — отправляем и полагаемся на best-effort.
    this.sendFrame(jsonFrame(FrameType.PushSubscribe, CONTROL_CHANNEL, { subscription }));
    return Promise.resolve();
  }

  openTerm(session: string, opts: TermChannelOpts): TermChannel {
    const channel = this.nextChannel++;
    const entry: TermEntry = { channel, session, opts, opened: false };
    this.terminals.set(channel, entry);
    // OPEN шлём сразу только если поток уже установлен; иначе терминал откроет
    // onStreamReady — так закрытие до установления потока не оставит «висячий» OPEN.
    if (this.state === 'streaming') this.sendEncrypted(jsonFrame(FrameType.Open, channel, { session }));
    return {
      write: (bytes: Uint8Array): void => this.sendFrame(encodeFrame({ type: FrameType.Data, channel, payload: bytes })),
      resize: (cols: number, rows: number): void => this.sendFrame(jsonFrame(FrameType.Resize, channel, { cols, rows })),
      close: (): void => {
        if (this.terminals.delete(channel) && this.state === 'streaming')
          this.sendFrame(jsonFrame(FrameType.Close, channel, {}));
      },
    };
  }

  close(): void {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onVisible);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const pending of this.pendingList) {
      clearTimeout(pending.timer);
      pending.reject(new Error('relay closed'));
    }
    this.pendingList = [];
    this.terminals.clear();
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // уже закрыт — идемпотентно
      }
    }
  }
}
