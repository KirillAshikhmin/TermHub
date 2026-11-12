// Транспорт-абстракция дашборда и терминала: единый интерфейс поверх двух
// реализаций — LAN (прямой REST + WS на агент, этот файл) и Relay (одно E2E
// WS-соединение с мультиплексом терминалов, remote.ts, грузится лениво). Крипто
// сюда НЕ импортируется, чтобы LAN-бандл не тянул libsodium.

import type { FileContent, FileEntry, SessionInfo, TerminalMode, TerminalState } from '@termhub/protocol/frames';

import { api } from './api';
import type {
  CaffeinateState,
  CreateSessionInput,
  DeviceInfo,
  DeviceScope,
  DirGroup,
  DetailResult,
  FeedOptions,
  FeedResult,
  FileStat,
  ShareInfo,
} from './api';
import type { ActResult, ChatAction, CommandsResult, LiveResult } from '@termhub/protocol/chat';
import { dataFrame, decodeFrame, FrameType, parseError, parseTerminalState, resizeFrame } from './ws-frames';

export type { CaffeinateState, CreateSessionInput, DeviceInfo, DeviceScope, DirGroup, FileStat, ShareInfo };
export type { DetailResult } from './api';
export type { ActResult, ChatAction, ChatCommand, CommandsResult, LiveResult, LiveState, ScreenState, ToolDetail } from '@termhub/protocol/chat';
export type { FeedEntry, ToolResult, FeedFailure, FeedFailureReason, FeedOptions, FeedPage, FeedResult } from './api';
export type { FileContent, FileEntry, TerminalMode, TerminalState };

/** Состояние соединения одного терминала — управляет индикатором/баннером. */
export type TermConnState = 'connected' | 'reconnecting' | 'closed';

/** Причина окончательного закрытия терминала (не переподключаемся). */
export interface TermEndReason {
  kind: 'ended' | 'error';
  message?: string;
}

/** Колбэки терминала, которые транспорт дёргает по мере работы канала. */
export interface TermChannelOpts {
  cols: number;
  rows: number;
  /** Просьба о способе подключения. Едет первым кадром, которым клиент открывает
   *  терминал (LAN — RESIZE, relay — OPEN), и снимается один раз на открытие: смена
   *  настройки не трогает живой терминал. Настройка агента старше просьбы, поэтому
   *  работающий режим — только тот, что пришёл в `onTerminalState`. */
  mode?: TerminalMode;
  /** Зритель размера (окошко терминала в чате): агент открывает терминал так, что размер
   *  окна сессии он не задаёт вовсе — ни подключением, ни просьбой. Едет тем же кадром
   *  открытия, что и `mode`; заявку размера такой канал не шлёт никогда. */
  passive?: boolean;
  /** Сырые байты вывода pty. */
  onData(bytes: Uint8Array): void;
  /** Звонок (BELL) от сессии. */
  onBell(): void;
  /** Сессия завершена окончательно (CLOSE/ERROR) — переподключения не будет. */
  onEnd(reason: TermEndReason): void;
  /** Смена состояния соединения (для индикатора/баннера). */
  onStatus(state: TermConnState): void;
  /** Состояние терминала на агенте: выбранный режим и альтернативный экран.
   *  Поля независимы — обновлять только пришедшие. */
  onTerminalState?(state: TerminalState): void;
}

/** Дуплекс терминала: ввод/ресайз/закрытие. */
export interface TermChannel {
  write(bytes: Uint8Array): void;
  /** `claim` — забирать ли размер окна себе (см. resizePayload); не назван — да. */
  resize(cols: number, rows: number, claim?: boolean): void;
  close(): void;
}

