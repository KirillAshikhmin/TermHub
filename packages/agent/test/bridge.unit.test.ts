import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnPty } from '../src/pty-spawn.js';
import { encodeFrame, jsonFrame, decodeFrame, frameJson, FrameType } from '@termhub/protocol';
import { attachTerminal, wireTerminalWs } from '../src/bridge.js';
import { PtyPool } from '../src/pty-pool.js';

// Шов pty мокаем целиком: полный контроль над спавном, включая синхронный throw
// (кейс «бинарь tmux отсутствует»), без реального tmux/pty.
vi.mock('../src/pty-spawn.js', () => ({ spawnPty: vi.fn() }));

const mockSpawn = vi.mocked(spawnPty);

/** Короткая обёртка над wireTerminalWs (опции по умолчанию — пустые). */
const wire = (o: Parameters<typeof wireTerminalWs>[0] = {}): ReturnType<typeof wireTerminalWs> =>
  wireTerminalWs({ configMode: 'attach', ...o });

/** Управляемый фейк IPty: перехватывает колбэки и запоминает write/resize/destroy. */
function makeFakePty() {
  let dataCb: ((chunk: Buffer) => void) | undefined;
  let exitCb: (() => void) | undefined;
  const writes: Buffer[] = [];
  const resizes: Array<[number, number]> = [];
  let destroyed = false;
  let paused = 0;
  let resumed = 0;
  const pty = {
    onData: (cb: (c: Buffer) => void) => {
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
    destroy: () => {
      destroyed = true;
    },
  };
  return {
    pty,
    emitData: (b: Buffer) => dataCb?.(b as unknown as string),
    emitExit: () => exitCb?.(),
    writes,
    resizes,
    isDestroyed: () => destroyed,
    pausedCount: () => paused,
    resumedCount: () => resumed,
  };
}


/** Ответы фейкового control-клиента: блок с номером команды, как у tmux -CC. */
function blockFor(id: number, lines: string[] = []): Buffer {
  const body = lines.map((l) => `${l}\r\n`).join('');
  return Buffer.from(`%begin 1000 ${id} 1\r\n${body}%end 1000 ${id} 1\r\n`);
}

/** Последняя команда, отправленная в stdin control-клиента. */
function lastCommand(fake: ReturnType<typeof makeFakePty>): string {
  return Buffer.concat(fake.writes).toString().trim().split('\n').at(-1) ?? '';
}

/** Доводит control-клиента до готовности: приветственный блок → ответы на init-команды.
 *  Номера блоков идут подряд от 0, как их раздаёт tmux. */
async function handshake(fake: ReturnType<typeof makeFakePty>, pane = '%0', alt = '0'): Promise<void> {
  fake.emitData(blockFor(0)); // приветственный блок: от него известен номер следующего
  await vi.waitFor(() => expect(lastCommand(fake)).toContain('display-message'));
  fake.emitData(blockFor(1)); // refresh-client
  fake.emitData(blockFor(2, [`${pane} @0 ${alt}`])); // display-message
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

/** Прежние тесты описывают путь `tmux attach`: режим объявляется явно, утверждения —
 *  ровно те же. Control mode проверяется отдельным describe ниже. */
const attachOld = (o: Omit<Parameters<typeof attachTerminal>[0], 'configMode'>): ReturnType<typeof attachTerminal> =>
  attachTerminal({ configMode: 'attach', ...o });

describe('attachTerminal', () => {
  it('передаёт -L <socket>, =session: в аргументы и xterm-256color в spawn', () => {
    let file = '';
    let args: string[] = [];
    stubSpawn((f, a) => {
      file = f;
      args = a;
      return makeFakePty().pty;
    });
    attachOld({
      session: 'mysess',
      socketName: 'sock1',
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      onBell: () => {},
    });
    expect(file).toBe('tmux');
    expect(args).toEqual(['-L', 'sock1', 'attach', '-t', '=mysess:']);
  });

  it('клампует размеры при спавне: мусор → границы [20..500]×[5..300]', () => {
    let opts: { cols: number; rows: number } = { cols: 0, rows: 0 };
    stubSpawn((_f, _a, o) => {
      opts = o;
      return makeFakePty().pty;
    });
    attachOld({ session: 's', cols: 9999, rows: 1, onData: () => {}, onExit: () => {}, onBell: () => {} });
    expect(opts.cols).toBe(500);
    expect(opts.rows).toBe(5);
  });

  it('BEL (0x07) в выводе → onBell; сами байты → onData', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const bells: string[] = [];
    const chunks: Uint8Array[] = [];
    attachOld({
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
    attachOld({
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
    attachOld({
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
    attachOld({
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
    attachOld({
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
    const handle = attachOld({
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

  it('onExit идемпотентен: dispose после выхода не зовёт onExit повторно и не уничтожает pty', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    let exits = 0;
    const handle = attachOld({
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
    expect(fake.isDestroyed()).toBe(false); // pty уже вышел — повторного destroy нет
  });

  it('dispose живого pty закрывает master-FD через destroy; write/resize после dispose — no-op', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const handle = attachOld({
      session: 's',
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      onBell: () => {},
    });
    handle.dispose();
    // Одного SIGHUP мало: destroy() закрывает и master, без чего /dev/ptmx
    // остаётся открытым в агенте до самого его перезапуска.
    expect(fake.isDestroyed()).toBe(true);
    handle.write(new TextEncoder().encode('x'));
    handle.resize(100, 40);
    expect(fake.writes).toHaveLength(0);
    expect(fake.resizes).toHaveLength(0);
  });
});

describe('wireTerminalWs', () => {
  it('I-1: синхронное падение attach → финальный Error и ws.close(1011), без исключения из обработчика', () => {
    const throwingAttach = (): never => {
      throw new Error('spawn tmux ENOENT');
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws, emit, sent, getCloseCode } = makeFakeWs();
    wire({ attach: throwingAttach as never })(ws as never, 'sess');
    expect(() => emit('message', resizeFrame(80, 24))).not.toThrow();
    const error = sent.map((b) => decodeFrame(new Uint8Array(b))).find((f) => f.type === FrameType.Error);
    expect(error && frameJson<{ code: string }>(error).code).toBe('terminal-attach-failed');
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

  it('закрытие WS → dispose уничтожает pty, сессия не трогается напрямую', () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const { ws, emit } = makeFakeWs();
    wire()(ws as never, 'sess');
    emit('message', resizeFrame(80, 24));
    emit('close');
    expect(fake.isDestroyed()).toBe(true);
  });

  it('закрытие WS освобождает слот PTY для следующей вкладки сессии', () => {
    const pool = new PtyPool(1);
    const first = makeFakePty();
    const second = makeFakePty();
    stubSpawn(() => (mockSpawn.mock.calls.length === 1 ? first.pty : second.pty));

    const one = makeFakeWs();
    wire({ ptyPool: pool })(one.ws as never, 'one');
    one.emit('message', resizeFrame(80, 24));
    one.emit('close');

    const two = makeFakeWs();
    wire({ ptyPool: pool })(two.ws as never, 'two');
    two.emit('message', resizeFrame(80, 24));

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(second.isDestroyed()).toBe(false);
  });

  it('исчерпанный PTY-budget отклоняет новую вкладку Error-кадром без нового forkpty', () => {
    const pool = new PtyPool(1);
    const first = makeFakePty();
    stubSpawn(() => first.pty);

    const one = makeFakeWs();
    wire({ ptyPool: pool })(one.ws as never, 'one');
    one.emit('message', resizeFrame(80, 24));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const two = makeFakeWs();
    wire({ ptyPool: pool })(two.ws as never, 'two');
    two.emit('message', resizeFrame(80, 24));
    errSpy.mockRestore();

    const error = two.sent.map((b) => decodeFrame(new Uint8Array(b))).find((f) => f.type === FrameType.Error);
    expect(error && frameJson<{ code: string }>(error).code).toBe('pty-unavailable');
    expect(two.getCloseCode()).toBe(1011);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
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

describe('attachTerminal в control mode', () => {
  const base = {
    session: 'sess',
    cols: 80,
    rows: 24,
    onData: (): void => {},
    onExit: (): void => {},
    onBell: (): void => {},
  };

  it('по умолчанию открывает control-клиента: в аргументах -CC', () => {
    let args: string[] = [];
    stubSpawn((_f, a) => {
      args = a;
      return makeFakePty().pty;
    });
    attachTerminal({ ...base, socketName: 'sock1' });
    expect(args).toEqual(['-L', 'sock1', '-CC', 'attach', '-t', '=sess:']);
  });

  it('просьба клиента открывает прежний клиент; настройка агента и мусор в просьбе старше неё', () => {
    const args: string[][] = [];
    stubSpawn((_f, a) => {
      args.push(a);
      return makeFakePty().pty;
    });
    attachTerminal({ ...base, socketName: 'sock1', requestedMode: 'attach' });
    attachTerminal({ ...base, socketName: 'sock1', configMode: 'attach', requestedMode: 'control' });
    attachTerminal({ ...base, socketName: 'sock1', requestedMode: 'telnet' });
    expect(args[0]).toEqual(['-L', 'sock1', 'attach', '-t', '=sess:']);
    expect(args[1]).toEqual(['-L', 'sock1', 'attach', '-t', '=sess:']);
    expect(args[2]).toEqual(['-L', 'sock1', '-CC', 'attach', '-t', '=sess:']);
  });

  it('снимок экрана уходит клиенту раньше живого вывода, пришедшего до него', async () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const chunks: string[] = [];
    const dec = new TextDecoder();
    attachTerminal({ ...base, onData: (b) => chunks.push(dec.decode(b)) });
    await handshake(fake);
    // Вывод пришёл после готовности, но до ответа на capture-pane: на экране он должен
    // оказаться ПОСЛЕ снимка, поверх которого его и напечатали.
    fake.emitData(Buffer.from('%output %0 live\r\n'));
    await vi.waitFor(() => expect(lastCommand(fake)).toContain('capture-pane'));
    fake.emitData(blockFor(3, ['screen']));
    await vi.waitFor(() => expect(chunks.length).toBe(2));
    expect(chunks[0]).toBe('screen');
    expect(chunks[1]).toBe('live');
  });

  it('сообщает выбранный режим и смену альтернативного экрана', async () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const modes: string[] = [];
    const alts: boolean[] = [];
    attachTerminal({ ...base, onMode: (m) => modes.push(m), onAltScreen: (a) => alts.push(a) });
    await handshake(fake);
    await vi.waitFor(() => expect(modes).toEqual(['control']));
    expect(alts).toEqual([false]);
    // Приложение ушло в альтернативный экран: ESC[?1049h в выводе активной панели.
    fake.emitData(Buffer.from('%output %0 \\033[?1049h\r\n'));
    expect(alts).toEqual([false, true]);
  });

  it('BEL в живом выводе звонит: байты доезжают через разэкранирование', async () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const bells: string[] = [];
    const chunks: Uint8Array[] = [];
    attachTerminal({ ...base, onBell: (x) => bells.push(x), onData: (b) => chunks.push(b) });
    await handshake(fake);
    // tmux экранирует управляющие байты восьмерично: \007 — это BEL.
    fake.emitData(Buffer.from('%output %0 ding\\007\r\n'));
    expect(bells).toEqual(['sess']);
    await vi.waitFor(() => expect(lastCommand(fake)).toContain('capture-pane'));
    fake.emitData(blockFor(3, []));
    await vi.waitFor(() => expect(chunks.length).toBe(1));
    expect(Array.from(chunks[0])).toContain(0x07);
  });

  it('BEL из снимка не звонит: в истории он уже отзвонил', async () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const bells: string[] = [];
    const chunks: string[] = [];
    const dec = new TextDecoder();
    attachTerminal({ ...base, onBell: (x) => bells.push(x), onData: (b) => chunks.push(dec.decode(b)) });
    await handshake(fake);
    await vi.waitFor(() => expect(lastCommand(fake)).toContain('capture-pane'));
    fake.emitData(blockFor(3, ['bell\u0007 in history']));
    // Ждём именно доставки снимка в onData: до неё звонить было бы нечему.
    await vi.waitFor(() => expect(chunks).toEqual(['bell\u0007 in history']));
    expect(bells).toEqual([]);
  });

  it('придержано больше мегабайта — снимок отменяется, вывод уходит сразу', async () => {
    const fake = makeFakePty();
    stubSpawn(() => fake.pty);
    const chunks: string[] = [];
    const dec = new TextDecoder();
    attachTerminal({ ...base, onData: (b) => chunks.push(dec.decode(b)) });
    await handshake(fake);
    // Три куска по 400 КБ: предел придержания — мегабайт, и на третьем он пройден.
    const big = 'x'.repeat(400_000);
    for (let i = 0; i < 3; i += 1) fake.emitData(Buffer.from(`%output %0 ${big}\r\n`));
    expect(chunks.map((c) => c.length)).toEqual([400_000, 400_000, 400_000]);
    // Снимок пришёл, но экран уже перерисован этим выводом — на экран он не идёт.
    await vi.waitFor(() => expect(lastCommand(fake)).toContain('capture-pane'));
    fake.emitData(blockFor(3, ['screen']));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).not.toContain('screen');
  });

  it('молчащий capture-pane отпускает придержанный вывод по сроку, а не по сроку команды', async () => {
    vi.useFakeTimers();
    const handles: ReturnType<typeof attachTerminal>[] = [];
    try {
      const fake = makeFakePty();
      stubSpawn(() => fake.pty);
      const chunks: string[] = [];
      const dec = new TextDecoder();
      handles.push(attachTerminal({ ...base, onData: (b) => chunks.push(dec.decode(b)) }));
      fake.emitData(blockFor(0));
      fake.emitData(blockFor(1));
      fake.emitData(blockFor(2, ['%0 @0 0']));
      await Promise.resolve(); // разбор ответа про панель: режим выбран, снимок ещё не запрошен
      fake.emitData(Buffer.from('%output %0 live\r\n'));
      expect(chunks).toEqual([]);
      // tmux на capture-pane не отвечает: ждать его срок (10 с) — держать экран пустым.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await vi.advanceTimersByTimeAsync(3000);
      expect(chunks).toEqual(['live']);
      // Отмена снимка оставляет след: иначе пропажа истории экрана ничем не видна.
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join(' ')).toContain('snapshot skipped');
      warnSpy.mockRestore();
      // Отвечаем на зависшую команду: иначе dispose отвергнет её строкой в лог прогона.
      fake.emitData(blockFor(3, []));
      await Promise.resolve();
    } finally {
      for (const h of handles) h.dispose();
      vi.useRealTimers();
    }
  });
});

describe('wireTerminalWs и режим подключения', () => {
  /** Поддельный attach: запоминает опции открытия, чтобы дёргать их колбэки снаружи. */
  function captureAttach(): { opts: Parameters<typeof attachTerminal>[0]; attach: typeof attachTerminal } {
    const opts = {} as Parameters<typeof attachTerminal>[0];
    const attach = ((o: Parameters<typeof attachTerminal>[0]) => {
      Object.assign(opts, o);
      return { write: () => {}, resize: () => {}, pause: () => {}, resume: () => {}, dispose: () => {} };
    }) as typeof attachTerminal;
    return { opts, attach };
  }

  it('просьба режима из первого RESIZE и настройка агента доезжают до attach', () => {
    const { opts, attach } = captureAttach();
    const { ws, emit } = makeFakeWs();
    wireTerminalWs({ attach, configMode: 'control' })(ws as never, 'sess');
    emit('message', msg(jsonFrame(FrameType.Resize, 0, { cols: 80, rows: 24, mode: 'attach' })));
    expect(opts.requestedMode).toBe('attach');
    expect(opts.configMode).toBe('control');
  });

  it('нестроковая просьба режима отбрасывается так же, как на relay-пути', () => {
    const { opts, attach } = captureAttach();
    const { ws, emit } = makeFakeWs();
    wireTerminalWs({ attach })(ws as never, 'sess');
    emit('message', msg(jsonFrame(FrameType.Resize, 0, { cols: 80, rows: 24, mode: { evil: true } })));
    expect(opts.requestedMode).toBeUndefined();
  });

  it('режим и альтернативный экран уходят клиенту кадром состояния терминала', () => {
    const { opts, attach } = captureAttach();
    const { ws, emit, sent } = makeFakeWs();
    wireTerminalWs({ attach })(ws as never, 'sess');
    emit('message', resizeFrame(80, 24));
    opts.onMode!('control');
    opts.onAltScreen!(true);
    const states = sent
      .map((b) => decodeFrame(new Uint8Array(b)))
      .filter((f) => f.type === FrameType.TerminalState)
      .map((f) => frameJson<{ mode?: string; altScreen?: boolean }>(f));
    expect(states).toEqual([
      { mode: 'control', altScreen: false },
      { mode: 'control', altScreen: true },
    ]);
  });

  it('кадр незнакомого типа от клиента пропускается: pty не спавнится, исключения нет', () => {
    stubSpawn(() => makeFakePty().pty);
    const { ws, emit } = makeFakeWs();
    wire()(ws as never, 'sess');
    expect(() => emit('message', msg(jsonFrame(FrameType.TerminalState, 0, { mode: 'control' })))).not.toThrow();
    expect(() => emit('message', msg(jsonFrame(250 as FrameType, 0, { x: 1 })))).not.toThrow();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
