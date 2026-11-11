import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnPty } from '../src/pty-spawn.js';
import { open, type Link, type SessionLinkOptions, parsePaneState, renderScreen, renderSnapshot } from '../src/session-link.js';
import { PtyPool } from '../src/pty-pool.js';

// Шов pty мокаем целиком, как в bridge.unit.test.ts: настоящий tmux здесь
// не запускается, весь control-поток подаётся руками.
vi.mock('../src/pty-spawn.js', () => ({ spawnPty: vi.fn() }));

const mockSpawn = vi.mocked(spawnPty);
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Управляемый фейк IPty: копит команды, отданные клиенту, и эмитит поток. */
function makeFakePty() {
  let dataCb: ((chunk: Buffer) => void) | undefined;
  let exitCb: (() => void) | undefined;
  const writes: string[] = [];
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
    write: (data: unknown) => {
      writes.push(String(data));
    },
    resize: (c: number, r: number) => {
      writes.push(`<resize ${c}x${r}>`);
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
    /** Кусок потока от tmux (текстом — control mode строчный). */
    feed: (text: string) => dataCb?.(Buffer.from(text, 'utf8')),
    emitExit: () => exitCb?.(),
    writes,
    /** Команды без служебного перевода строки — так их читать глазами. */
    commands: () => writes.map((w) => w.replace(/\n$/, '')),
    isDestroyed: () => destroyed,
    pausedCount: () => paused,
    resumedCount: () => resumed,
  };
}

type Fake = ReturnType<typeof makeFakePty>;

/** Очередь исходов spawn по порядку: фейковый pty или отказ. Вызов сверх списка —
 *  падение, иначе лишний спавн тихо переиспользовал бы последний фейк. */
function stubSpawns(...steps: Array<Fake | Error>): void {
  let n = 0;
  mockSpawn.mockImplementation(((): unknown => {
    const step = steps[n];
    n += 1;
    if (step === undefined) throw new Error(`лишний spawn №${n}: подменщик его не ждал`);
    if (step instanceof Error) throw step;
    return step.pty;
  }) as never);
}

const noop = (): void => {};

/** Даёт отработать микрозадачам модуля: команда уходит не в том же такте, что вызов. */
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Опции по умолчанию: вывод и выход перехватываются вызывающим тестом. */
function options(over: Partial<SessionLinkOptions> = {}): SessionLinkOptions {
  return { cols: 80, rows: 24, onData: noop, onExit: noop, log: noop, ...over };
}

// Флаг у приветствия ноль, у ответов на наши команды — единица: так отвечает живой tmux.
const GREETING = '%begin 1 0 0\n%end 1 0 0\n';

/** Ответ на команду: номер должен совпадать с порядком отправки (tmux отвечает по очереди). */
function reply(id: number, ...lines: string[]): string {
  const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  return `%begin 1 ${id} 1\n${body}%end 1 ${id} 1\n`;
}

