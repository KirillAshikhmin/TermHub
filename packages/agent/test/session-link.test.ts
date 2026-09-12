import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnPty } from '../src/pty-spawn.js';
import { open, type Link, type SessionLinkOptions } from '../src/session-link.js';
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

const GREETING = '%begin 1 0 1\n%end 1 0 1\n';

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
    expect(mockSpawn.mock.calls[0][1]).toEqual(['-L', 'sock1', '-CC', 'attach', '-t', '=sess']);
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
      expect(mockSpawn.mock.calls[1][1]).toEqual(['attach', '-t', '=sess']);
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
      // а номера, которым адресуется ответ, до первого блока взять неоткуда.
      await vi.advanceTimersByTimeAsync(1500);
      control.feed('%window-add @1\n');
      control.feed('%window-renamed @1 work\n');
      await vi.advanceTimersByTimeAsync(1500); // три секунды: прежний срок уже истёк бы
      expect(link.mode).toBeUndefined(); // отката не было
      expect(mockSpawn).toHaveBeenCalledTimes(1); // attach-клиент не спавнился
      // Ожидание видно в логе, но ровно одной строкой: по строке на уведомление залило бы лог.
      expect(lines.filter((m) => m.includes('waiting for the first block number'))).toHaveLength(1);
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
      expect(mockSpawn.mock.calls[1][1]).toEqual(['attach', '-t', '=sess']);
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
    expect(mockSpawn.mock.calls[0][1]).toEqual(['attach', '-t', '=sess']);
  });

  it('просьба клиента attach выполняется без проверки готовности', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options({ requestedMode: 'attach' }));
    expect(await link.ready).toBe('attach');
    expect(mockSpawn.mock.calls[0][1]).toEqual(['attach', '-t', '=sess']);
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
  it('блок с номером меньше ожидаемого не сдвигает очередь и не роняет режим', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    fake.feed(GREETING); // приветственный блок: после него уходят init-команды
    // Номер 0 уже был у приветствия: этот блок не принадлежит ни одной нашей команде.
    // Отдать ему ответ значило бы увести очередь на шаг, и разбор про активную панель
    // увидел бы чужую строку — ложный откат на живом tmux.
    fake.feed(reply(0, 'stray block'));
    fake.feed(reply(1)); // refresh-client
    fake.feed(reply(2, '%0 @0 0')); // display-message получает свой ответ, а не чужой
    expect(await link.ready).toBe('control');
  });

  it('блок с номером больше ожидаемого отвергает ждущую команду сразу, а не по сроку', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakePty();
      stubSpawns(fake);
      const link = open('sess', options());
      await bringUp(fake, link, '%0');
      const pending = link.snapshot(); // уходит командой с предсказанным номером 3
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.commands()).toContain('capture-pane -t %0 -p -e -S -200');
      // Предсказание разошлось: tmux уже отвечает пятым блоком, значит ответа на третью
      // команду не будет никогда. Время не сдвигается вовсе — срок команды тут не при чём.
      fake.feed(reply(5, 'answer to somebody else'));
      expect(await pending).toEqual(new Uint8Array(0));
      expect(link.mode).toBe('control'); // терминал жив: это отказ команды, а не протокола
    } finally {
      vi.useRealTimers();
    }
  });

  it('%session-changed до первого блока не гонит команды вслепую: они ждут номера', async () => {
    const fake = makeFakePty();
    stubSpawns(fake);
    const link = open('sess', options());
    fake.feed('%session-changed $0 work\n');
    expect(fake.commands()).toEqual([]); // номер следующего блока ещё неизвестен
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
    expect(fake.commands()).toContain('display-message -p "#{pane_id} #{window_id} #{alternate_on}"');
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
    await Promise.resolve();
    fake.feed('%output %0 stale\n%output %2 fresh\n');
    expect(chunks).toEqual(['fresh']);
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
    expect(dec.decode(await pending)).toBe('line one\r\nline two');
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
