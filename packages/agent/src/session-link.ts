// Жизненный цикл control-клиента tmux (`tmux -CC attach`): выбор режима, активная
// панель, очередь команд и ввода, снимок экрана и откат на прежний `tmux attach`.
// Про разбор строк протокола модуль не знает — это control-protocol.ts.

import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { ControlParser, escapeInput, type ControlEvent } from './control-protocol.js';
import type { PtyPool, PtyLease } from './pty-pool.js';
import { clampCols, clampRows, destroyPty } from './pty-common.js';

/** Каким способом клиент подключён к сессии: новым control mode или прежним attach. */
export type TerminalMode = 'control' | 'attach';

export interface SessionLinkOptions {
  /** Имя tmux-сокета (`-L`); без него — сокет по умолчанию. */
  socketName?: string;
  cols: number;
  rows: number;
  /** Настройка агента: `attach` запрещает control mode целиком и клиентом не перебивается. */
  configMode?: TerminalMode;
  /** Просьба клиента из первого кадра RESIZE; незнакомое значение игнорируется. */
  requestedMode?: string;
  /** Байты активной панели (control mode) или сырой поток tmux (attach). */
  onData: (bytes: Uint8Array) => void;
  /** Клиент tmux завершился: терминал мёртв, слот пула уже освобождён. */
  onExit: () => void;
  /** Активная панель вошла в альтернативный экран или вышла из него (только control mode). */
  onAltScreen?: (active: boolean) => void;
  /** Общий budget живых терминалов; один Link держит ровно один слот. */
  ptyPool?: PtyPool;
  /** Причина отката и отказы команд; по умолчанию — console.warn. */
  log?: (message: string) => void;
}

export interface Link {
  /** Режим, выбранный при открытии; пока идёт проверка готовности — undefined. */
  readonly mode: TerminalMode | undefined;
  /** Выбранный режим. Решение принимается один раз и внутри живого Link не меняется;
   *  промис не отвергается никогда — мёртвый терминал виден по onExit. */
  readonly ready: Promise<TerminalMode>;
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Снимок экрана с историей: `capture-pane -p -e -S -<lines>`, строки склеены CRLF
   *  и готовы к записи в терминал. В режиме attach снимка нет — придёт пусто. */
  snapshot(lines?: number): Promise<Uint8Array>;
  pause(): void;
  resume(): void;
  dispose(): void;
}

/** Ждём доказательства, что control mode работает на этой машине, не дольше двух секунд. */
const READY_TIMEOUT_MS = 2000;

/** Предел ожидания готовности с начала подключения. Пока протокол отвечает уведомлениями,
 *  двухсекундный срок заводится заново: в сборке, которая не шлёт непрошеный блок, номер
 *  команды взять неоткуда, и откат на живом control mode был бы ложным. Продлевать
 *  бесконечно нельзя — поток уведомлений от клиента, который на команды уже не ответит,
 *  оставил бы пользователя без терминала навсегда. Предел взят равным сроку ответа на
 *  команду: дольше этого проект нигде не ждёт tmux. */
const READY_MAX_WAIT_MS = 10_000;

/** Глубина снимка по умолчанию: хватает, чтобы сразу было что листать (~18 КБ). */
const DEFAULT_SNAPSHOT_LINES = 200;
/** Глубже history-limit проекта просить нечего. */
const MAX_SNAPSHOT_LINES = 50_000;

/** Предельный срок ответа на команду: чтение бывает на паузе, а блок — брошенным,
 *  и тогда ждать нечего. Отказ лучше вечного ожидания у того, кто ждёт снимок. */
const COMMAND_TIMEOUT_MS = 10_000;

/** Одна команда отдаёт активную панель, её окно и признак альтернативного экрана. */
const PANE_QUERY = 'display-message -p "#{pane_id} #{window_id} #{alternate_on}"';

/** Уведомления, после которых активная панель могла смениться. */
const PANE_NOTIFICATIONS = new Set(['session-changed', 'session-window-changed', 'window-pane-changed']);

/** Вход в альтернативный экран — `ESC [ ? 1 0 4 9 h`, выход — тот же префикс и `l`. */
const ALT_PREFIX = [0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39];
const ALT_ENTER = 0x68;
const ALT_LEAVE = 0x6c;

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

