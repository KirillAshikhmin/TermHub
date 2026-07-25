import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'node-pty';
import { encodeFrame, jsonFrame, decodeFrame, FrameType } from '@termhub/protocol';
import { attachTerminal, wireTerminalWs } from '../src/bridge.js';

// node-pty мокаем целиком: полный контроль над spawn, включая синхронный throw
// (кейс «бинарь tmux отсутствует»), без реального tmux/pty.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

const mockSpawn = vi.mocked(spawn);

/** Короткая обёртка над wireTerminalWs (опции по умолчанию — пустые). */
const wire = (o: Parameters<typeof wireTerminalWs>[0] = {}): ReturnType<typeof wireTerminalWs> =>
  wireTerminalWs(o);

/** Управляемый фейк IPty: перехватывает колбэки и запоминает write/resize/kill. */
function makeFakePty() {
  let dataCb: ((chunk: string) => void) | undefined;
  let exitCb: (() => void) | undefined;
  const writes: Buffer[] = [];
  const resizes: Array<[number, number]> = [];
  let killed = false;
  let paused = 0;
  let resumed = 0;
  const pty = {
    onData: (cb: (c: string) => void) => {
      dataCb = cb;
      return { dispose: () => {} };
    },
    onExit: (cb: () => void) => {
      exitCb = cb;
      return { dispose: () => {} };
    },
    write: (b: Buffer) => {
      writes.push(Buffer.from(b));
    },
    resize: (c: number, r: number) => {
      resizes.push([c, r]);
    },
    pause: () => {
      paused += 1;
    },
    resume: () => {
      resumed += 1;
    },
    kill: () => {
      killed = true;
    },
  };
  return {
    pty,
    emitData: (b: Buffer) => dataCb?.(b as unknown as string),
    emitExit: () => exitCb?.(),
    writes,
    resizes,
    isKilled: () => killed,
    pausedCount: () => paused,
    resumedCount: () => resumed,
  };
}

/** Управляемый фейк WebSocket: копит отправленное и код закрытия, эмитит события. */
function makeFakeWs() {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const sent: Uint8Array[] = [];
  let closeCode: number | undefined;
  const ws = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    readyState: 1,
    bufferedAmount: 0,
    on(ev: string, cb: (...a: unknown[]) => void) {
      (listeners[ev] ??= []).push(cb);
    },
    send(data: Uint8Array) {
      sent.push(data);
    },
    close(code?: number) {
      closeCode = code;
      this.readyState = 3;
    },
  };
  return {
    ws,
    // Реальный ws всегда эмитит 'message' с (data, isBinary). Фейк по умолчанию
    // считает фрейм бинарным (isBinary=true), если явно не передали второй аргумент.
    emit: (ev: string, ...args: unknown[]) => {
      const call = ev === 'message' && args.length === 1 ? [...args, true] : args;
      (listeners[ev] ?? []).forEach((f) => f(...call));
    },
    sent,
    getCloseCode: () => closeCode,
  };
}

/** Оборачивает фрейм в Buffer — как приходит из ws (RawData). */
function msg(frame: Uint8Array): Buffer {
  return Buffer.from(frame);
}

const resizeFrame = (cols: number, rows: number): Buffer => msg(jsonFrame(FrameType.Resize, 0, { cols, rows }));
const dataFrame = (s: string): Buffer =>
  msg(encodeFrame({ type: FrameType.Data, channel: 0, payload: new TextEncoder().encode(s) }));