/** Приводит control-клиента к готовности: приветствие, затем ответы на init-команды. */
async function bringUp(fake: Fake, link: Link, pane = '%0', window = '@0', alt = '0'): Promise<void> {
  fake.feed(GREETING);
  fake.feed(reply(1)); // refresh-client
  fake.feed(reply(2, `${pane} ${window} ${alt}`)); // display-message
  await link.ready;
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe('open: выбор режима', () => {
  it('спавнит control-клиента tmux -CC attach и после приветствия работает в режиме control', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options({ socketName: 'sock1' }));
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toBe('tmux');
    expect(mockSpawn.mock.calls[0][1]).toEqual(['-L', 'sock1', '-CC', 'attach', '-t', '=sess:']);
    expect(link.mode).toBeUndefined(); // решение ещё не принято: протокол не отвечал
    await bringUp(fake, link);
    expect(link.mode).toBe('control');
  });

  it('тишина дольше двух секунд → откат на tmux attach, причина уходит в лог', async () => {
    vi.useFakeTimers();
    try {
      const control = makeFakePty();
      const attach = makeFakePty();
      stubSpawns(control, attach);
      const lines: string[] = [];
      const link = open('sess', options({ log: (m) => lines.push(m) }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(await link.ready).toBe('attach');
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mockSpawn.mock.calls[1][1]).toEqual(['attach', '-t', '=sess:']);
      expect(control.isDestroyed()).toBe(true); // control-клиент погашен, а не брошен
      expect(lines.join('\n')).toContain('control mode unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('уведомления продлевают срок готовности: сборка без непрошеного блока не уходит в откат', async () => {
    vi.useFakeTimers();
    try {
      const control = makeFakePty();
      const attach = makeFakePty();
      stubSpawns(control, attach);
      const lines: string[] = [];
      const link = open('sess', options({ log: (m) => lines.push(m) }));
      // Такая сборка tmux отвечает на -CC attach только уведомлениями: протокол живой,
      // а непрошеного блока, после которого можно слать команды, всё нет.
      await vi.advanceTimersByTimeAsync(1500);
      control.feed('%window-add @1\n');
      control.feed('%window-renamed @1 work\n');
      await vi.advanceTimersByTimeAsync(1500); // три секунды: прежний срок уже истёк бы
      expect(link.mode).toBeUndefined(); // отката не было
      expect(mockSpawn).toHaveBeenCalledTimes(1); // attach-клиент не спавнился
      // Ожидание видно в логе, но ровно одной строкой: по строке на уведомление залило бы лог.
      expect(lines.filter((m) => m.includes('waiting for the first block'))).toHaveLength(1);
      control.feed(GREETING); // блок наконец пришёл — дальше обычная готовность
      control.feed(reply(1));
      control.feed(reply(2, '%0 @0 0'));
      expect(await link.ready).toBe('control');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('продление не бесконечно: уведомления без единого блока упираются в общий предел', async () => {
    vi.useFakeTimers();
    try {
      const control = makeFakePty();
      const attach = makeFakePty();
      stubSpawns(control, attach);
      const link = open('sess', options());
      const notify = async (seconds: number): Promise<void> => {
        for (let i = 0; i < seconds; i++) {
          control.feed('%window-add @1\n');
          await vi.advanceTimersByTimeAsync(1000);
        }
      };
      await notify(5);
      expect(link.mode).toBeUndefined(); // пять секунд живого протокола — ещё ждём номер
      await notify(7);
      // Предел ожидания исчерпан: клиент, который шлёт уведомления и не даёт номера,
      // от мёртвого неотличим, и терминал должен открыться прежним способом.
      expect(await link.ready).toBe('attach');
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('%error в потоке до готовности → откат на tmux attach, не дожидаясь таймаута', async () => {
    // Таймеры поддельные и не сдвигаются: откат обязан случиться из-за %error,
    // иначе ready не разрешится и тест упадёт по своему таймауту.
    vi.useFakeTimers();
    try {
      const control = makeFakePty();
      const attach = makeFakePty();
      stubSpawns(control, attach);
      const link = open('sess', options());
      control.feed('%begin 1 0 1\nno server running\n%error 1 0 1\n');
      expect(await link.ready).toBe('attach');
      expect(mockSpawn.mock.calls[1][1]).toEqual(['attach', '-t', '=sess:']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('смерть control-клиента до готовности → откат, а не смерть терминала', async () => {
    // Таймеры поддельные и не сдвигаются: откат обязан случиться из-за выхода клиента,
    // а не по двухсекундному сроку готовности.
    vi.useFakeTimers();
    try {
      const control = makeFakePty();
      const attach = makeFakePty();
      stubSpawns(control, attach);
      let exits = 0;
      const link = open('sess', options({ onExit: () => (exits += 1) }));
      control.emitExit();
      expect(await link.ready).toBe('attach');
      expect(exits).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('если и tmux attach не поднялся, слот пула возвращается и приходит сигнал выхода', async () => {
    vi.useFakeTimers();
    try {
      const pool = new PtyPool(1);
      const control = makeFakePty();
      const next = makeFakePty();
      stubSpawns(control, new Error('spawn tmux ENOENT'), next);
      let exits = 0;
      const lines: string[] = [];
      const link = open('sess', options({ ptyPool: pool, onExit: () => (exits += 1), log: (m) => lines.push(m) }));
      control.emitExit();
      expect(await link.ready).toBe('attach');
      expect(exits).toBe(1);
      expect(lines.join('\n')).toContain('tmux attach failed');
      expect(() => open('next', options({ ptyPool: pool }))).not.toThrow(); // слот вернулся
    } finally {
      vi.useRealTimers();
    }
  });

  it('после отката по %error в attach-клиента не уходит ни одного служебного байта', async () => {
    vi.useFakeTimers();
    try {
      const control = makeFakePty();
      const attach = makeFakePty();
      stubSpawns(control, attach);
      const link = open('sess', options());
      control.feed('%begin 1 0 1\nno server running\n%error 1 0 1\n');
      expect(await link.ready).toBe('attach');
      // stdin attach-клиента — это клавиатура пользователя: текст служебной команды
      // выглядел бы в его сессии как случайно набранная строка.
      expect(attach.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('после отката по забракованному разборщиком блоку attach-клиент тоже чист', async () => {
    vi.useFakeTimers();
    try {
      const control = makeFakePty();
      const attach = makeFakePty();
      stubSpawns(control, attach);
      const link = open('sess', options());
      // Разборщик бракует блок сам: строка тела длиннее его предела приходит событием
      // error с номером блока, которого никто не ждёт.
      control.feed('%begin 1 0 1\n');
      control.feed('x'.repeat((1 << 20) + 1));
      expect(await link.ready).toBe('attach');
      expect(attach.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('откат не тратит второй слот пула: слот занят один и возвращается один раз', async () => {
    const pool = new PtyPool(1);
    const control = makeFakePty();
    const attach = makeFakePty();
    const next = makeFakePty();
    stubSpawns(control, attach, next);
    const link = open('sess', options({ ptyPool: pool }));
    control.feed('%begin 1 0 1\nno server running\n%error 1 0 1\n');
    expect(await link.ready).toBe('attach');
    expect(() => open('two', options({ ptyPool: pool }))).toThrow(); // слот всё ещё у этого Link
    link.dispose();
    expect(() => open('two', options({ ptyPool: pool }))).not.toThrow();
  });

  it('настройка агента attach запрещает control mode: клиент -CC не спавнится и просьба клиента не перебивает', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options({ configMode: 'attach', requestedMode: 'control' }));
    expect(link.mode).toBe('attach');
    expect(await link.ready).toBe('attach');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][1]).toEqual(['attach', '-t', '=sess:']);
  });

  it('просьба клиента attach выполняется без проверки готовности', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options({ requestedMode: 'attach' }));
    expect(await link.ready).toBe('attach');
    expect(mockSpawn.mock.calls[0][1]).toEqual(['attach', '-t', '=sess:']);
  });

  it('незнакомое значение режима от клиента игнорируется — берётся control', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options({ requestedMode: 'turbo' }));
    await bringUp(fake, link);
    expect(link.mode).toBe('control');
  });

  it('решение принято один раз: %error после готовности не меняет режим и не рвёт терминал', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    let exits = 0;
    const link = open('sess', options({ onExit: () => (exits += 1) }));
    await bringUp(fake, link);
    fake.feed('%begin 1 3 1\nno such window\n%error 1 3 1\n');
    expect(link.mode).toBe('control');
    expect(exits).toBe(0);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

describe('сопоставление ответов', () => {
  it('номера блоков идут с разрывом, как у живого tmux: адресует порядок отправки', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    // Ровно то, что увидел живой шов на tmux 3.7b: приветствие 308, а ответ на первую нашу
    // команду — уже 313. Промежуточные номера tmux потратил сам, предсказать их нельзя.
    fake.feed('%begin 1 308 0\n%end 1 308 0\n');
    fake.feed('%begin 1 313 1\n%end 1 313 1\n'); // refresh-client
    fake.feed('%begin 1 314 1\n%0 @0 0\n%end 1 314 1\n'); // display-message
    expect(await link.ready).toBe('control');
  });

  it('блок, которого никто не ждёт, очередь не двигает: ждущая команда получает свой ответ', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const chunks: string[] = [];
    const link = open('sess', options({ onData: (b) => chunks.push(dec.decode(b)) }));
    await bringUp(fake, link, '%0');
    // Очередь пуста: адресата у этого блока нет, и «съесть» им будущий ответ нельзя.
    fake.feed(reply(50, 'nobody asked for this'));
    const pending = link.snapshot();
    await tick();
    fake.feed(reply(51, 'screen'));
    fake.feed(reply(52)); // запрос состояния панели: пусто — снимок как есть
    expect(dec.decode(await pending)).toBe('screen');
    expect(link.mode).toBe('control'); // терминал жив: чужой блок — не повод для отката
  });

  it('%session-changed до первого блока не гонит команды вслепую: они ждут приветствия', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    fake.feed('%session-changed $0 work\n');
    // Приветственный блок ещё впереди: отправленной сейчас команде он достался бы ответом.
    expect(fake.commands()).toEqual([]);
    fake.feed(GREETING);
    fake.feed(reply(1));
    fake.feed(reply(2, '%0 @0 0'));
    expect(await link.ready).toBe('control');
  });

  it('команда без ответа отказывает по сроку, а не ждёт вечно', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakePty();
      stubSpawns(fake);
      const link = open('sess', options());
      fake.feed(GREETING);
      fake.feed(reply(1));
      fake.feed(reply(2, '%0 @0 0'));
      expect(await link.ready).toBe('control');
      const pending = link.snapshot(); // ответа на capture-pane не будет вовсе
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual(new Uint8Array(0));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('активная панель', () => {
  it('спрашивает панель, окно и alt-screen одной командой display-message', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    await bringUp(fake, link);
    expect(fake.commands()).toContain(
      'display-message -p "#{pane_id} #{window_id} #{alternate_on} #{pane_width} #{pane_height}"',
    );
  });

  it('вывод активной панели доходит до onData, вывод соседней отбрасывается', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const chunks: string[] = [];
    const link = open('sess', options({ onData: (b) => chunks.push(dec.decode(b)) }));
    await bringUp(fake, link, '%0');
    fake.feed('%output %1 from the other pane\n%output %0 mine\n');
    expect(chunks).toEqual(['mine']);
  });

  it('смена активного окна переспрашивает панель: вывод новой доходит, вывод прежней — нет', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const chunks: string[] = [];
    const link = open('sess', options({ onData: (b) => chunks.push(dec.decode(b)) }));
    await bringUp(fake, link, '%0');
    fake.feed('%session-window-changed $0 @1\n');
    fake.feed(reply(3, '%2 @1 0')); // ответ на переспрос display-message
    await tick();
    // Панель сменилась — экран пересобирается по новой: её картинка, затем её вывод.
    expect(fake.commands().at(-2)).toBe('capture-pane -t %2 -p -e');
    fake.feed(reply(4, 'new pane'));
    fake.feed('%output %0 stale\n%output %2 fresh\n');
    fake.feed(reply(5));
    await tick();
    await tick();
    expect(chunks).toEqual(['\x1b[0m\x1b[r\x1b[H\x1b[2Jnew pane\x1b[0m', 'fresh']);
  });

  it('в режиме attach поток tmux уходит клиенту сырым, без разбора и фильтра', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const chunks: string[] = [];
    const link = open('sess', options({ requestedMode: 'attach', onData: (b) => chunks.push(dec.decode(b)) }));
    await link.ready;
    fake.feed('%output %9 not a control stream\n');
    expect(chunks).toEqual(['%output %9 not a control stream\n']);
  });
});

describe('ввод и размер', () => {
  it('ввод, набранный до готовности, уходит одной командой send-keys -H в порядке байтов', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    link.write(enc.encode('hi'));
    link.write(enc.encode(' \r'));
    await bringUp(fake, link, '%0');
    // 68 69 20 0d — «hi», пробел и возврат каретки, посчитано вручную.
    expect(fake.commands()).toContain('send-keys -t %0 -H 68 69 20 0d');
  });

  it('ввод, набранный пока команда в полёте, копится и уходит следующей пачкой', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    await bringUp(fake, link, '%0');
    link.write(enc.encode('a'));
    link.write(enc.encode('b'));
    link.write(enc.encode('c'));
    const sent = fake.commands().filter((c) => c.startsWith('send-keys'));
    expect(sent).toEqual(['send-keys -t %0 -H 61']); // первая пачка ушла сразу
    fake.feed(reply(3)); // tmux принял её
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.commands().filter((c) => c.startsWith('send-keys'))).toEqual([
      'send-keys -t %0 -H 61',
      'send-keys -t %0 -H 62 63',
    ]);
  });

  it('пустой ввод команды не порождает', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    await bringUp(fake, link, '%0');
    link.write(new Uint8Array(0));
    expect(fake.commands().some((c) => c.startsWith('send-keys'))).toBe(false);
  });

  it('в режиме attach ввод идёт прямо в pty, без send-keys', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options({ requestedMode: 'attach' }));
    await link.ready;
    link.write(enc.encode('ls\r'));
    expect(fake.writes).toEqual(['ls\r']);
  });

  it('размер уходит refresh-client -C WxH и зажимается границами 20–500 × 5–300', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    await bringUp(fake, link, '%0');
    expect(fake.commands()).toContain('refresh-client -C 80x24'); // размер при подключении
    link.resize(100, 30);
    link.resize(9999, 1);
    expect(fake.commands().filter((c) => c.startsWith('refresh-client'))).toEqual([
      'refresh-client -C 80x24',
      'refresh-client -C 100x30',
      'refresh-client -C 500x5',
    ]);
  });

  it('в режиме attach размер меняется у самого pty', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options({ requestedMode: 'attach' }));
    await link.ready;
    link.resize(120, 40);
    expect(fake.writes).toEqual(['<resize 120x40>']);
  });
});

describe('снимок экрана', () => {
  it('снимок берётся capture-pane через того же клиента и склеивается в строки экрана', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    await bringUp(fake, link, '%0');
    const pending = link.snapshot();
    await tick();
    expect(fake.commands()).toContain('capture-pane -t %0 -p -e -S -200');
    fake.feed(reply(3, 'line one', 'line two'));
    fake.feed(reply(4)); // состояние панели не названо — снимок как есть
    expect(dec.decode(await pending)).toBe('line one\r\nline two');
  });

  it('следом за снимком спрашивает состояние панели и ставит курсор относительно конца снимка', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    await bringUp(fake, link, '%0');
    const pending = link.snapshot();
    await tick();
    expect(fake.commands().at(-1)).toContain('display-message -p -t %0 "TH-STATE,#{cursor_x},#{cursor_y},');
    fake.feed(reply(3, 'history', 'row0', 'row1', 'row2'));
    // Курсор в столбце 5 строки 0 панели высотой 3; включены клавиши курсора и вставка в скобках.
    fake.feed(reply(4, 'TH-STATE,5,0,3,0,0,2,1,1,0,0,0,0,0,1,1,0'));
    expect(dec.decode(await pending)).toBe(
      'history\r\nrow0\r\nrow1\r\nrow2\x1b[0m\r\x1b[2A\x1b[5C\x1b[?1h\x1b[?2004h',
    );
  });

  it('полноэкранное приложение: клиент сам уходит в альтернативный экран, позиции абсолютные', () => {
    const state = parsePaneState('TH-STATE,7,2,6,1,1,4,0,0,0,1,0,0,1,,1,0');
    expect(state?.bracket_paste_flag).toBeUndefined(); // поле, которого старый tmux не знает
    expect(renderSnapshot(['a', 'b'], state)).toBe(
      '\x1b[?1049h\x1b[Ha\r\nb\x1b[0m\x1b[2;5r\x1b[3;8H\x1b[?1000h\x1b[?1006h\x1b[?25l',
    );
    expect(parsePaneState('pane is gone')).toBeUndefined();
    expect(renderSnapshot(['a'], undefined)).toBe('a');
  });

  it('вывод между концом снимка и ответом о состоянии не теряется: в снимок он уже не попал', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const chunks: string[] = [];
    const link = open('sess', options({ onData: (b) => chunks.push(dec.decode(b)) }));
    await bringUp(fake, link, '%0');
    const pending = link.snapshot();
    await tick();
    fake.feed(reply(3, 'screen'));
    fake.feed('%output %0 between\n');
    fake.feed(reply(4));
    await pending;
    expect(chunks).toEqual(['between']);
  });

  it('смена размера панели пересобирает экран: стирание, картинка, затем придержанный вывод', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const chunks: string[] = [];
    const link = open('sess', options({ onData: (b) => chunks.push(dec.decode(b)) }));
    fake.feed(GREETING);
    fake.feed(reply(1));
    fake.feed(reply(2, '%0 @0 0 80 24'));
    expect(await link.ready).toBe('control');
    fake.feed('%layout-change @0 b25d,60x10,0,0,0 b25d,60x10,0,0,0 *\n');
    await tick();
    fake.feed(reply(3, '%0 @0 0 60 10')); // новый размер → пересборка
    await tick();
    expect(fake.commands().at(-2)).toBe('capture-pane -t %0 -p -e'); // только видимый экран
    fake.feed('%output %0 inside\n'); // до конца снимка — уже внутри него
    fake.feed(reply(4, 'row0', 'row1'));
    fake.feed('%output %0 after\n'); // после снимка — придержан, пойдёт следом
    fake.feed(reply(5, 'TH-STATE,3,1,10,0,0,9,1,0,0,0,0,0,0,0,1,0'));
    await tick();
    await tick();
    // Режимы названы все и явно: переключения, пришедшие на время захвата, клиенту не шли.
    const modesOff = '\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?7h\x1b[4l\x1b[?25h';
    expect(chunks).toEqual([`\x1b[?1049l\x1b[0m\x1b[r\x1b[H\x1b[2Jrow0\r\nrow1\x1b[0m\x1b[2;4H${modesOff}`, 'after']);
    fake.feed('%output %0 live\n');
    expect(chunks.at(-1)).toBe('live');
  });

  it('resize забирает размер себе: switch-client на свою сессию, затем просьба о размере', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    await bringUp(fake, link, '%0');
    link.resize(120, 40);
    expect(fake.commands().slice(-2)).toEqual(['switch-client -t =sess:', 'refresh-client -C 120x40']);
  });

  it('пересборка возвращает курсор, спрятанный перед захватом и показанный во время него', () => {
    // cursor_flag=1: приложение уже показало курсор, но его `?25h` в картинку не попал.
    const state = parsePaneState('TH-STATE,0,0,10,0,0,9,1,0,0,0,0,0,0,1,1,0');
    const out = renderScreen(['x'], state);
    expect(out).toContain('\x1b[?25h');
    expect(out).toContain('\x1b[?2004h'); // вставка в скобках включена — названа тоже
    expect(out).not.toContain('\x1b[?25l');
  });

  it('поле состояния, которого этот tmux не знает, пересборка не трогает', () => {
    const state = parsePaneState('TH-STATE,0,0,10,0,0,9,,0,0,0,0,0,0,0,1,0'); // cursor_flag пуст
    const out = renderScreen(['x'], state);
    expect(out).not.toContain('\x1b[?25');
  });

  it('снимок для нового экрана называет только отличия от свежего терминала', () => {
    const plain = parsePaneState('TH-STATE,0,0,10,0,0,9,1,0,0,0,0,0,0,0,1,0');
    expect(renderSnapshot(['x'], plain)).toBe('x\x1b[0m\r\x1b[9A');
    const busy = parsePaneState('TH-STATE,0,0,10,0,0,9,0,1,0,1,0,0,1,1,0,0');
    expect(renderSnapshot(['x'], busy)).toBe('x\x1b[0m\r\x1b[9A\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?7l\x1b[?25l');
  });

  it('придержанный вывод переполнился: он уходит клиенту, а устаревшая картинка — нет', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const chunks: string[] = [];
    const link = open('sess', options({ onData: (b) => chunks.push(dec.decode(b)) }));
    fake.feed(GREETING);
    fake.feed(reply(1));
    fake.feed(reply(2, '%0 @0 0 80 24'));
    await link.ready;
    fake.feed('%layout-change @0 x x *\n');
    await tick();
    fake.feed(reply(3, '%0 @0 0 60 10'));
    await tick();
    fake.feed(reply(4, 'old0', 'old1')); // захват кончился, ответ о состоянии ещё в пути
    const big = 'a'.repeat(300_000);
    for (let i = 0; i < 4; i++) fake.feed(`%output %0 ${big}\n`); // больше мегабайта придержано
    expect(chunks.join('').length).toBe(4 * 300_000); // отпущено сразу, по порядку
    fake.feed(reply(5, 'TH-STATE,0,0,10,0,0,9,1,0,0,0,0,0,0,0,1,0'));
    await tick();
    await tick();
    expect(chunks.join('')).not.toContain('old0'); // стирать свежий вывод старой картинкой нельзя
    fake.feed('%output %0 live\n');
    expect(chunks.at(-1)).toBe('live');
  });

  it('второй размер во время пересборки не запускает её параллельно — только следом', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    fake.feed(GREETING);
    fake.feed(reply(1));
    fake.feed(reply(2, '%0 @0 0 80 24'));
    await link.ready;
    fake.feed('%layout-change @0 x x *\n');
    await tick();
    fake.feed(reply(3, '%0 @0 0 60 10')); // пересборка №1: команды 4 и 5
    await tick();
    fake.feed(reply(4, 'row'));
    const big = 'a'.repeat(400_000);
    for (let i = 0; i < 3; i++) fake.feed(`%output %0 ${big}\n`); // придержанное отпущено досрочно
    fake.feed('%layout-change @0 x x *\n'); // команда 6
    await tick();
    fake.feed(reply(5, 'TH-STATE,0,0,10,0,0,9,1,0,0,0,0,0,0,0,1,0'));
    const before = fake.commands().filter((c) => c.startsWith('capture-pane')).length;
    fake.feed(reply(6, '%0 @0 0 70 12')); // размер сменился, пока первая ещё не завершилась
    expect(fake.commands().filter((c) => c.startsWith('capture-pane')).length).toBe(before);
    await tick();
    await tick();
    expect(fake.commands().filter((c) => c.startsWith('capture-pane')).length).toBe(before + 1);
  });

  it('ответ, опоздавший к сроку команды, достаётся ей же — следующие ответы не сдвигаются', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakePty();
      stubSpawns(fake);
      const link = open('sess', options());
      fake.feed(GREETING);
      fake.feed(reply(1));
      fake.feed(reply(2, '%0 @0 0 80 24'));
      await vi.advanceTimersByTimeAsync(0);
      const first = link.snapshot(); // команды 3 (capture-pane) и 4 (состояние)
      await vi.advanceTimersByTimeAsync(10_000); // tmux молчал дольше срока
      expect(dec.decode(await first)).toBe(''); // снимок сдался пустым
      const second = link.snapshot(); // команды 5 и 6
      await vi.advanceTimersByTimeAsync(0);
      fake.feed(reply(3, 'late')); // опоздавший ответ на первый снимок
      fake.feed(reply(4, 'TH-STATE,0,0,24,0,0,23,1,0,0,0,0,0,0,0,1,0'));
      fake.feed(reply(5, 'fresh')); // ответ на второй
      fake.feed(reply(6, 'TH-STATE,0,0,24,0,0,23,1,0,0,0,0,0,0,0,1,0'));
      const text = dec.decode(await second);
      expect(text).toContain('fresh');
      expect(text).not.toContain('late');
    } finally {
      vi.useRealTimers();
    }
  });

  it('активной стала другая панель: экран пересобирается по ней, даже при том же размере', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const chunks: string[] = [];
    const link = open('sess', options({ onData: (b) => chunks.push(dec.decode(b)) }));
    fake.feed(GREETING);
    fake.feed(reply(1));
    fake.feed(reply(2, '%0 @0 0 80 24'));
    await link.ready;
    fake.feed('%window-pane-changed @0 %1\n');
    await tick();
    fake.feed(reply(3, '%1 @0 0 80 24'));
    await tick();
    expect(fake.commands().at(-2)).toBe('capture-pane -t %1 -p -e');
    fake.feed(reply(4, 'other pane'));
    fake.feed(reply(5, 'TH-STATE,0,0,24,0,0,23,1,0,0,0,0,0,0,0,1,0'));
    await tick();
    await tick();
    expect(chunks.join('')).toContain('\x1b[H\x1b[2Jother pane');
  });

  describe('заявка размера', () => {
    async function up(size = '80 24'): Promise<{ fake: Fake; link: Link }> {
      const fake = makeFakePty();
      stubSpawns(fake);
      const link = open('sess', options());
      fake.feed(GREETING);
      fake.feed(reply(1));
      fake.feed(reply(2, `%0 @0 0 ${size}`));
      await link.ready;
      return { fake, link };
    }
    const sent = (fake: Fake, from: number): string[] => fake.commands().slice(from);

    it('без заявки просьба только запоминается: switch-client не уходит', async () => {
      const { fake, link } = await up();
      const from = fake.commands().length;
      link.resize(120, 40, false);
      expect(sent(fake, from)).toEqual(['refresh-client -C 120x40']);
    });

    it('та же просьба без заявки второй раз tmux не шлётся', async () => {
      const { fake, link } = await up();
      link.resize(120, 40, false);
      const from = fake.commands().length;
      link.resize(120, 40, false);
      link.resize(120, 40, false);
      expect(sent(fake, from)).toEqual([]);
    });

    it('первая заявка уходит и при совпавшем размере панели: сведения о ней бывают устаревшими', async () => {
      const { fake, link } = await up('80 24');
      const from = fake.commands().length;
      link.resize(80, 24, true); // совпадает с просьбой при открытии и с известной панелью
      link.resize(80, 24, true); // повтор без смены размера панели — уже нет
      expect(sent(fake, from)).toEqual(['switch-client -t =sess:', 'refresh-client -C 80x24']);
    });

    it('панель под нас не встала: повторная заявка на ту же просьбу не уходит', async () => {
      const { fake, link } = await up('40 12'); // окно поделено: панель вдвое уже
      const from = fake.commands().length;
      link.resize(100, 30, true);
      link.resize(100, 30, true);
      link.resize(100, 30, true);
      expect(sent(fake, from)).toEqual(['switch-client -t =sess:', 'refresh-client -C 100x30']);
    });

    it('размер панели сменился после заявки (его забрал другой) — новая заявка уходит', async () => {
      const { fake, link } = await up('40 12');
      link.resize(100, 30, true);
      fake.feed(reply(3)); // switch-client
      fake.feed(reply(4)); // refresh-client
      fake.feed('%layout-change @0 x x *\n'); // команда 5: переспрос панели
      await tick();
      fake.feed(reply(5, '%0 @0 0 50 15'));
      await tick();
      const from = fake.commands().length;
      link.resize(100, 30, true);
      expect(sent(fake, from)).toEqual(['switch-client -t =sess:', 'refresh-client -C 100x30']);
    });

    it('после своей заявки экран пересобирается, даже если размер панели для нас не менялся', async () => {
      // Окно забирал другой клиент, но ответ о размере до нас не дошёл: было 80×24 и стало 80×24.
      const { fake, link } = await up('80 24');
      link.resize(80, 24, true);
      fake.feed(reply(3)); // switch-client
      fake.feed(reply(4)); // refresh-client → панель спрашиваем сами
      await tick();
      expect(fake.commands().at(-1)).toContain('display-message -p "#{pane_id}');
      fake.feed(reply(5, '%0 @0 0 80 24'));
      await tick();
      expect(fake.commands().at(-2)).toBe('capture-pane -t %0 -p -e');
    });

    it('без заявки пересборки на прежнем размере нет', async () => {
      const { fake, link } = await up('80 24');
      link.resize(90, 24, false);
      fake.feed(reply(3));
      fake.feed('%session-window-changed $0 @0\n'); // повод переспросить панель
      await tick();
      fake.feed(reply(4, '%0 @0 0 80 24'));
      await tick();
      expect(fake.commands().some((c) => c.startsWith('capture-pane'))).toBe(false);
    });

    it('по умолчанию заявка есть — так ведёт себя клиент, который поля не знает', async () => {
      const { fake, link } = await up();
      const from = fake.commands().length;
      link.resize(120, 40);
      expect(sent(fake, from)).toEqual(['switch-client -t =sess:', 'refresh-client -C 120x40']);
    });
  });

  it('размер панели сообщается при подключении и при смене раскладки окна', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const sizes: string[] = [];
    const link = open('sess', options({ onPaneSize: (c, r) => sizes.push(`${c}x${r}`) }));
    fake.feed(GREETING);
    fake.feed(reply(1));
    fake.feed(reply(2, '%0 @0 0 244 63'));
    expect(await link.ready).toBe('control');
    // Окно подогнали под другого клиента: размер переспрашивается.
    fake.feed('%layout-change @0 b25d,80x24,0,0,0 b25d,80x24,0,0,0 *\n');
    await tick();
    fake.feed(reply(3, '%0 @0 0 80 24'));
    fake.feed('%layout-change @0 b25d,80x24,0,0,0 b25d,80x24,0,0,0 *\n');
    await tick();
    fake.feed(reply(4, '%0 @0 0 80 24')); // тот же размер — повторно не сообщается
    await tick();
    expect(sizes).toEqual(['244x63', '80x24']);
  });

  it('глубину снимка задаёт вызывающий', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    await bringUp(fake, link, '%0');
    const pending = link.snapshot(50);
    await tick();
    expect(fake.commands()).toContain('capture-pane -t %0 -p -e -S -50');
    fake.feed(reply(3, 'x'));
    fake.feed(reply(4));
    await pending;
  });

  it('вывод, пришедший до конца ответа, не дублируется: он уже внутри снимка', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const chunks: string[] = [];
    const link = open('sess', options({ onData: (b) => chunks.push(dec.decode(b)) }));
    await bringUp(fake, link, '%0');
    const pending = link.snapshot();
    await tick();
    fake.feed('%output %0 inside the capture\n');
    fake.feed(reply(3, 'screen'));
    fake.feed(reply(4));
    await pending;
    fake.feed('%output %0 after\n');
    expect(chunks).toEqual(['after']);
  });

  it('вывод тем же куском сразу после конца снимка доходит до экрана', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const chunks: string[] = [];
    const link = open('sess', options({ onData: (b) => chunks.push(dec.decode(b)) }));
    await bringUp(fake, link, '%0');
    const pending = link.snapshot();
    await tick();
    // Один кусок чтения: конец снимка и следом живой вывод — он уже вне снимка.
    fake.feed(`${reply(3, 'screen')}%output %0 after\n`);
    fake.feed(reply(4));
    await pending;
    expect(chunks).toEqual(['after']);
  });

  it('отказ capture-pane оставляет терминал живым и отдаёт пустой снимок', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    await bringUp(fake, link, '%0');
    const pending = link.snapshot();
    await tick();
    fake.feed('%begin 1 3 1\nno such pane\n%error 1 3 1\n');
    expect(await pending).toEqual(new Uint8Array(0));
    expect(link.mode).toBe('control');
  });

  it('в режиме attach снимка нет: команд не появляется, приходит пусто', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options({ requestedMode: 'attach' }));
    expect(await link.snapshot()).toEqual(new Uint8Array(0));
    expect(fake.writes).toEqual([]);
  });
});

