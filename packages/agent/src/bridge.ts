// Мост pty ↔ tmux attach ↔ WebSocket. attachTerminal — чистая функция без знания
// о WS: спавнит pty на `tmux attach`, отдаёт вывод байтами и сигналит о BEL/выходе.
// wireTerminalWs строит из неё обработчик терминальных WS для AgentServer.

import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import type { WebSocket, RawData } from 'ws';
import { encodeFrame, jsonFrame, frameJson, decodeFrame, FrameType } from '@termhub/protocol';

/** Байт BEL: его появление в выводе pty → колокольчик. */
const BEL = 0x07;
/** В LAN один WS на терминал → мультиплексирования нет, channel всегда 0. */
const LAN_CHANNEL = 0;

/** Границы размера терминала: мусор с клиента не должен ронять pty. */
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 300;

/** Backpressure pty→WS: при переполнении буфера WS паузим pty, при сливе — возобновляем. */
const WS_HIGH_WATER = 1 << 20; // 1 MiB — порог паузы pty
const WS_LOW_WATER = 256 * 1024; // 256 KiB — порог возобновления
const WS_DRAIN_INTERVAL_MS = 50; // период опроса bufferedAmount при паузе

/** Управление живым pty поверх tmux-сессии. */
export interface TerminalHandle {
  write(b: Uint8Array): void;
  resize(c: number, r: number): void;
  /** Приостановить чтение из pty (backpressure: медленный WS-потребитель). */
  pause(): void;
  /** Возобновить чтение из pty после слива буфера WS. */
  resume(): void;
  dispose(): void;
}

/** Приводит size к целому в [min, max]; нечисловое/NaN → min. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/** Спавнит pty на `tmux attach` к сессии и связывает её вывод с колбэками.
 *  Знанием о WS не обладает — обвязку строит wireTerminalWs. */
export function attachTerminal(opts: {
  session: string;
  socketName?: string;
  cols: number;
  rows: number;
  onData: (b: Uint8Array) => void;
  onExit: () => void;
  onBell: (session: string) => void;
}): TerminalHandle {
  const args = [...(opts.socketName ? ['-L', opts.socketName] : []), 'attach', '-t', `=${opts.session}`];
  const child: IPty = spawn('tmux', args, {
    name: 'xterm-256color',
    cols: clamp(opts.cols, MIN_COLS, MAX_COLS),
    rows: clamp(opts.rows, MIN_ROWS, MAX_ROWS),
    // encoding:null → node-pty отдаёт сырые Buffer'ы (в d.ts тип — string): вывод
    // терминала бинарен, декодировать в строку нельзя (порвёт multibyte и BEL-скан).
    encoding: null,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  let disposed = false;

  // Скан на «звонок» с переносом состояния между чанками: BEL (0x07) считается
  // звонком, только если он НЕ терминатор OSC-последовательности. Shell ставит
  // заголовок окна `ESC ] 0 ; … BEL` на каждом приглашении — наивный indexOf(BEL)
  // сигналил бы звонком почти на каждую команду. Стейт-машина: `ESC ]` → inOsc;
  // в OSC байт BEL или `ESC \` (ST) завершает OSC (это НЕ звонок); BEL вне OSC →
  // настоящий звонок. inOsc/escPending живут вне onData — состояние тянется через
  // границу чанков (OSC может быть разорван между двумя onData).
  let inOsc = false;
  let escPending = false;

  const onDataDisp = child.onData((chunk: string): void => {
    const bytes = chunk as unknown as Buffer;
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
    if (bell) opts.onBell(opts.session);
    opts.onData(bytes);
  });

  const onExitDisp = child.onExit((): void => {
    if (disposed) return;
    disposed = true;
    onDataDisp.dispose();
    onExitDisp.dispose();
    opts.onExit();
  });

  return {
    write(b: Uint8Array): void {
      if (disposed) return;
      child.write(Buffer.from(b));
    },
    resize(c: number, r: number): void {
      if (disposed) return;
      child.resize(clamp(c, MIN_COLS, MAX_COLS), clamp(r, MIN_ROWS, MAX_ROWS));
    },
    pause(): void {
      if (disposed) return;
      child.pause();
    },
    resume(): void {
      if (disposed) return;
      child.resume();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      onDataDisp.dispose();
      onExitDisp.dispose();
      try {
        child.kill();
      } catch {
        // pty уже мёртв — идемпотентно
      }
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
}): (ws: WebSocket, session: string) => void {
  const attach = opts.attach ?? attachTerminal;
  return (ws: WebSocket, session: string): void => {
    let handle: TerminalHandle | undefined;
    // Таймер слива буфера WS: жив, пока pty на паузе из-за backpressure.
    let drainTimer: ReturnType<typeof setInterval> | undefined;

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

    ws.on('message', (data: RawData, isBinary: boolean): void => {
      if (!isBinary) return; // текстовые фреймы протоколом не используются — явный отказ
      let frame;
      try {
        frame = decodeFrame(new Uint8Array(toBuffer(data)));
      } catch {
        return; // битый фрейм — игнорируем
      }
      if (frame.type === FrameType.Resize) {
        let dims: { cols: number; rows: number };
        try {
          dims = frameJson<{ cols: number; rows: number }>(frame);
        } catch {
          return;
        }
        if (handle) {
          handle.resize(dims.cols, dims.rows);
          return;
        }
        // Первое сообщение (RESIZE) даёт размеры до attach — только тут спавним pty.
        // spawn может бросить синхронно (например, бинарь tmux отсутствует) — ловим,
        // чтобы не уронить процесс непойманным исключением в обработчике WS-message,
        // и закрываем соединение кодом 1011 (internal error).
        try {
          handle = attach({
            session,
            socketName: opts.socketName,
            cols: dims.cols,
            rows: dims.rows,
            onData: (b) => send(encodeFrame({ type: FrameType.Data, channel: LAN_CHANNEL, payload: b })),
            onBell: (s) => send(jsonFrame(FrameType.Bell, LAN_CHANNEL, { session: s })),
            onExit: () => {
              send(jsonFrame(FrameType.Close, LAN_CHANNEL, { session }));
              if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000);
            },
          });
        } catch (err) {
          console.error(`[bridge] attach failed for session ${session}:`, err);
          if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1011);
        }
      } else if (frame.type === FrameType.Data) {
        // DATA до первого RESIZE (pty ещё нет) — игнорируем.
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
