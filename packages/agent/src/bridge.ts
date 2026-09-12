// Мост tmux ↔ WebSocket. attachTerminal — обвязка без знания о WS: открывает связь с
// сессией через session-link (control mode с откатом на `tmux attach`), отдаёт вывод
// байтами и сигналит о звонке, выбранном режиме, альтернативном экране и выходе.
// wireTerminalWs строит из неё обработчик терминальных WS для AgentServer.

import type { WebSocket, RawData } from 'ws';
import { encodeFrame, jsonFrame, frameJson, decodeFrame, FrameType } from '@termhub/protocol';
import type { TerminalMode } from '@termhub/protocol';
import { open as openSession } from './session-link.js';
import { defaultPtyPool, PtyUnavailableError, type PtyPool } from './pty-pool.js';

/** Байт BEL: его появление в выводе → колокольчик. */
const BEL = 0x07;
/** В LAN один WS на терминал → мультиплексирования нет, channel всегда 0. */
const LAN_CHANNEL = 0;

/** Backpressure pty→WS: при переполнении буфера WS паузим pty, при сливе — возобновляем. */
const WS_HIGH_WATER = 1 << 20; // 1 MiB — порог паузы pty
const WS_LOW_WATER = 256 * 1024; // 256 KiB — порог возобновления
const WS_DRAIN_INTERVAL_MS = 50; // период опроса bufferedAmount при паузе

/** Сколько вывода ждёт снимка экрана. Дальше ждать нечего: то, что было на экране,
 *  уже перерисовано этим выводом, и придержанный мегабайт стоит дороже картинки. */
const SNAPSHOT_BACKLOG_LIMIT = 1 << 20;

/** Сколько живой вывод ждёт снимка по времени. Молчащий capture-pane отпустил бы его
 *  только по сроку команды (10 с) — столько пользователь смотрел бы в пустой экран.
 *  Поток без снимка лучше: снимок всего лишь дорисовывает то, что было до подключения. */
const SNAPSHOT_HOLD_MS = 3000;

const EMPTY = new Uint8Array(0);

/** Управление живым терминалом поверх tmux-сессии. */
export interface TerminalHandle {
  write(b: Uint8Array): void;
  resize(c: number, r: number): void;
  /** Приостановить чтение из pty (backpressure: медленный WS-потребитель). */
  pause(): void;
  /** Возобновить чтение из pty после слива буфера WS. */
  resume(): void;
  dispose(): void;
  /** Способ подключения, выбранный при открытии; undefined — решение ещё идёт.
   *  Он же уходит наружу колбэком `onMode`, как только становится известен. */
  readonly mode?: TerminalMode;
  /** Снимок экрана с историей — то, что уже было в сессии до подключения. Пусто в режиме
   *  attach (там экран приходит перерисовкой) и при отказе tmux. Открытие терминала
   *  снимок берёт само и отдаёт его первым же `onData`; метод остаётся для повторного. */
  snapshot?(lines?: number): Promise<Uint8Array>;
}

/** Открывает терминал сессии и связывает его вывод с колбэками. Каким способом добыты
 *  байты — control mode или прежний attach — решает session-link; знанием о WS функция
 *  не обладает, обвязку строит wireTerminalWs. */
