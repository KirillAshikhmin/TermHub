// Транспорт-абстракция дашборда и терминала: единый интерфейс поверх двух
// реализаций — LAN (прямой REST + WS на агент, этот файл) и Relay (одно E2E
// WS-соединение с мультиплексом терминалов, remote.ts, грузится лениво). Крипто
// сюда НЕ импортируется, чтобы LAN-бандл не тянул libsodium.

import type { FileContent, FileEntry, SessionInfo } from '@termhub/protocol/frames';

import { api } from './api';
import type { CaffeinateState, CreateSessionInput, DeviceInfo, DeviceScope, DirGroup, FileStat, ShareInfo } from './api';
import { dataFrame, decodeFrame, FrameType, parseError, resizeFrame } from './ws-frames';

export type { CaffeinateState, CreateSessionInput, DeviceInfo, DeviceScope, DirGroup, FileStat, ShareInfo };
export type { FileContent, FileEntry };

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
  /** Сырые байты вывода pty. */
  onData(bytes: Uint8Array): void;
  /** Звонок (BELL) от сессии. */
  onBell(): void;
  /** Сессия завершена окончательно (CLOSE/ERROR) — переподключения не будет. */
  onEnd(reason: TermEndReason): void;
  /** Смена состояния соединения (для индикатора/баннера). */
  onStatus(state: TermConnState): void;
}

/** Дуплекс терминала: ввод/ресайз/закрытие. */
export interface TermChannel {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
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
  create(req: CreateSessionInput): Promise<void>;
  kill(name: string): Promise<void>;
  /** Каталоги для модалки создания; в relay-режиме — пустой список (ручной ввод). */
  dirs(): Promise<DirGroup[]>;
  /** Текущее состояние caffeinate (доступно в обоих режимах: LAN — REST, relay — E2E). */
  caffeinate(): Promise<CaffeinateState>;
  /** Переключить caffeinate; возвращает новое состояние. */
  setCaffeinate(active: boolean): Promise<CaffeinateState>;
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
  /** Операции VCS (git/svn/hg) над папкой в пределах корня (оба режима). action —
   *  log|show|status|diff|commit; params — {root, path, rev?, file?, files?, message?}. */
  repo<T = unknown>(action: string, params: Record<string, unknown>): Promise<T>;
  /** Файловые операции (stat-full/remove/move/copy) над файлом в пределах корня.
   *  Мутации требуют право записи (оба режима). */
  fileOp<T = unknown>(action: string, params: Record<string, unknown>): Promise<T>;
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
  private readonly url: string;

  constructor(
    session: string,
    private readonly opts: TermChannelOpts,
  ) {
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term/${encodeURIComponent(session)}`;
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    const sock = new WebSocket(this.url);
    sock.binaryType = 'arraybuffer';
    this.ws = sock;

    sock.onopen = (): void => {
      if (this.disposed) {
        sock.close();
        return;
      }
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

  resize(cols: number, rows: number): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(resizeFrame(cols, rows));
  }

  close(): void {
    this.disposed = true;
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

  create(req: CreateSessionInput): Promise<void> {
    return api.createSession(req);
  }

  kill(name: string): Promise<void> {
    return api.killSession(name);
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

  repo<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    return api.repo<T>(action, params);
  }

  fileOp<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    return api.fileOp<T>(action, params);
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