/** Транспорт: список/создание/убийство сессий, каталоги, открытие терминала. */
export interface Transport {
  readonly mode: 'lan' | 'relay';
  /**
   * Готовность соединения принимать запросы прямо сейчас (relay: E2E-поток
   * установлен). LAN всегда готов и это поле не объявляет — отсутствие (`undefined`)
   * читается вызывающей стороной как «готов». Позволяет дашборду отличить
   * временный обрыв relay от настоящей ошибки, не завязываясь на класс транспорта.
   */
  readonly isStreaming?: boolean;
  /** Ограничение доступа гостя (relay, после первого list); null/undefined — полный доступ. */
  readonly clientScope?: DeviceScope | null;
  list(): Promise<SessionInfo[]>;
  /** Создать сессию; резолвится ФАКТИЧЕСКИМ именем — при `autoName` агент мог добавить
   *  числовой суффикс. Старый агент имени не возвращает — тогда запрошенное (`req.name`). */
  create(req: CreateSessionInput): Promise<string>;
  kill(name: string): Promise<void>;
  /** Переименование сессии (tmux rename-session). Оба режима: LAN — REST, relay — E2E. */
  rename(from: string, to: string): Promise<void>;
  /** Каталоги для модалки создания; в relay-режиме — пустой список (ручной ввод). */
  dirs(): Promise<DirGroup[]>;
  /** Текущее состояние caffeinate (доступно в обоих режимах: LAN — REST, relay — E2E). */
  caffeinate(): Promise<CaffeinateState>;
  /** Переключить caffeinate; возвращает новое состояние. */
  setCaffeinate(active: boolean): Promise<CaffeinateState>;
  /** Режим «не спать при закрытой крышке» (хост на macOS); отказ хоста виден по ответу:
   *  `lid` остался false. Оба режима: LAN — REST, relay — тот же кадр Caffeinate. */
  setLidAwake(on: boolean): Promise<CaffeinateState>;
  /** Объявление возможностей (ADR 0018): называем свои имена, получаем список агента.
   *  Агент, который этого не умеет, отвечает 404 (LAN) или молчит (relay) — обе дороги
   *  дают пустой список, а не ошибку прикладного уровня. */
  capabilities(caps: string[]): Promise<string[]>;
  /** Страница ленты беседы сессии (оба режима: LAN — `GET /api/feed`, relay — кадр
   *  Feed). Отказ агента — значение `{ok:false, reason}`, а не исключение: причины
   *  экран разбирает одинаково на обоих транспортах. Исключение остаётся сбою связи.
   *  Вкладка ленты существует только при `hasCap('feed')`, поэтому старого агента,
   *  не знающего маршрута и кадра, этот вызов не касается. */
  feed(session: string, opts?: FeedOptions): Promise<FeedResult>;
  /** Подробности действия по курсору его записи (чат; возможность `chat`): команда и
   *  вывод, diff. Отказ — значением, как у ленты. LAN — `GET /api/feed?detail=`,
   *  relay — кадр Feed с полем `detail`. */
  feedDetail(session: string, cursor: string): Promise<DetailResult>;
  /** Экран агента в панели (чат; возможность `chat`). Только чтение, своя сессия — и гостю.
   *  Отказ — значением `{ok:false}`, исключение — сбой связи (relay: срок 10 с). */
  live(session: string): Promise<LiveResult>;
  /** Действие человека: запрос, ответ на вопрос, остановка, режим, модель, сжатие.
   *  Требует права ввода; отказ — значением. */
  act(session: string, action: ChatAction): Promise<ActResult>;
  /** Команды агента сессии для подсказок по «/». */
  /** `verify` — сверить список с экраном агента (агент нажимает клавиши в его строке ввода);
   *  без него — только чтение. */
  commands(session: string, opts?: { verify?: boolean }): Promise<CommandsResult>;
  /** VAPID public key агента для web-push (оба режима: LAN — REST, relay — E2E). */
  vapidKey(): Promise<string>;
  /** Отправить push-подписку агенту (оба режима). */
  subscribePush(subscription: unknown): Promise<void>;
  /** Листинг директории файлового браузера (оба режима: LAN — REST, relay — E2E). */
  filesList(root: string, subpath: string): Promise<FileEntry[]>;
  /** Чтение файла для просмотра (оба режима). */
  fileRead(root: string, subpath: string): Promise<FileContent>;
  /** Метаданные файла (размер/mime/тип) для стриминга — плеер или скачивание. */
  fileStat(root: string, subpath: string): Promise<FileStat>;
  /** Прямой URL для `<video>`/`<a download>` — LAN; в relay `null` (тянуть чанками). */
  downloadUrl(root: string, subpath: string): string | null;
  /** Собрать файл целиком в Blob (relay — чанками; LAN — fetch). onProgress(0..1). */
  fileBlob(root: string, subpath: string, onProgress?: (frac: number) => void): Promise<Blob>;
  /** Загрузить файл в папку: `subpath` — путь назначения вместе с именем файла.
   *  LAN — потоком одним POST; relay — кусками через E2E. onProgress(0..1).
   *  Существующий файл не перезаписывается (агент отвечает ошибкой). */
  uploadFile(root: string, subpath: string, file: File, onProgress?: (frac: number) => void): Promise<void>;
  /** Картинка из буфера обмена — файлом на хост; ответ — путь, который вставляют в
   *  терминал (term-paste.ts). Агент старше этой функции отвечает ошибкой. */
  pasteImage(blob: Blob): Promise<string>;
  /** Любой файл (вложение чата, до 50 МиБ) на хост; ответ — путь. `name` агент
   *  использует только для расширения. Агент старше этой функции отвечает ошибкой. */
  pasteFile(blob: Blob, name: string): Promise<string>;
  /** Картинка по абсолютному пути на хосте (миниатюры чата). Агент отдаёт только растр
   *  (png, jpeg, gif, webp) до 20 МиБ из корней сессий, каталога вложений и временного
   *  каталога агента; гостю — только из каталога его сессии и только с правом `files`.
   *  Любой отказ (и агент старше этой функции) — исключение. */
  image(session: string, path: string): Promise<Blob>;
  /** Операции VCS (git/svn/hg) над папкой в пределах корня (оба режима). action —
   *  log|show|status|diff|commit; params — {root, path, rev?, file?, files?, message?}. */
  repo<T = unknown>(action: string, params: Record<string, unknown>): Promise<T>;
  /** Файловые операции (stat-full/remove/move/copy) над файлом в пределах корня.
   *  Мутации требуют право записи (оба режима). */
  fileOp<T = unknown>(action: string, params: Record<string, unknown>): Promise<T>;
  /** Вкладка Gradle (оба режима). action — detect|tasks|configs|run|stop|status;
   *  params — {session, subdir?, tasks?, args?, force?, refresh?}. */
  gradle<T = unknown>(action: string, params: Record<string, unknown>): Promise<T>;
  /** Сгенерировать код пейринга; scope — ограничение гостя (оба режима). */
  share(scope?: DeviceScope): Promise<ShareInfo>;
  /** Список допущенных устройств (оба режима). */
  devices(): Promise<DeviceInfo[]>;
  /** Отозвать устройство по отпечатку (оба режима). */
  revoke(fingerprint: string): Promise<void>;
  openTerm(session: string, opts: TermChannelOpts): TermChannel;
  /** Освобождает ресурсы транспорта (для relay — закрывает WS). */
  close(): void;
}

