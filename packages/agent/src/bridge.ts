// Мост pty ↔ tmux attach ↔ WebSocket. attachTerminal — чистая функция без знания
// о WS: спавнит pty на `tmux attach`, отдаёт вывод байтами и сигналит о BEL/выходе.
// wireTerminalWs строит из неё обработчик терминальных WS для AgentServer.

import { execFile } from 'node:child_process';

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

/** Восстановление истории при (пере)подключении. `tmux attach` рисует только текущий
 *  экран — всё, что натекло, пока клиент был в оффлайне (частый мобильный паттерн:
 *  свернул надолго, вернулся к результату), остаётся лишь в scrollback tmux. Поэтому на
 *  attach дотягиваем последние RESTORE_LINES строк истории и перерисовываем клиент —
 *  чтобы виден был весь вывод без пропусков. Значение = scrollback xterm на клиенте
 *  (term.ts): тянуть больше бессмысленно — клиент столько не удержит; меньше — после
 *  RESET у клиента осталось бы истории меньше, чем он способен показать. tmux
 *  history-limit (50000) — верхняя граница того, что вообще доступно. */
const RESTORE_LINES = 20000;
const RESTORE_MAX_BUFFER = 32 * 1024 * 1024; // capture-pane 10k строк с ANSI — с запасом
/** Перед дампом истории: очистить scrollback (3J) + экран (2J) + курсор в home —
 *  иначе перерисовка легла бы поверх старого буфера (дубли/наложение). */
const RESET_SEQ = '\x1b[3J\x1b[2J\x1b[H';
/** Куски дампа истории: лимит WS-сообщения relay 16 МБ + плавность отдачи. */
const RESTORE_CHUNK = 256 * 1024;

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

/** Восстановление истории при подключении: тянет scrollback сессии и отдаёт «дамп»
 *  (RESET + строки) в done, либо done() без дампа. Инъектируется в тестах (по умолчанию —
 *  restoreScrollback), чтобы юниты не дёргали реальный tmux. */
export type RestoreFn = (
  socketName: string | undefined,
  session: string,
  done: (dump?: Buffer) => void,
) => void;

/** Тянет последние RESTORE_LINES строк scrollback tmux (с ANSI-цветом) и отдаёт их как
 *  «дамп» (RESET + история) для перерисовки клиента при подключении. На alt-screen
 *  (полноэкранный TUI: vim/less/…) истории нет — возвращает undefined (перерисовывать
 *  нечего, обычный attach сам покажет экран). execFile без shell (анти-RCE), сокет — тот
 *  же, что у attach. Любая ошибка не фатальна: тогда просто без дампа (штатный attach). */
export function restoreScrollback(
  socketName: string | undefined,
  session: string,
  done: (dump?: Buffer) => void,
): void {
  const sock = socketName ? ['-L', socketName] : [];
  // capture-pane/display-message — pane-команды: префикс «=» они НЕ парсят («can't find
  // pane»), поэтому цель — plain-имя сессии. Безопасно: имя валидируется как [\w-] (без
  // «:»/«.» — разделителей target у tmux), поэтому резолвится в активный пейн этой сессии.
  const target = session;
  // alt-screen? тогда scrollback неактуален — дамп пропускаем.
  execFile('tmux', [...sock, 'display-message', '-p', '-t', target, '#{alternate_on}'], { encoding: 'utf8' }, (err, altOut) => {
    if (err || String(altOut).trim() === '1') {
      done();
      return;
    }
    execFile(
      'tmux',
      [...sock, 'capture-pane', '-p', '-e', '-t', target, '-S', `-${RESTORE_LINES}`],
      { encoding: 'utf8', maxBuffer: RESTORE_MAX_BUFFER },
      (err2, capOut) => {
        const text = typeof capOut === 'string' ? capOut : '';
        if (err2 || !text) {
          done();
          return;
        }
        // capture-pane разделяет строки '\n'; xterm в raw-режиме без CR даёт «лесенку» —
        // переводим в CRLF. Хвостовые пустые строки убираем: живой attach-repaint дорисует
        // текущий экран поверх (абсолютное позиционирование), лишний перевод не нужен.
        const body = text.replace(/\n+$/, '').replace(/\n/g, '\r\n');
        done(Buffer.from(RESET_SEQ + body));
      },
    );
  });
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
  /** Восстановление истории при подключении. Не задан → вывод не придерживаем и историю
   *  не тянем (низкоуровневый режим). Прод-вызыватели передают restoreScrollback. */
  restore?: RestoreFn;
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

  // Восстановление истории при (пере)подключении: если задан restore — пока не отдан дамп
  // недавнего scrollback tmux, живой вывод pty (в т.ч. начальную перерисовку экрана от
  // `tmux attach`) копим в held и отдаём ПОСЛЕ дампа. Иначе RESET в начале дампа затёр бы
  // уже пришедшее (= потеря вывода после долгого оффлайна). Без restore — не придерживаем.
  const restore = opts.restore;
  let holding = restore !== undefined;
  const held: Buffer[] = [];

  // Скан на «звонок» с переносом состояния между чанками: BEL (0x07) считается
  // звонком, только если он НЕ терминатор OSC-последовательности. Shell ставит
  // заголовок окна `ESC ] 0 ; … BEL` на каждом приглашении — наивный indexOf(BEL)
  // сигналил бы звонком почти на каждую команду. Стейт-машина: `ESC ]` → inOsc;
  // в OSC байт BEL или `ESC \` (ST) завершает OSC (это НЕ звонок); BEL вне OSC →
  // настоящий звонок. inOsc/escPending живут вне scanBell — состояние тянется через
  // границу чанков (OSC может быть разорван между двумя onData).
  let inOsc = false;
  let escPending = false;
  const scanBell = (bytes: Buffer): boolean => {
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

  const emit = (bytes: Buffer): void => {
    if (disposed) return;
    if (scanBell(bytes)) opts.onBell(opts.session);
    opts.onData(bytes);
  };

  const onDataDisp = child.onData((chunk: string): void => {
    const bytes = chunk as unknown as Buffer;
    if (holding) {
      held.push(bytes); // до готовности дампа — копим (звонки из истории не эмитим)
      return;
    }
    emit(bytes);
  });

  // Снимает hold: отдаёт дамп истории (если есть), затем весь накопленный живой вывод.
  const release = (dump?: Buffer): void => {
    if (!holding) return;
    holding = false;
    if (!disposed && dump) {
      // Режем на куски (лимит WS-сообщения relay 16 МБ + плавность); порядок сохраняем.
      for (let i = 0; i < dump.length && !disposed; i += RESTORE_CHUNK) {
        opts.onData(dump.subarray(i, i + RESTORE_CHUNK));
      }
    }
    for (const b of held) emit(b); // emit сам проверит disposed
    held.length = 0;
  };

  // Тянем недавнюю историю tmux и снимаем hold. Ошибка/alt-screen → release() без дампа.
  if (restore) restore(opts.socketName, opts.session, release);

  const onExitDisp = child.onExit((): void => {
    if (disposed) return;
    disposed = true;
    release(); // выход до готовности дампа — снять hold, не подвесить held
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
  /** Восстановление истории (проброс в attachTerminal; в тестах — заглушка). */
  restore?: RestoreFn;
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
            restore: opts.restore ?? restoreScrollback,
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