export function attachTerminal(opts: {
  session: string;
  socketName?: string;
  cols: number;
  rows: number;
  onData: (b: Uint8Array) => void;
  onExit: () => void;
  onBell: (session: string) => void;
  /** Настройка агента (`config.terminalMode`): `attach` запрещает control mode
   *  и просьбой клиента не перебивается. */
  configMode?: TerminalMode;
  /** Просьба клиента: LAN — поле первого кадра RESIZE, relay — поле кадра OPEN.
   *  Незнакомое значение игнорируется. */
  requestedMode?: string;
  /** Режим выбран — клиент показывает его в интерфейсе. */
  onMode?: (mode: TerminalMode) => void;
  /** Приложение в активной панели вошло в альтернативный экран или вышло из него. */
  onAltScreen?: (active: boolean) => void;
  /** Общий budget назначается bridge-обвязкой; прямой вызов остаётся тестируемым без него. */
  ptyPool?: PtyPool;
}): TerminalHandle {
  let disposed = false;
  // Снимок отдан (или его не будет) — дальше вывод идёт клиенту напрямую.
  let streaming = false;
  const backlog: Uint8Array[] = [];
  let backlogBytes = 0;

  // Скан на «звонок» с переносом состояния между чанками: BEL (0x07) считается
  // звонком, только если он НЕ терминатор OSC-последовательности. Shell ставит
  // заголовок окна `ESC ] 0 ; … BEL` на каждом приглашении — наивный indexOf(BEL)
  // сигналил бы звонком почти на каждую команду. Стейт-машина: `ESC ]` → inOsc;
  // в OSC байт BEL или `ESC \` (ST) завершает OSC (это НЕ звонок); BEL вне OSC →
  // настоящий звонок. inOsc/escPending живут вне scanBell — состояние тянется через
  // границу чанков (OSC может быть разорван между двумя onData).
  let inOsc = false;
  let escPending = false;
  const scanBell = (bytes: Uint8Array): boolean => {
    let bell = false;
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i];
      if (escPending) {
        escPending = false;
        if (!inOsc && b === 0x5d) inOsc = true; // ESC ] → вход в OSC
        else if (inOsc && b === 0x5c) inOsc = false; // ESC \ (ST) → конец OSC, не звонок
        else if (b === 0x1b) escPending = true; // ESC ESC → ждём следующий байт
        continue;
      }
      if (b === 0x1b) {
        escPending = true;
        continue;
      }
      if (inOsc) {
        if (b === BEL) inOsc = false; // BEL завершает OSC — не звонок
        continue;
      }
      if (b === BEL) bell = true; // настоящий звонок (эмитим один раз на чанк)
    }
    return bell;
  };

  /** Срок придержания: его снимает первый же flush, чей бы повод ни был. */
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const clearHold = (): void => {
    if (holdTimer === undefined) return;
    clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  /** Отпускает придержанный вывод: с этого момента поток идёт клиенту сразу. */
  const flush = (): void => {
    clearHold();
    streaming = true;
    for (const part of backlog) opts.onData(part);
    backlog.length = 0;
    backlogBytes = 0;
  };

  const link = openSession(opts.session, {
    socketName: opts.socketName,
    cols: opts.cols,
    rows: opts.rows,
    configMode: opts.configMode,
    requestedMode: opts.requestedMode,
    onData: (bytes: Uint8Array): void => {
      if (disposed) return;
      if (scanBell(bytes)) opts.onBell(opts.session);
      if (streaming) {
        opts.onData(bytes);
        return;
      }
      backlog.push(bytes);
      backlogBytes += bytes.length;
      if (backlogBytes > SNAPSHOT_BACKLOG_LIMIT) flush();
    },
    onExit: (): void => {
      if (disposed) return;
      disposed = true;
      clearHold();
      opts.onExit();
    },
    onAltScreen: opts.onAltScreen,
    ptyPool: opts.ptyPool,
  });

  // В режиме attach решение принято синхронно и снимка не будет: tmux сам перерисует
  // экран при подключении. Control mode экран не перерисовывает — то, что на нём уже
  // есть, приходит снимком, и живой вывод до него придерживается: иначе он лёг бы
  // на экран раньше картинки, поверх которой его напечатали.
  if (link.mode !== undefined) streaming = true;
  else
    holdTimer = setTimeout((): void => {
      // Отмена снимка по сроку — событие для лога: молча пропавшая история экрана
      // неотличима от истории, которой не было, а отказ самой команды уже логируется.
      console.warn(`[bridge] snapshot skipped for session ${opts.session}: no answer in ${SNAPSHOT_HOLD_MS} ms`);
      flush();
    }, SNAPSHOT_HOLD_MS);
  void link.ready
    .then(async (mode: TerminalMode): Promise<void> => {
      if (disposed) return;
      opts.onMode?.(mode);
      // Снимок берётся сразу после готовности: пока capture-pane в полёте, session-link
      // держит вывод панели, поэтому дважды на экран он не попадёт.
      const shot = mode === 'control' ? await link.snapshot() : EMPTY;
      if (disposed) return;
      // Звонок по снимку не бьём: в истории он уже отзвонил, когда случился.
      if (!streaming && shot.length > 0) opts.onData(shot);
      flush();
    })
    .catch((err: unknown): void => {
      // Это продолжение промиса, а не колбэк pty: непойманное отклонение здесь валит
      // процесс агента целиком, а не одну вкладку. Терминал при этом живой — вывод
      // отпускаем, иначе экран остался бы пустым до срока придержания.
      console.error(`[bridge] terminal handover failed for session ${opts.session}:`, err);
      // Та же проверка, что на успешном пути: у мёртвого терминала придержанным кускам
      // идти уже некуда.
      if (disposed) return;
      flush();
    });

  return {
    get mode(): TerminalMode | undefined {
      return link.mode;
    },
    write(b: Uint8Array): void {
      link.write(b);
    },
    resize(c: number, r: number): void {
      link.resize(c, r);
    },
    snapshot(lines?: number): Promise<Uint8Array> {
      return disposed ? Promise.resolve(EMPTY) : link.snapshot(lines);
    },
    pause(): void {
      link.pause();
    },
    resume(): void {
      link.resume();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearHold();
      link.dispose();
    },
  };
}