// Backoff переподключения терминала: 1→2→4→8→15с (как раньше в term.ts).
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
// Соединение считается стабильным (backoff сбрасывается) только прожив дольше
// этого порога — иначе мгновенный open→close крутил бы реконнект раз в секунду.
const STABLE_MS = 3000;

/** LAN-канал терминала: прямой WS `/ws/term/:name` c backoff-переподключением. */
class LanTermChannel implements TermChannel {
  private ws: WebSocket | null = null;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stableTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private disposed = false;
  private ended = false;
  /** Просьба о режиме ещё не ушла на этом соединении. Каждое подключение создаёт
   *  агенту новый терминал, поэтому просьба повторяется после каждого реконнекта. */
  private modePending = false;
  /** Соединение уже поднималось: экран клиента несёт прежнее содержимое. */
  private everConnected = false;
  /** Признак переподключения ещё не ушёл на этом соединении (едет первым RESIZE). */
  private resumePending = false;
  private readonly url: string;

  constructor(
    session: string,
    private readonly opts: TermChannelOpts,
  ) {
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?name=${encodeURIComponent(session)}`;
    this.connect();
    // Возврат PWA из фона (Android усыпляет WS) / вернулась сеть — реконнектим сразу.
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onVisible);
  }

  private onVisible = (): void => {
    if (document.visibilityState !== 'visible' || this.disposed || this.ended) return;
    this.attempt = 0; // сброс backoff — следующий цикл (если нужен) снова с 1с
    const dead = !this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.dropStaleSocket();
      this.connect();
    } else if (dead) {
      this.dropStaleSocket();
      this.connect();
    }
  };

  /** Глушит предыдущий сокет перед новым подключением: без этого «полуживой»
   *  (CLOSING/CONNECTING) сокет продолжал жить своей жизнью и дублировал вывод. */
  private dropStaleSocket(): void {
    const old = this.ws;
    if (!old) return;
    this.ws = null;
    old.onopen = null;
    old.onmessage = null;
    old.onclose = null; // не планировать реконнект на программное закрытие
    old.onerror = null;
    try {
      old.close();
    } catch {
      // уже закрыт — идемпотентно
    }
  }

  private connect(): void {
    if (this.disposed) return;
    this.dropStaleSocket();
    this.modePending = !!this.opts.mode;
    // Второе и следующие подключения застают экран с прежним содержимым.
    this.resumePending = this.everConnected;
    const sock = new WebSocket(this.url);
    sock.binaryType = 'arraybuffer';
    this.ws = sock;

    sock.onopen = (): void => {
      if (this.disposed) {
        sock.close();
        return;
      }
      this.everConnected = true;
      this.opts.onStatus('connected');
      // Backoff сбрасываем только когда соединение прожило STABLE_MS.
      this.stableTimer = setTimeout(() => {
        this.stableTimer = undefined;
        this.attempt = 0;
      }, STABLE_MS);
    };

    sock.onmessage = (ev: MessageEvent): void => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      let frame;
      try {
        frame = decodeFrame(new Uint8Array(ev.data));
      } catch {
        return; // битый фрейм — игнорируем
      }
      if (frame.type === FrameType.Data) this.opts.onData(frame.payload);
      else if (frame.type === FrameType.Bell) this.opts.onBell();
      else if (frame.type === FrameType.TerminalState) this.opts.onTerminalState?.(parseTerminalState(frame));
      else if (frame.type === FrameType.Close) this.finish({ kind: 'ended' });
      else if (frame.type === FrameType.Error) {
        const { code, message } = parseError(frame);
        this.finish({ kind: 'error', message: message ?? code });
      }
    };

    sock.onclose = (): void => {
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
        this.stableTimer = undefined;
      }
      if (this.ws === sock) this.ws = null;
      if (this.disposed || this.ended) {
        this.opts.onStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };

    sock.onerror = (): void => {}; // за onerror всегда идёт onclose
  }

  private finish(reason: TermEndReason): void {
    this.ended = true;
    this.opts.onStatus('closed');
    this.opts.onEnd(reason);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.ended) return;
    this.opts.onStatus('reconnecting');
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  write(bytes: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(dataFrame(bytes));
  }

  resize(cols: number, rows: number, claim?: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const mode = this.modePending ? this.opts.mode : undefined;
    const resume = this.resumePending;
    this.modePending = false;
    this.resumePending = false;
    const passive = this.opts.passive === true;
    this.ws.send(resizeFrame(cols, rows, mode, passive ? false : claim, resume, passive));
  }

  close(): void {
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onVisible);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.ws) {
      this.ws.onclose = null; // не планировать reconnect на программное закрытие
      try {
        this.ws.close();
      } catch {
        // сокет уже закрыт — идемпотентно
      }
      this.ws = null;
    }
  }
}

/** LAN-транспорт: REST через api.ts, терминал — прямой WS. Без крипто. */
export class LanTransport implements Transport {
  readonly mode = 'lan' as const;
  readonly clientScope = null; // LAN — вход по паролю, полный доступ владельца

  list(): Promise<SessionInfo[]> {
    return api.sessions();
  }

  create(req: CreateSessionInput): Promise<string> {
    return api.createSession(req).then((r) => (typeof r?.session === 'string' && r.session ? r.session : req.name));
  }

  kill(name: string): Promise<void> {
    return api.killSession(name);
  }

  rename(from: string, to: string): Promise<void> {
    return api.renameSession(from, to);
  }

  dirs(): Promise<DirGroup[]> {
    return api.dirs();
  }

  caffeinate(): Promise<CaffeinateState> {
    return api.caffeinate();
  }

  setCaffeinate(active: boolean): Promise<CaffeinateState> {
    return api.setCaffeinate(active);
  }

  setLidAwake(on: boolean): Promise<CaffeinateState> {
    return api.setLidAwake(on);
  }

  capabilities(caps: string[]): Promise<string[]> {
    return api.capabilities(caps);
  }

  feed(session: string, opts: FeedOptions = {}): Promise<FeedResult> {
    return api.feed(session, opts);
  }

  feedDetail(session: string, cursor: string): Promise<DetailResult> {
    return api.feedDetail(session, cursor);
  }

  live(session: string): Promise<LiveResult> {
    return api.live(session);
  }

  act(session: string, action: ChatAction): Promise<ActResult> {
    return api.act(session, action);
  }

  commands(session: string, opts?: { verify?: boolean }): Promise<CommandsResult> {
    return api.commands(session, opts);
  }

  vapidKey(): Promise<string> {
    return api.vapidKey();
  }

  subscribePush(subscription: unknown): Promise<void> {
    return api.subscribePush(subscription);
  }

  filesList(root: string, subpath: string): Promise<FileEntry[]> {
    return api.filesList(root, subpath).then((r) => r.entries);
  }

  fileRead(root: string, subpath: string): Promise<FileContent> {
    return api.fileRead(root, subpath).then((r) => r.content);
  }

  fileStat(root: string, subpath: string): Promise<FileStat> {
    return api.fileStat(root, subpath).then((r) => r.stat);
  }

  downloadUrl(root: string, subpath: string): string | null {
    return api.fileDownloadUrl(root, subpath);
  }

  fileBlob(root: string, subpath: string): Promise<Blob> {
    return fetch(api.fileDownloadUrl(root, subpath)).then((r) => {
      if (!r.ok) throw new Error(`download ${r.status}`);
      return r.blob();
    });
  }

  uploadFile(root: string, subpath: string, file: File, onProgress?: (frac: number) => void): Promise<void> {
    return api.uploadFile(root, subpath, file, onProgress);
  }

  pasteImage(blob: Blob): Promise<string> {
    return api.pasteImage(blob);
  }

  pasteFile(blob: Blob, name: string): Promise<string> {
    return api.pasteFile(blob, name);
  }

  image(session: string, path: string): Promise<Blob> {
    return api.image(session, path);
  }

  repo<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    return api.repo<T>(action, params);
  }

  fileOp<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    return api.fileOp<T>(action, params);
  }

  gradle<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    return api.gradle<T>(action, params);
  }

  share(scope?: DeviceScope): Promise<ShareInfo> {
    return api.share(scope);
  }

  devices(): Promise<DeviceInfo[]> {
    return api.devices();
  }

  revoke(fingerprint: string): Promise<void> {
    return api.revoke(fingerprint);
  }

  openTerm(session: string, opts: TermChannelOpts): TermChannel {
    return new LanTermChannel(session, opts);
  }

  close(): void {
    // LAN-транспорт без ресурсов — закрывать нечего.
  }
}