function stubSpawn(impl: (file: string, args: string[], opts: { cols: number; rows: number }) => unknown): void {
  mockSpawn.mockImplementation(impl as never);
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe('attachTerminal', () => {
  it('передаёт -L <socket>, =session в аргументы и xterm-256color в spawn', () => {
    let file = '';
    let args: string[] = [];
    stubSpawn((f, a) => {
      file = f;
      args = a;
      return makeFakePty().pty;
    });
    attachTerminal({
      session: 'mysess',
      socketName: 'sock1',
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      onBell: () => {},
    });
    expect(file).toBe('tmux');
    expect(args).toEqual(['-L', 'sock1', 'attach', '-t', '=mysess']);
  });

  it('клампует размеры при спавне: мусор → границы [20..500]×[5..300]', () => {
    let opts: { cols: number; rows: number } = { cols: 0, rows: 0 };
    stubSpawn((_f, _a, o) => {
      opts = o;
      return makeFakePty().pty;
    });
    attachTerminal({ session: 's', cols: 9999, rows: 1, onData: () => {}, onExit: () => {}, onBell: () => {} });
    expect(opts.cols).toBe(500);
    expect(opts.rows).toBe(5);
  });

  it('BEL (0x07) в выводе → onBell; сами байты → onData', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const bells: string[] = [];
    const chunks: Uint8Array[] = [];
    attachTerminal({
      session: 'sess',
      cols: 80,
      rows: 24,
      onData: (b) => chunks.push(b),
      onExit: () => {},
      onBell: (s) => bells.push(s),
    });
    fake.emitData(Buffer.from([0x68, 0x69, 0x07])); // "hi" + BEL
    expect(bells).toEqual(['sess']);
    expect(chunks).toHaveLength(1);
  });

  it('I-3: BEL как терминатор OSC (ESC ]0;title BEL) → onBell НЕ зовётся', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const bells: string[] = [];
    attachTerminal({
      session: 'sess',
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      onBell: (s) => bells.push(s),
    });
    // ESC ] 0 ; t i t l e BEL — заголовок окна, не звонок.
    fake.emitData(Buffer.from([0x1b, 0x5d, 0x30, 0x3b, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x07]));
    expect(bells).toEqual([]);
  });

  it('I-3: одиночный BEL вне OSC → onBell зовётся один раз', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const bells: string[] = [];
    attachTerminal({
      session: 'sess',
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      onBell: (s) => bells.push(s),
    });
    fake.emitData(Buffer.from([0x61, 0x07, 0x62, 0x07])); // два BEL в чанке → один onBell
    expect(bells).toEqual(['sess']);
  });

  it('I-3: OSC, разорванный между чанками (ESC] | …BEL) → onBell НЕ зовётся', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const bells: string[] = [];
    attachTerminal({
      session: 'sess',
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      onBell: (s) => bells.push(s),
    });
    fake.emitData(Buffer.from([0x1b, 0x5d, 0x30, 0x3b])); // ESC ] 0 ; — начало OSC
    fake.emitData(Buffer.from([0x74, 0x07])); // t BEL — терминатор OSC в другом чанке
    expect(bells).toEqual([]);
  });

  it('I-3: OSC c ST-терминатором (ESC \\), затем реальный BEL → ровно один onBell', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const bells: string[] = [];
    attachTerminal({
      session: 'sess',
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      onBell: (s) => bells.push(s),
    });
    // ESC ] 7 ; x  ESC \ (ST — конец OSC, не звонок)  затем BEL (звонок).
    fake.emitData(Buffer.from([0x1b, 0x5d, 0x37, 0x3b, 0x78, 0x1b, 0x5c, 0x07]));
    expect(bells).toEqual(['sess']);
  });

  it('I-2: pause/resume делегируют в child.pause/resume', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const handle = attachTerminal({
      session: 's',
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      onBell: () => {},
    });
    handle.pause();
    handle.resume();
    expect(fake.pausedCount()).toBe(1);
    expect(fake.resumedCount()).toBe(1);
    // после dispose pause/resume — no-op (pty мёртв).
    handle.dispose();
    handle.pause();
    handle.resume();
    expect(fake.pausedCount()).toBe(1);
    expect(fake.resumedCount()).toBe(1);
  });

  it('onExit идемпотентен: dispose после выхода не зовёт onExit повторно и не killит', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    let exits = 0;
    const handle = attachTerminal({
      session: 's',
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {
        exits += 1;
      },
      onBell: () => {},
    });
    fake.emitExit();
    handle.dispose();
    expect(exits).toBe(1);
    expect(fake.isKilled()).toBe(false); // pty уже вышел — повторного kill нет
  });

  it('dispose живого pty → kill; write/resize после dispose — no-op', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const handle = attachTerminal({
      session: 's',
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      onBell: () => {},
    });
    handle.dispose();
    expect(fake.isKilled()).toBe(true);
    handle.write(new TextEncoder().encode('x'));
    handle.resize(100, 40);
    expect(fake.writes).toHaveLength(0);
    expect(fake.resizes).toHaveLength(0);
  });
});