describe('жизненный цикл', () => {
  it('pause и resume останавливают и возобновляют чтение клиента', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    await bringUp(fake, link, '%0');
    link.pause();
    link.resume();
    expect(fake.pausedCount()).toBe(1);
    expect(fake.resumedCount()).toBe(1);
    link.dispose();
    link.pause();
    link.resume();
    expect(fake.pausedCount()).toBe(1); // мёртвому клиенту команд не шлём
  });

  it('dispose идемпотентен: клиент гасится один раз, ввод и размер после него — ничто', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    await bringUp(fake, link, '%0');
    const before = fake.commands().length;
    link.dispose();
    link.dispose();
    link.write(enc.encode('x'));
    link.resize(100, 30);
    expect(fake.isDestroyed()).toBe(true);
    expect(fake.commands().length).toBe(before);
  });

  it('dispose освобождает слот PtyPool, а исчерпанный пул отказывает синхронно', async () => {
    const pool = new PtyPool(1);
    const first = makeFakePty();
    const second = makeFakePty();
    stubSpawns(first, second);
    const one = open('one', options({ ptyPool: pool }));
    expect(() => open('two', options({ ptyPool: pool }))).toThrow();
    one.dispose();
    expect(() => open('two', options({ ptyPool: pool }))).not.toThrow();
    expect(mockSpawn).toHaveBeenCalledTimes(2); // отказ пула не доходит до forkpty
  });

  it('выход клиента после готовности объявляет терминал мёртвым и возвращает слот', async () => {
    const pool = new PtyPool(1);
    const fake = makeFakePty();
    const next = makeFakePty();
    stubSpawns(fake, next);
    let exits = 0;
    const link = open('sess', options({ ptyPool: pool, onExit: () => (exits += 1) }));
    await bringUp(fake, link, '%0');
    fake.emitExit();
    fake.emitExit();
    link.dispose();
    expect(exits).toBe(1);
    expect(fake.isDestroyed()).toBe(false); // вышедший клиент второй раз не убивают
    expect(() => open('next', options({ ptyPool: pool }))).not.toThrow();
  });
});