/** Нормализует входящее WS-сообщение к единому Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data as ArrayBuffer);
}

/** Строит обработчик терминальных WS для AgentServer.attachTerminalWs.
 *  Cookie и Origin уже проверены сервером до вызова обработчика.
 *  `attach` инжектируется в тестах (по умолчанию — реальный attachTerminal). */
export function wireTerminalWs(opts: {
  socketName?: string;
  attach?: typeof attachTerminal;
  ptyPool?: PtyPool;
  /** Настройка агента: способ подключения терминала (`config.terminalMode`). */
  configMode?: TerminalMode;
}): (ws: WebSocket, session: string) => void {
  const attach = opts.attach ?? attachTerminal;
  return (ws: WebSocket, session: string): void => {
    let handle: TerminalHandle | undefined;
    // Таймер слива буфера WS: жив, пока pty на паузе из-за backpressure.
    let drainTimer: ReturnType<typeof setInterval> | undefined;
    // Что клиент знает о терминале: способ подключения и альтернативный экран.
    let mode: TerminalMode | undefined;
    let altScreen = false;

    const send = (bytes: Uint8Array): void => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(bytes, { binary: true });
      // Backpressure: медленный WS-потребитель + быстрый вывод pty (yes, cat bigfile)
      // раздувают буфер до OOM. При переполнении — пауза pty и опрос до слива.
      if (ws.bufferedAmount > WS_HIGH_WATER && handle && !drainTimer) {
        handle.pause();
        drainTimer = setInterval((): void => {
          if (ws.bufferedAmount < WS_LOW_WATER || ws.readyState !== ws.OPEN) {
            clearInterval(drainTimer);
            drainTimer = undefined;
            handle?.resume();
          }
        }, WS_DRAIN_INTERVAL_MS);
      }
    };

    /** Кадр состояния терминала. Клиент старой версии его не знает и пропускает. */
    const sendState = (): void => send(jsonFrame(FrameType.TerminalState, LAN_CHANNEL, { mode, altScreen }));

    ws.on('message', (data: RawData, isBinary: boolean): void => {
      if (!isBinary) return; // текстовые фреймы протоколом не используются — явный отказ
      let frame;
      try {
        frame = decodeFrame(new Uint8Array(toBuffer(data)));
      } catch {
        return; // битый фрейм — игнорируем
      }
      if (frame.type === FrameType.Resize) {
        let dims: { cols: number; rows: number; mode?: string };
        try {
          dims = frameJson<{ cols: number; rows: number; mode?: string }>(frame);
        } catch {
          return;
        }
        if (handle) {
          handle.resize(dims.cols, dims.rows);
          return;
        }
        // Первое сообщение (RESIZE) даёт размеры и просьбу о способе подключения —
        // только тут открывается терминал. Открытие может бросить синхронно (например,
        // бинарь tmux отсутствует) — ловим, чтобы не уронить процесс непойманным
        // исключением в обработчике WS-message, и закрываем соединение кодом 1011.
        try {
          handle = attach({
            session,
            socketName: opts.socketName,
            cols: dims.cols,
            rows: dims.rows,
            configMode: opts.configMode,
            // Та же проверка, что у relay в doOpen: чужой JSON не обязан класть сюда строку.
            requestedMode: typeof dims.mode === 'string' ? dims.mode : undefined,
            onData: (b) => send(encodeFrame({ type: FrameType.Data, channel: LAN_CHANNEL, payload: b })),
            onBell: (s) => send(jsonFrame(FrameType.Bell, LAN_CHANNEL, { session: s })),
            onMode: (m) => {
              mode = m;
              sendState();
            },
            onAltScreen: (active) => {
              altScreen = active;
              sendState();
            },
            onExit: () => {
              send(jsonFrame(FrameType.Close, LAN_CHANNEL, { session }));
              if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000);
            },
            ptyPool: opts.ptyPool ?? defaultPtyPool,
          });
        } catch (err) {
          console.error(`[bridge] attach failed for session ${session}:`, err);
          send(
            jsonFrame(FrameType.Error, LAN_CHANNEL, {
              code: err instanceof PtyUnavailableError ? 'pty-unavailable' : 'terminal-attach-failed',
              message:
                err instanceof PtyUnavailableError
                  ? 'Too many terminal connections are open. Close unused terminal tabs and try again.'
                  : 'Could not create a pseudo-terminal. Restart the TermHub agent if the problem persists.',
            }),
          );
          if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1011);
        }
      } else if (frame.type === FrameType.Data) {
        // DATA до первого RESIZE (терминала ещё нет) — игнорируем.
        if (handle) handle.write(frame.payload);
      }
    });

    const cleanup = (): void => {
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = undefined;
      }
      handle?.dispose();
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  };
}