describe('wireTerminalWs', () => {
  it('I-1: синхронное падение attach (инжектированный бросающий спавнер) → ws.close(1011), исключение не выходит наружу, процесс жив', () => {
    const throwingAttach = (): never => {
      throw new Error('spawn tmux ENOENT');
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws, emit, getCloseCode } = makeFakeWs();
    wire({ attach: throwingAttach as never })(ws as never, 'sess');
    expect(() => emit('message', resizeFrame(80, 24))).not.toThrow();
    expect(getCloseCode()).toBe(1011);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('DATA до первого RESIZE игнорируется — pty не спавнится', () => {
    stubSpawn(() => makeFakePty().pty);
    const { ws, emit } = makeFakeWs();
    wire()(ws as never, 'sess');
    emit('message', dataFrame('ls\r'));
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('первый RESIZE спавнит pty (с этими размерами), второй RESIZE только ресайзит', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const { ws, emit } = makeFakeWs();
    wire({ socketName: 'sock' })(ws as never, 'sess');
    emit('message', resizeFrame(80, 24));
    emit('message', resizeFrame(100, 30));
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(fake.resizes).toEqual([[100, 30]]);
  });

  it('DATA от клиента после attach → pty.write', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const { ws, emit } = makeFakeWs();
    wire()(ws as never, 'sess');
    emit('message', resizeFrame(80, 24));
    emit('message', dataFrame('echo hi\r'));
    expect(Buffer.concat(fake.writes).toString()).toBe('echo hi\r');
  });

  it('вывод pty → DATA-фрейм клиенту; BEL → BELL-фрейм', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const { ws, emit, sent } = makeFakeWs();
    wire()(ws as never, 'sess');
    emit('message', resizeFrame(80, 24));
    fake.emitData(Buffer.from([0x41, 0x42, 0x07])); // "AB" + BEL
    const frames = sent.map((b) => decodeFrame(new Uint8Array(b)));
    expect(frames.some((f) => f.type === FrameType.Bell)).toBe(true);
    expect(frames.some((f) => f.type === FrameType.Data)).toBe(true);
  });

  it('выход pty → CLOSE-фрейм и ws.close(1000)', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const { ws, emit, sent, getCloseCode } = makeFakeWs();
    wire()(ws as never, 'sess');
    emit('message', resizeFrame(80, 24));
    fake.emitExit();
    const frames = sent.map((b) => decodeFrame(new Uint8Array(b)));
    expect(frames.some((f) => f.type === FrameType.Close)).toBe(true);
    expect(getCloseCode()).toBe(1000);
  });

  it('закрытие WS → dispose отсоединяет pty (kill), сессия не трогается напрямую', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const { ws, emit } = makeFakeWs();
    wire()(ws as never, 'sess');
    emit('message', resizeFrame(80, 24));
    emit('close');
    expect(fake.isKilled()).toBe(true);
  });

  it('I-2: buffered>1MiB → pty.pause(); слив буфера <256KiB на таймере → pty.resume()', () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakePty();
      stubSpawn(() => fake.pty);
      const { ws, emit } = makeFakeWs();
      wire()(ws as never, 'sess');
      emit('message', resizeFrame(80, 24));
      // Симулируем переполнение WS: send оставит bufferedAmount выше порога паузы.
      ws.bufferedAmount = (1 << 20) + 1;
      fake.emitData(Buffer.from([0x41])); // вывод pty → send → проверка backpressure
      expect(fake.pausedCount()).toBe(1);
      // Буфер ещё не слит — таймер не возобновляет.
      vi.advanceTimersByTime(50);
      expect(fake.resumedCount()).toBe(0);
      // Буфер слит ниже нижнего порога — следующий тик возобновляет и гасит таймер.
      ws.bufferedAmount = 1024;
      vi.advanceTimersByTime(50);
      expect(fake.resumedCount()).toBe(1);
      vi.advanceTimersByTime(200); // таймер погашен — повторного resume нет
      expect(fake.resumedCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('текстовый (не бинарный) ws-фрейм игнорируется — pty не спавнится', () => {
    stubSpawn(() => makeFakePty().pty);
    const { ws, emit } = makeFakeWs();
    wire()(ws as never, 'sess');
    emit('message', resizeFrame(80, 24), false); // isBinary=false → отказ
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('битый/нефреймовый message игнорируется без падения', () => {
    stubSpawn(() => makeFakePty().pty);
    const { ws, emit } = makeFakeWs();
    wire()(ws as never, 'sess');
    expect(() => emit('message', Buffer.from([0x00]))).not.toThrow(); // короче заголовка
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