/** Глубина снимка: чужое число не должно превращаться в запрос всей истории. */
function snapshotDepth(lines: number): number {
  if (!Number.isFinite(lines)) return DEFAULT_SNAPSHOT_LINES;
  return Math.max(1, Math.min(MAX_SNAPSHOT_LINES, Math.trunc(lines)));
}

/** Порядок решения из §4: настройка агента старше просьбы клиента, обе — старше проверки. */
function wantedMode(configMode: TerminalMode | undefined, requested: string | undefined): TerminalMode {
  if (configMode === 'attach') return 'attach';
  return requested === 'attach' ? 'attach' : 'control';
}

/** Ожидаемый ответ: адресуется номером блока, который tmux даст этой команде. */
interface Pending {
  id: number;
  /** Команда снимка: пока она в полёте, вывод панели на экран не идёт. */
  capture: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
}

class SessionLink implements Link {
  mode: TerminalMode | undefined;
  readonly ready: Promise<TerminalMode>;

  private readonly lease: PtyLease | undefined;
  private child: IPty;
  /** Поколение pty: колбэки мёртвого клиента (откат) не должны ничего делать. */
  private generation = 0;
  private parser = new ControlParser();
  /** Подписки на текущего клиента: снимаются вместе с ним. */
  private childDisposers: Array<{ dispose(): void }> = [];
  /** Команды, ждущие своего блока: каждая знает номер, по которому её узнают. */
  private readonly pending: Pending[] = [];
  /** Номер, который tmux даст следующему блоку. Пока он неизвестен, команду отправлять
   *  нельзя: её ответ будет не с чем сопоставить. */
  private nextBlockId: number | undefined;
  /** Init-команды отправлены: второй раз их слать некуда. */
  private initStarted = false;
  private resolveReady!: (mode: TerminalMode) => void;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  /** Крайний срок готовности: продление уведомлениями двигает ближний срок, но не этот.
   *  Часы монотонные: настенные двигает шаг NTP, а на ноутбуке и телефоне ещё и сон
   *  машины — бюджет ожидания оказался бы то съеденным целиком, то растянутым. */
  private readonly readyDeadline = performance.now() + READY_MAX_WAIT_MS;
  /** Строка про продление уже в логе: писать её на каждое уведомление — залить лог. */
  private readyExtendLogged = false;
  /** Протокол ответил хотя бы раз: только после этого имеет смысл слать команды. */
  private protocolSeen = false;
  private cols: number;
  private rows: number;
  private activePane: string | undefined;
  private altScreen = false;
  private altKnown = false;
  /** Сколько байт префикса alt-screen уже совпало: последовательность рвётся между кусками. */
  private altMatch = 0;
  /** Ввод, ещё не ушедший в tmux: до выбора режима и пока команда в полёте. */
  private inputQueue: Uint8Array[] = [];
  private sendInFlight = false;
  /** Сколько снимков в полёте: их вывод на экран не повторяется. */
  private captureDepth = 0;
  /** Откат уже случился: второго клиента attach не бывает. */
  private fellBack = false;
  private disposed = false;

  constructor(
    private readonly session: string,
    private readonly opts: SessionLinkOptions,
  ) {
    this.cols = clampCols(opts.cols);
    this.rows = clampRows(opts.rows);
    this.ready = new Promise<TerminalMode>((resolve) => {
      this.resolveReady = resolve;
    });
    const wanted = wantedMode(opts.configMode, opts.requestedMode);
    this.lease = opts.ptyPool?.acquire();
    try {
      this.child = this.spawnClient(wanted === 'control');
    } catch (err) {
      // Ни один клиент не поднялся: слот пула чужой работе нужнее, чем мёртвому Link.
      this.lease?.release();
      throw err;
    }
    if (wanted === 'attach') this.decide('attach');
    else this.armReady(READY_TIMEOUT_MS, 'no control output in 2s');
  }