describe('альтернативный экран', () => {
  it('состояние известно при подключении: display-message с единицей даёт пометку', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const alt: boolean[] = [];
    const link = open('sess', options({ onAltScreen: (v) => alt.push(v) }));
    await bringUp(fake, link, '%0', '@0', '1');
    expect(alt).toEqual([true]);
  });

  it('вход и выход приложения из альтернативного экрана меняют пометку', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const alt: boolean[] = [];
    const link = open('sess', options({ onAltScreen: (v) => alt.push(v) }));
    await bringUp(fake, link, '%0', '@0', '0');
    fake.feed('%output %0 \\033[?1049h\n'); // vim вошёл в альтернативный экран
    fake.feed('%output %0 text\n'); // повторов пометки нет
    fake.feed('%output %0 \\033[?1049l\n'); // и вышел
    expect(alt).toEqual([false, true, false]);
  });

  it('последовательность, разорванная между кусками потока, всё равно узнаётся', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const alt: boolean[] = [];
    const link = open('sess', options({ onAltScreen: (v) => alt.push(v) }));
    await bringUp(fake, link, '%0', '@0', '0');
    fake.feed('%output %0 \\033[?10\n');
    fake.feed('%output %0 49h\n');
    expect(alt).toEqual([false, true]);
  });
});