  /** Заводит срок готовности заново: не дождались — откат с этой причиной. */
  private armReady(delay: number, reason: string): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout((): void => this.fallback(reason), delay);
  }

  /** Протокол отвечает, а номера блока всё нет: команду отправить не с чем, но и откатывать
   *  живой control mode не за что — срок готовности заводится заново, пока не упрётся в
   *  общий предел (READY_MAX_WAIT_MS от открытия). Незаведённый срок значит, что режим уже
   *  выбран или Link закрыт: там продлевать нечего. */
  private extendReady(): void {
    if (this.readyTimer === undefined || this.nextBlockId !== undefined) return;
    const left = this.readyDeadline - performance.now();
    if (left <= 0) return; // предел исчерпан: доживаем уже заведённый срок
    if (!this.readyExtendLogged) {
      // Одна строка на всё продление: снаружи ожидание номера блока иначе неотличимо
      // от зависшего терминала — пользователь до предела смотрит в пустой экран.
      this.readyExtendLogged = true;
      this.log(`session ${this.session}: control protocol answers, waiting for the first block number`);
    }
    this.armReady(Math.min(READY_TIMEOUT_MS, left), `no block number in ${READY_MAX_WAIT_MS} ms of notifications`);
  }

  /** Спавнит клиента tmux; аргументы — только массивом, без shell. */
  private spawnClient(control: boolean): IPty {
    const socket = this.opts.socketName ? ['-L', this.opts.socketName] : [];
    const args = [...socket, ...(control ? ['-CC'] : []), 'attach', '-t', `=${this.session}`];
    const child = spawn('tmux', args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      // encoding:null → сырые Buffer'ы: вывод терминала бинарен (в d.ts тип — string).
      encoding: null,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    const generation = this.generation;
    this.childDisposers = [
      child.onData((chunk: string): void => this.handleData(chunk as unknown as Buffer, generation)),
      child.onExit((): void => this.handleExit(generation)),
    ];
    return child;
  }

  /** Отписывается от текущего клиента и сдвигает поколение: опоздавшие колбэки
   *  (в том числе от уже мёртвого pty) больше ничего не значат. */
  private detachChild(): void {
    this.generation += 1;
    for (const disposer of this.childDisposers) disposer.dispose();
    this.childDisposers = [];
  }

  /** То же плюс гашение самого клиента — для живого pty. */
  private killChild(): void {
    this.detachChild();
    destroyPty(this.child);
  }

  private handleData(chunk: Buffer, generation: number): void {
    if (this.disposed || generation !== this.generation) return;
    if (this.mode === 'attach') {
      this.opts.onData(chunk);
      return;
    }
    for (const event of this.parser.parse(chunk)) this.handleEvent(event);
  }

  /** Режим уже выбран в пользу attach: control-логика для этого Link кончилась.
   *  Отдельный предикат, а не сравнение на месте: иначе проверка ниже читается
   *  компилятором как невозможная — он не знает, что разбор блока меняет режим. */
  private inAttachMode(): boolean {
    return this.mode === 'attach';
  }

  private handleEvent(event: ControlEvent): void {
    // Откат мог случиться посреди разбора куска: дальше в нём control-событий нет.
    if (this.disposed || this.inAttachMode()) return;
    switch (event.type) {
      // В control mode tmux отдаёт вывод всех панелей сессии: чужой на экране
      // выглядел бы как порча вывода.
      case 'output':
        if (event.pane !== this.activePane) return;
        this.scanAlt(event.data); // состояние экрана считается и по скрытому выводу
        if (this.captureDepth === 0) this.opts.onData(event.data);
        return;
      // Блок сопоставляется раньше, чем засчитывается готовность: приветственный
      // блок control mode приходит до наших команд и адресата в очереди не имеет.
      case 'block':
        this.matchBlock(event.id, event.lines, false);
        // Разбор блока мог кончиться откатом: у attach-клиента stdin — клавиатура
        // пользователя, и служебная команда появилась бы в его сессии набранной строкой.
        if (this.mode === 'attach') return;
        this.protocolReplied();
        return;
      case 'error':
        this.matchBlock(event.id, event.lines, true);
        if (this.mode === 'attach') return;
        this.protocolReplied();
        return;
      case 'notification':
        // Уведомление — доказательство, что control mode на этой машине работает. Номера
        // блока оно не даёт, поэтому одной готовностью не считается, но и срок ожидания
        // при живом протоколе истекать не должен.
        this.extendReady();
        if (event.name === 'session-changed') this.protocolReplied();
        // Переспрос идёт на каждое уведомление: ответ на прежний запрос мог уйти
        // до смены и вернуть панель, которой уже нет.
        if (this.mode === 'control' && PANE_NOTIFICATIONS.has(event.name)) this.queryPane(false);
        return;
    }
  }

  /** Ответ адресуется номером команды. Блок с номером меньше ожидаемого (приветственный или
   *  чужой) очередь не сдвигает: иначе следующий ответ достался бы не той команде, и
   *  разбор про активную панель увидел бы чужую строку — ложный откат на живом tmux.
   *  Номер больше ожидаемого, наоборот, очередь чистит: см. ниже. */
  private matchBlock(id: number, lines: string[], failed: boolean): void {
    // Счётчик блоков у control-клиента сквозной: неадресованный блок тоже занимает номер.
    if (this.nextBlockId === undefined || id >= this.nextBlockId) this.nextBlockId = id + 1;
    // Номер команды предсказан («последний виденный плюс один»), а отвечает tmux по
    // возрастанию номеров: блок с номером больше ожидаемого — доказательство, что
    // предсказание разошлось и своего ответа команда уже не дождётся. Отвергаем сразу:
    // иначе ждущий снимок висел бы до COMMAND_TIMEOUT_MS, показывая пустой экран.
    while (this.pending.length > 0 && this.pending[0].id < id) {
      const missed = this.pending.shift();
      if (missed) this.settle(missed, new Error(`command ${missed.id} overtaken by block ${id}`), []);
    }
    const head = this.pending[0];
    if (head === undefined || head.id !== id) {
      // Отказ, которого никто не ждал, до выбора режима — доказательство, что control
      // mode тут не работает; после выбора терминал остаётся живым.
      if (failed && this.mode === undefined) this.fallback(`control stream error: ${lines.join(' ')}`);
      return;
    }
    this.pending.shift();
    this.settle(head, failed ? new Error(lines.join(' ')) : undefined, lines);
  }

  /** Снимает команду с очереди. Глушение вывода отпускается здесь, в момент разбора
   *  `%end`, а не микрозадачей после: события одного куска разбираются синхронно, и
   *  вывод, пришедший сразу за концом снимка, иначе потерялся бы. */
  private settle(entry: Pending, error: Error | undefined, lines: string[]): void {
    clearTimeout(entry.timer);
    if (entry.capture) this.captureDepth -= 1;
    if (error) entry.reject(error);
    else entry.resolve(lines);
  }

  /** Первый ответ протокола — доказательство, что control mode на этой машине работает. */
  private protocolReplied(): void {
    this.protocolSeen = true;
    this.maybeInit();
  }

  /** Init уходит, только когда известен номер следующего блока: до этого ответ не с чем
   *  сопоставить. Если номера так и не будет, сработает двухсекундный срок готовности. */
  private maybeInit(): void {
    if (this.initStarted || !this.protocolSeen || this.nextBlockId === undefined) return;
    if (this.disposed || this.mode === 'attach') return;
    this.initStarted = true;
    // Размер уходит первым: снимок, который вызывающий возьмёт сразу после готовности,
    // должен быть уже в размере клиента.
    this.command(`refresh-client -C ${this.cols}x${this.rows}`).catch((err: Error): void =>
      this.log(`session ${this.session}: resize failed (${err.message})`),
    );
    this.queryPane(true);
  }

  /** Спрашивает активную панель. Первый запрос решает судьбу режима: без панели нечего
   *  показывать и нечем фильтровать чужой вывод. Дальше отказ — повод для строки в лог. */
  private queryPane(initial: boolean): void {
    this.command(PANE_QUERY).then(
      (lines): void => {
        if (this.applyPaneInfo(lines)) {
          if (initial) this.decide('control');
          return;
        }
        if (initial) this.fallback(`display-message answered "${lines.join(' ')}"`);
        else this.log(`session ${this.session}: unexpected display-message answer`);
      },
      (err: Error): void => {
        if (initial) this.fallback(`display-message failed: ${err.message}`);
        else this.log(`session ${this.session}: active pane query failed: ${err.message}`);
      },
    );
  }

  /** Разбирает ответ `%0 @0 0`; false — ответ не похож на панель, доверять ему нельзя. */
  private applyPaneInfo(lines: string[]): boolean {
    const parts = (lines[0] ?? '').split(' ');
    if (parts.length < 3 || !parts[0].startsWith('%') || !parts[1].startsWith('@')) return false;
    this.activePane = parts[0];
    this.altMatch = 0; // недобранный префикс относился к прежней панели
    this.setAlt(parts[2] === '1');
    return true;
  }

  /** Пометка альтернативного экрана: первое состояние сообщается всегда — при подключении
   *  клиент его ещё не знает, — дальше только изменения. */
  private setAlt(active: boolean): void {
    if (this.altKnown && active === this.altScreen) return;
    this.altKnown = true;
    this.altScreen = active;
    this.opts.onAltScreen?.(active);
  }

  /** Ищет в выводе активной панели вход и выход из альтернативного экрана. Отдельного
   *  уведомления tmux не шлёт, поэтому состояние считается по потоку; префикс может
   *  быть разорван между кусками, а в одном куске побеждает последнее событие. */
  private scanAlt(bytes: Uint8Array): void {
    let last: boolean | undefined;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (this.altMatch === ALT_PREFIX.length) {
        if (byte === ALT_ENTER) last = true;
        else if (byte === ALT_LEAVE) last = false;
        this.altMatch = byte === ALT_PREFIX[0] ? 1 : 0;
        continue;
      }
      if (byte === ALT_PREFIX[this.altMatch]) this.altMatch += 1;
      else this.altMatch = byte === ALT_PREFIX[0] ? 1 : 0;
    }
    if (last !== undefined) this.setAlt(last);
  }

  /** Режим выбран — это решение окончательно на всю жизнь Link. */
  private decide(mode: TerminalMode): void {
    if (this.mode !== undefined) return;
    this.mode = mode;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.resolveReady(mode);
    this.flushInput(); // набранное за время проверки уходит выбранным каналом
  }

  /** Control mode не поднялся: гасим его клиента и открываем сессию прежним способом. */
  private fallback(reason: string): void {
    // Отказ гашения будит отвергнутые команды, и их обработчики зовут fallback снова:
    // флаг ставится до первой такой возможности, а не по факту выбранного режима.
    if (this.disposed || this.mode !== undefined || this.fellBack) return;
    this.fellBack = true;
    this.log(`session ${this.session}: control mode unavailable (${reason}), using tmux attach`);
    this.rejectPending('control client retired');
    this.killChild();
    try {
      this.child = this.spawnClient(false);
    } catch (err) {
      // Обычный attach тоже не поднялся — терминала не будет вовсе.
      this.log(`session ${this.session}: tmux attach failed (${String(err)})`);
      this.disposed = true;
      this.lease?.release();
      this.decide('attach');
      this.opts.onExit();
      return;
    }
    this.decide('attach');
  }

  private handleExit(generation: number): void {
    if (this.disposed || generation !== this.generation) return;
    if (this.mode === undefined) {
      this.fallback('control client exited before any output');
      return;
    }
    // Уничтожать нечего: клиент уже вышел сам, остаётся только отпустить своё.
    this.disposed = true;
    this.detachChild();
    this.rejectPending('terminal exited');
    this.lease?.release();
    this.opts.onExit();
  }

  /** Отправляет команду в stdin клиента и ждёт блок с её номером. */
  private command(line: string, capture = false): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      // Команда tmux имеет смысл только в control mode: в attach тот же текст ушёл бы
      // в сессию нажатиями клавиш.
      if (this.disposed || this.mode === 'attach' || this.nextBlockId === undefined) {
        const reason = this.disposed
          ? 'link disposed'
          : this.mode === 'attach'
            ? 'link runs in attach mode'
            : 'control client has no block number yet';
        reject(new Error(reason));
        return;
      }
      const id = this.nextBlockId;
      this.nextBlockId = id + 1;
      const entry: Pending = {
        id,
        capture,
        timer: setTimeout((): void => {
          const at = this.pending.indexOf(entry);
          if (at === -1) return;
          this.pending.splice(at, 1);
          this.settle(entry, new Error(`no answer to command ${id} in ${COMMAND_TIMEOUT_MS} ms`), []);
        }, COMMAND_TIMEOUT_MS),
        resolve,
        reject,
      };
      if (capture) this.captureDepth += 1;
      this.pending.push(entry);
      this.child.write(`${line}\n`);
    });
  }

  private rejectPending(reason: string): void {
    while (this.pending.length > 0) {
      const entry = this.pending.shift();
      if (entry) this.settle(entry, new Error(reason), []);
    }
  }

  private log(message: string): void {
    const write = this.opts.log ?? ((line: string): void => console.warn(line));
    write(`[session-link] ${message}`);
  }

  write(bytes: Uint8Array): void {
    if (this.disposed || bytes.length === 0) return;
    this.inputQueue.push(bytes);
    this.flushInput();
  }

  /** Ввод уходит пачками: пока предыдущая команда не подтверждена, байты копятся, иначе
   *  быстрый набор превратился бы в поток команд с ответом на каждый символ. Очередь одна,
   *  поэтому порядок байтов сохраняется. */
  private flushInput(): void {
    if (this.disposed || this.mode === undefined || this.inputQueue.length === 0) return;
    if (this.mode === 'attach') {
      this.child.write(Buffer.from(this.takeInput()));
      return;
    }
    if (this.sendInFlight || this.activePane === undefined) return;
    this.sendInFlight = true;
    const done = (): void => {
      this.sendInFlight = false;
      this.flushInput();
    };
    this.command(`send-keys -t ${this.activePane} -H ${escapeInput(this.takeInput())}`).then(done, (err: Error): void => {
      // Отказ send-keys — потерянные байты, но не повод рвать терминал.
      this.log(`session ${this.session}: input dropped (${err.message})`);
      done();
    });
  }

  /** Забирает накопленный ввод одним куском. */
  private takeInput(): Uint8Array {
    const batch = new Uint8Array(this.inputQueue.reduce((size, part) => size + part.length, 0));
    let at = 0;
    for (const part of this.inputQueue) {
      batch.set(part, at);
      at += part.length;
    }
    this.inputQueue = [];
    return batch;
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.cols = clampCols(cols);
    this.rows = clampRows(rows);
    if (this.mode === 'attach') {
      this.child.resize(this.cols, this.rows);
      return;
    }
    // До первого блока команду слать нечем: размер уйдёт вместе с init.
    if (this.nextBlockId !== undefined) {
      this.command(`refresh-client -C ${this.cols}x${this.rows}`).catch((err: Error): void =>
        this.log(`session ${this.session}: resize failed (${err.message})`),
      );
    }
  }

  async snapshot(lines = DEFAULT_SNAPSHOT_LINES): Promise<Uint8Array> {
    const mode = await this.ready;
    if (mode !== 'control' || this.disposed || this.activePane === undefined) return EMPTY;
    // Вывод, пришедший до конца ответа, tmux уже применил к панели — он внутри снимка,
    // и второй раз на экран не идёт; глушение отпускает settle на `%end`.
    const command = `capture-pane -t ${this.activePane} -p -e -S -${snapshotDepth(lines)}`;
    try {
      return encoder.encode((await this.command(command, true)).join('\r\n'));
    } catch (err) {
      // Пустой снимок честнее выдуманного: экран заполнится первым же выводом.
      this.log(`session ${this.session}: capture-pane failed (${String(err)})`);
      return EMPTY;
    }
  }

  pause(): void {
    if (this.disposed) return;
    this.child.pause();
  }

  resume(): void {
    if (this.disposed) return;
    this.child.resume();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.rejectPending('link disposed');
    // Промис готовности не должен висеть вечно у того, кто его уже ждёт.
    this.resolveReady(this.mode ?? 'attach');
    this.lease?.release();
    this.killChild();
  }
}

/** Открывает связь с сессией: спавн клиента синхронный, поэтому отказ pty (нет слота,
 *  нет tmux) прилетает вызывающему исключением, как и прежде у attachTerminal. */
export function open(session: string, opts: SessionLinkOptions): Link {
  return new SessionLink(session, opts);
}
