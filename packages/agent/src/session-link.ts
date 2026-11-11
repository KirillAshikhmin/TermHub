// Жизненный цикл control-клиента tmux (`tmux -CC attach`): выбор режима, активная
// панель, очередь команд и ввода, снимок экрана и откат на прежний `tmux attach`.
// Про разбор строк протокола модуль не знает — это control-protocol.ts.

import { spawnPty, type PtyClient } from './pty-spawn.js';
import { ControlParser, escapeInput, type ControlEvent } from './control-protocol.js';
import type { PtyPool, PtyLease } from './pty-pool.js';
import { clampCols, clampRows } from './pty-common.js';

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
  /** Размер активной панели (только control mode). В control mode tmux НЕ подгоняет вывод
   *  под размер клиента: если окно сессии держит другой клиент (системный терминал, второй
   *  браузер), панель остаётся его размера — и терминал клиента обязан принять этот размер,
   *  иначе вывод ложится на экран со сдвигом. Сообщается при подключении и на каждую смену. */
  onPaneSize?: (cols: number, rows: number) => void;
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
  /** `claim` — человек работает именно на этом клиенте, и размер окна должен стать его
   *  (control mode: клиент становится «последним» для tmux). Без него просьба только
   *  запоминается: пассивный клиент не вправе отбирать размер у того, с кем работают. */
  resize(cols: number, rows: number, claim?: boolean): void;
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

/** Предел придержанного вывода на время пересборки экрана. */
const RESYNC_HOLD_LIMIT = 1 << 20;

/** Глубина снимка по умолчанию: хватает, чтобы сразу было что листать (~18 КБ). */
const DEFAULT_SNAPSHOT_LINES = 200;
/** Глубже history-limit проекта просить нечего. */
const MAX_SNAPSHOT_LINES = 50_000;

/** Предельный срок ответа на команду: чтение бывает на паузе, а блок — брошенным,
 *  и тогда ждать нечего. Отказ лучше вечного ожидания у того, кто ждёт снимок. */
const COMMAND_TIMEOUT_MS = 10_000;

/** Одна команда отдаёт активную панель, её окно, признак альтернативного экрана и размер. */
const PANE_QUERY = 'display-message -p "#{pane_id} #{window_id} #{alternate_on} #{pane_width} #{pane_height}"';

/** Уведомления, после которых активная панель могла смениться — или сменить размер
 *  (`layout-change`: окно подогнали под другого клиента). */
const PANE_NOTIFICATIONS = new Set([
  'session-changed',
  'session-window-changed',
  'window-pane-changed',
  'layout-change',
]);

/** Состояние панели для снимка: без него экран клиента расходится с панелью. Control mode
 *  отдаёт только текст экрана — где стоит курсор и какие режимы включило приложение
 *  (мышь, вставка в скобках, клавиши курсора), терминал клиента иначе не узнаёт: они
 *  были включены до его подключения. Поля через запятую: незнакомое старому tmux поле
 *  приходит пустым и остальные не сдвигает. */
const STATE_MARK = 'TH-STATE';
const STATE_FIELDS = [
  'cursor_x',
  'cursor_y',
  'pane_height',
  'alternate_on',
  'scroll_region_upper',
  'scroll_region_lower',
  'cursor_flag',
  'keypad_cursor_flag',
  'keypad_flag',
  'mouse_standard_flag',
  'mouse_button_flag',
  'mouse_any_flag',
  'mouse_sgr_flag',
  'bracket_paste_flag',
  'wrap_flag',
  'insert_flag',
] as const;
type StateField = (typeof STATE_FIELDS)[number];

function stateQuery(pane: string): string {
  return `display-message -p -t ${pane} "${STATE_MARK},${STATE_FIELDS.map((f) => `#{${f}}`).join(',')}"`;
}

/** Разбор ответа `TH-STATE,…`; undefined — ответ не тот, состояние восстанавливать не из чего. */
export function parsePaneState(line: string | undefined): PaneState | undefined {
  const parts = (line ?? '').split(',');
  if (parts[0] !== STATE_MARK) return undefined;
  const state = {} as PaneState;
  STATE_FIELDS.forEach((field, i) => {
    const raw = parts[i + 1];
    const value = raw === undefined || raw === '' ? NaN : Number(raw);
    state[field] = Number.isInteger(value) && value >= 0 ? value : undefined;
  });
  return state;
}

/** Пересборка экрана после смены размера панели: только видимый экран, с чистого листа.
 *
 *  Смену размера tmux и терминал клиента переживают каждый по-своему (кто какие строки
 *  уводит в историю, где остаётся курсор), и приложение, которое после неё дорисовывает
 *  себя относительно курсора, попадает не в те строки: сверху новая картинка, ниже —
 *  остатки старой. Поэтому после смены размера экран клиента стирается и рисуется заново
 *  по панели; история клиента при этом остаётся его собственной. Позиции здесь абсолютные:
 *  к этому моменту клиент уже принял размер панели (кадр состояния идёт раньше данных). */
export function renderScreen(lines: string[], state: PaneState | undefined): string {
  const alt = state?.alternate_on === 1;
  // Сброс цвета и области прокрутки, в начало экрана, стереть экран — и картинка панели.
  let out = `${state ? (alt ? '\x1b[?1049h' : '\x1b[?1049l') : ''}\x1b[0m\x1b[r\x1b[H\x1b[2J${lines.join('\r\n')}\x1b[0m`;
  if (!state) return out;
  // Режимы ставятся и снимаются явно: вывод, пришедший на время захвата, клиенту не идёт
  // (он уже внутри картинки), и вместе с ним терялись бы переключения режимов — курсор,
  // спрятанный перед перерисовкой и показанный после, так и остался бы спрятанным.
  return out + regionAndCursor(state) + modes(state, true);
}

type PaneState = Record<StateField, number | undefined>;

/** Область прокрутки и абсолютная позиция курсора. Область ставится до курсора: её
 *  установка уводит курсор в начало экрана. */
function regionAndCursor(state: PaneState): string {
  const rows = state.pane_height ?? 0;
  const top = state.scroll_region_upper;
  const bottom = state.scroll_region_lower;
  let out = '';
  if (top !== undefined && bottom !== undefined && rows > 0 && (top > 0 || bottom < rows - 1))
    out += `\x1b[${top + 1};${bottom + 1}r`;
  return `${out}\x1b[${(state.cursor_y ?? 0) + 1};${(state.cursor_x ?? 0) + 1}H`;
}

/** Пары «включить / выключить» по полям состояния. Порядок — как их ставит приложение. */
const MODE_SEQUENCES: ReadonlyArray<readonly [StateField, string, string]> = [
  ['keypad_cursor_flag', '\x1b[?1h', '\x1b[?1l'],
  ['keypad_flag', '\x1b=', '\x1b>'],
  ['mouse_standard_flag', '\x1b[?1000h', '\x1b[?1000l'],
  ['mouse_button_flag', '\x1b[?1002h', '\x1b[?1002l'],
  ['mouse_any_flag', '\x1b[?1003h', '\x1b[?1003l'],
  ['mouse_sgr_flag', '\x1b[?1006h', '\x1b[?1006l'],
  ['bracket_paste_flag', '\x1b[?2004h', '\x1b[?2004l'],
  ['wrap_flag', '\x1b[?7h', '\x1b[?7l'],
  ['insert_flag', '\x1b[4h', '\x1b[4l'],
  ['cursor_flag', '\x1b[?25h', '\x1b[?25l'],
];
/** Значения свежего терминала: снимку для нового экрана их повторять незачем. */
const MODE_DEFAULTS: Partial<Record<StateField, number>> = { wrap_flag: 1, cursor_flag: 1 };

/** Режимы приложения. `explicit` — назвать каждый известный режим (экран клиента уже жил
 *  и мог запомнить другое); иначе — только отличия от свежего терминала. Поле, которого
 *  этот tmux не знает, пропускается: угадывать режим хуже, чем не трогать. */
function modes(state: PaneState, explicit: boolean): string {
  let out = '';
  for (const [field, on, off] of MODE_SEQUENCES) {
    const value = state[field];
    if (value === undefined) continue;
    if (!explicit && value === (MODE_DEFAULTS[field] ?? 0)) continue;
    out += value === 1 ? on : off;
  }
  return out;
}

/** Снимок экрана вместе с состоянием панели — байтами, готовыми к записи в терминал.
 *
 *  Обычный экран: строки истории и экрана, затем курсор ставится ОТНОСИТЕЛЬНО — вверх от
 *  последней строки снимка и вправо. Абсолютной позицией нельзя: терминал клиента бывает
 *  выше панели (размер ещё не доехал, окно держит другой клиент), и строка экрана панели
 *  тогда не совпадает со строкой экрана клиента. Без этого шага курсор остаётся в конце
 *  последней строки, и приложение, которое перерисовывает себя относительными сдвигами
 *  (рамка ввода Claude Code), рисует со смещением — та самая «кривая отрисовка».
 *
 *  Альтернативный экран: клиент сначала сам уходит в него (`?1049h`), иначе полноэкранное
 *  приложение рисуется в обычный буфер и засоряет историю; там позиции абсолютные. */
export function renderSnapshot(lines: string[], state: PaneState | undefined): string {
  const body = lines.join('\r\n');
  if (!state) return body;
  const x = state.cursor_x ?? 0;
  const y = state.cursor_y ?? 0;
  const rows = state.pane_height ?? 0;
  const alt = state.alternate_on === 1;
  let out = alt ? `\x1b[?1049h\x1b[H${body}` : body;
  out += '\x1b[0m'; // цвет последней строки снимка не должен протечь в живой вывод
  if (alt) out += regionAndCursor(state);
  else {
    const up = rows > 0 ? Math.max(0, rows - 1 - y) : 0;
    out += '\r';
    if (up > 0) out += `\x1b[${up}A`;
    if (x > 0) out += `\x1b[${x}C`;
  }
  // Режимы, включённые приложением до подключения клиента.
  return out + modes(state, false);
}

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

/** Ожидаемый ответ: адресуется порядком отправки, поэтому номера в нём нет — только
 *  имя команды, чтобы отказ было видно в логе. */
interface Pending {
  label: string;
  /** Команда снимка: пока она в полёте, вывод панели на экран не идёт. */
  capture: boolean;
  /** Ждущему уже ответили (отказом по сроку), но место в очереди запись держит: блок
   *  tmux на эту команду ещё придёт и должен достаться ей, а не следующей. */
  settled?: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
}

class SessionLink implements Link {
  mode: TerminalMode | undefined;
  readonly ready: Promise<TerminalMode>;

  private readonly lease: PtyLease | undefined;
  private child: PtyClient;
  /** Поколение pty: колбэки мёртвого клиента (откат) не должны ничего делать. */
  private generation = 0;
  private parser = new ControlParser();
  /** Подписки на текущего клиента: снимаются вместе с ним. */
  private childDisposers: Array<{ dispose(): void }> = [];
  /** Команды, ждущие своего блока: каждая знает номер, по которому её узнают. */
  private readonly pending: Pending[] = [];
  /** Непрошеный блок control mode уже прошёл. До него команду отправлять нельзя:
   *  приветствие досталось бы ей как ответ (см. matchBlock). */
  private greeted = false;
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
  private paneCols = 0;
  private paneRows = 0;
  /** Вывод панели, придержанный на время пересборки экрана (см. resync): он идёт клиенту
   *  после свежей картинки, а не до неё. */
  private held: Uint8Array[] | undefined;
  private heldBytes = 0;
  /** Пересборка в полёте. Отдельный флаг, а не «есть придержанный вывод»: придержанное
   *  отпускается и раньше её конца (переполнение), а вторая пересборка параллельно первой
   *  писала бы на экран две картинки вперемешку. */
  private resyncing = false;
  /** Придержанный вывод уже ушёл клиенту: картинка этой пересборки старше него. */
  private resyncStale = false;
  /** Размер сменился ещё раз, пока шла пересборка: по её концу нужна новая. */
  private resyncAgain = false;
  /** Последняя просьба размера, отправленная tmux (`refresh-client -C`). */
  private askedSize = '';
  /** Просьба, с которой мы последний раз забирали размер окна себе. */
  private claimedSize = '';
  /** Размер панели менялся после нашей заявки: только тогда новая заявка на ту же
   *  просьбу имеет смысл — иначе панель, которая под нас не встаёт (окно поделено на
   *  панели, пределы размера), собирала бы заявку на каждое нажатие. */
  private paneMovedSinceClaim = true;
  /** После своей заявки экран пересобирается, даже если размер панели «не менялся».
   *  Пока окно держал другой клиент, панель перерисовывалась под его размер, а узнать об
   *  этом мы могли не успеть (ответ о размере приходит запросом): для нас размер был
   *  100×30 и остался 100×30, но картинка на экране клиента уже не та. */
  private resyncAfterClaim = false;
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
    if (this.readyTimer === undefined || this.greeted) return;
    const left = this.readyDeadline - performance.now();
    if (left <= 0) return; // предел исчерпан: доживаем уже заведённый срок
    if (!this.readyExtendLogged) {
      // Одна строка на всё продление: снаружи ожидание номера блока иначе неотличимо
      // от зависшего терминала — пользователь до предела смотрит в пустой экран.
      this.readyExtendLogged = true;
      this.log(`session ${this.session}: control protocol answers, waiting for the first block`);
    }
    this.armReady(Math.min(READY_TIMEOUT_MS, left), `no control block in ${READY_MAX_WAIT_MS} ms of notifications`);
  }

  /** Спавнит клиента tmux; аргументы — только массивом, без shell. */
  private spawnClient(control: boolean): PtyClient {
    const socket = this.opts.socketName ? ['-L', this.opts.socketName] : [];
    // Завершающее ':' отделяет имя сессии: иначе точка в sprut.app трактуется как панель.
    const args = [...socket, ...(control ? ['-CC'] : []), 'attach', '-t', `=${this.session}:`];
    const generation = this.generation;
    const child = spawnPty('tmux', args, {
      cols: this.cols,
      rows: this.rows,
      env: { ...process.env, TERM: 'xterm-256color' },
      // Не запустился сам бинарь: наружу это придёт как exit, но без строки в
      // логе причина осталась бы невидимой — снаружи терминал просто закрылся.
      onError: (err): void => this.log(`session ${this.session}: tmux client failed to start: ${err.message}`),
    });
    this.childDisposers = [
      child.onData((chunk: Buffer): void => this.handleData(chunk, generation)),
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
    this.child.destroy();
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
        if (this.captureDepth !== 0) return;
        if (this.held) {
          this.held.push(event.data);
          this.heldBytes += event.data.length;
          // Пересборка затянулась под потоком вывода: держать больше мегабайта нельзя.
          // Картинка, которая ещё в пути, теперь старше отпущенного — на экран ей нельзя.
          if (this.heldBytes > RESYNC_HOLD_LIMIT) {
            this.resyncStale = true;
            this.releaseHeld();
          }
        } else this.opts.onData(event.data);
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

  /** Ответ адресуется ПОРЯДКОМ отправки, а не номером блока: номер предсказать нельзя.
   *  На живом tmux 3.7b приветствие пришло блоком 308, а ответ на первую же нашу команду —
   *  блоком 313: промежуточные номера tmux потратил сам, и «последний виденный плюс один»
   *  расходится с действительностью на первом же подключении.
   *
   *  Порядок надёжен, потому что control-клиент получает блоки только на свои команды плюс
   *  единственное непрошеное приветствие, а команды уходят строго после него (maybeInit).
   *  Значит приветствие всегда встречает пустую очередь — и «блок при пустой очереди» это и
   *  есть тот самый блок, которого никто не ждёт: очередь он не двигает и режим не роняет.
   *  Номер остаётся меткой для логов. Надёжнее было бы смотреть флаги `%begin` (у приветствия
   *  ноль, у ответов на наши команды единица), но разбор их наружу не отдаёт. */
  private matchBlock(id: number, lines: string[], failed: boolean): void {
    this.greeted = true;
    const head = this.pending.shift();
    // Ответ на команду, которую уже перестали ждать: он её и закрывает, молча.
    if (head?.settled) return;
    if (head === undefined) {
      // Отказ, которого никто не ждал, до выбора режима — доказательство, что control
      // mode тут не работает; после выбора терминал остаётся живым.
      if (failed && this.mode === undefined) this.fallback(`control stream error: ${lines.join(' ')}`);
      return;
    }
    this.settle(head, failed ? new Error(`block ${id}: ${lines.join(' ')}`) : undefined, lines);
  }

  /** Снимает команду с очереди. Глушение вывода отпускается здесь, в момент разбора
   *  `%end`, а не микрозадачей после: события одного куска разбираются синхронно, и
   *  вывод, пришедший сразу за концом снимка, иначе потерялся бы. */
  private settle(entry: Pending, error: Error | undefined, lines: string[]): void {
    if (entry.settled) return;
    entry.settled = true;
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
    if (this.initStarted || !this.protocolSeen || !this.greeted) return;
    if (this.disposed || this.mode === 'attach') return;
    this.initStarted = true;
    // Размер уходит первым: снимок, который вызывающий возьмёт сразу после готовности,
    // должен быть уже в размере клиента.
    this.askSize();
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
    if (this.activePane !== parts[0]) this.altMatch = 0; // недобранный префикс относился к прежней панели
    // Активной стала другая панель (переключили окно или панель из системного терминала):
    // на экране клиента картинка прежней, а вывод дальше пойдёт уже от новой.
    const switched = this.activePane !== undefined && this.activePane !== parts[0];
    this.activePane = parts[0];
    this.setAlt(parts[2] === '1');
    const cols = Number(parts[3]);
    const rows = Number(parts[4]);
    if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
      const first = this.paneCols === 0;
      const moved = cols !== this.paneCols || rows !== this.paneRows;
      if (moved) {
        this.paneCols = cols;
        this.paneRows = rows;
        this.paneMovedSinceClaim = true;
        this.opts.onPaneSize?.(cols, rows);
      }
      // Первый размер — часть подключения (экран придёт снимком); каждая следующая
      // смена оставляет экран клиента и панель в разных состояниях — пересобираем.
      // То же после своей заявки, даже если размер для нас остался прежним.
      if (!first && this.mode === 'control' && (moved || this.resyncAfterClaim || switched)) {
        this.resyncAfterClaim = false;
        void this.resync();
      }
    } else if (switched && this.mode === 'control') void this.resync();
    return true;
  }

  /** Отпускает придержанный вывод клиенту. */
  private releaseHeld(): void {
    const held = this.held;
    this.held = undefined;
    this.heldBytes = 0;
    if (held && !this.disposed) for (const part of held) this.opts.onData(part);
  }

  /** Рисует экран клиента заново по панели (renderScreen). Живой вывод на это время
   *  придерживается и уходит следом: иначе он лёг бы на экран раньше картинки, поверх
   *  которой его напечатали. */
  private async resync(): Promise<void> {
    if (this.resyncing) {
      this.resyncAgain = true;
      return;
    }
    const pane = this.activePane;
    if (this.disposed || pane === undefined) return;
    this.resyncing = true;
    this.resyncStale = false;
    this.held = [];
    this.heldBytes = 0;
    try {
      const { lines, state } = await this.capture(pane, '');
      // Придержанное уже ушло клиенту (переполнение): эта картинка старше него, и
      // стирать ею экран нельзя — следующая перерисовка приложения догонит сама.
      if (!this.disposed && !this.resyncStale) this.opts.onData(encoder.encode(renderScreen(lines, state)));
    } catch (err) {
      // Экран остаётся как был: следующая перерисовка приложения его догонит.
      this.log(`session ${this.session}: screen resync failed (${String(err)})`);
    } finally {
      this.releaseHeld();
      this.resyncing = false;
      if (this.resyncAgain && !this.disposed) {
        this.resyncAgain = false;
        void this.resync();
      }
    }
  }

  /** Текст панели и её состояние одним шагом. Обе команды уходят подряд, до первого
   *  ответа: сервер tmux исполняет их одну за другой, и состояние (курсор, режимы)
   *  относится к тому же мигу, что и текст. Вывод глушит только сам захват: пришедшее
   *  после его конца в картинку уже не попало и обязано дойти до экрана, даже если ответ
   *  о состоянии ещё в пути. Отказ захвата — исключение; без состояния картинка всё равно
   *  полезна (экран заполнится, курсор догонит вывод), поэтому его отказ — строка в лог. */
  private async capture(pane: string, depth: string): Promise<{ lines: string[]; state: PaneState | undefined }> {
    const shot = this.command(`capture-pane -t ${pane} -p -e${depth}`, true);
    const state = this.command(stateQuery(pane)).then(
      (answer) => parsePaneState(answer[0]),
      (err: Error) => {
        this.log(`session ${this.session}: pane state query failed (${err.message})`);
        return undefined;
      },
    );
    return { lines: await shot, state: await state };
  }

  /** Просит у tmux свой размер окна. Одна и та же просьба дважды не уходит; промис —
   *  конец отправленной просьбы (undefined — слать было нечего). */
  private askSize(): Promise<void> | undefined {
    const size = `${this.cols}x${this.rows}`;
    if (size === this.askedSize) return undefined;
    this.askedSize = size;
    return this.command(`refresh-client -C ${size}`).then(
      (): void => undefined,
      (err: Error): void => {
        this.askedSize = ''; // не дошла — следующая просьба обязана уйти заново
        this.log(`session ${this.session}: resize failed (${err.message})`);
      },
    );
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
      if (this.disposed || this.mode === 'attach' || !this.greeted) {
        const reason = this.disposed
          ? 'link disposed'
          : this.mode === 'attach'
            ? 'link runs in attach mode'
            : 'control client has not greeted yet';
        reject(new Error(reason));
        return;
      }
      const label = line.split(' ')[0];
      const entry: Pending = {
        label,
        capture,
        timer: setTimeout((): void => {
          // Из очереди запись НЕ убирается: ответы адресуются порядком отправки, и блок
          // на эту команду всё-таки придёт (чтение стояло на паузе, tmux был занят) —
          // без записи он достался бы следующей команде, и сопоставление ответов
          // сдвинулось бы навсегда: снимок получил бы ответ на ввод, запрос панели —
          // строки снимка.
          this.settle(entry, new Error(`no answer to ${label} in ${COMMAND_TIMEOUT_MS} ms`), []);
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

  resize(cols: number, rows: number, claim = true): void {
    if (this.disposed) return;
    this.cols = clampCols(cols);
    this.rows = clampRows(rows);
    if (this.mode === 'attach') {
      this.child.resize(this.cols, this.rows);
      return;
    }
    // До приветственного блока команду слать нельзя: размер уйдёт вместе с init.
    if (!this.greeted) return;
    const size = `${this.cols}x${this.rows}`;
    // Размер окна tmux отдаёт «последнему» клиенту, а среди control-клиентов последним
    // навсегда остаётся подключившийся позже: просьбы остальных он просто не слушает
    // (замер на tmux 3.7c). `switch-client` на свою же сессию делает последним нас — так
    // размер задаёт тот клиент, с которым человек сейчас работает. Политика `window-size`
    // при этом не меняется.
    //
    // Заявка уходит, только когда она что-то меняет: клиент просит её явно (`claim` —
    // действие человека, а не пересчёт раскладки пассивной вкладки), и после прошлой
    // заявки на эту же просьбу размер панели менялся. Каждая лишняя заявка — это
    // `switch-client`, переспрос панели и полная перерисовка экрана у всех клиентов сессии.
    //
    // Сравнивать просьбу с известным размером панели («уже наш — заявка не нужна») здесь
    // нельзя: размер панели приходит ответом на запрос и в этот миг бывает устаревшим —
    // окно только что забрал другой клиент, а ответ ещё в пути. Заявка пропала бы молча
    // (поймано на живом tmux).
    if (claim && (size !== this.claimedSize || this.paneMovedSinceClaim)) {
      this.claimedSize = size;
      this.paneMovedSinceClaim = false;
      this.command(`switch-client -t =${this.session}:`).catch((err: Error): void =>
        this.log(`session ${this.session}: size claim failed (${err.message})`),
      );
      this.askedSize = ''; // после смены «последнего» клиента tmux применяет свежую просьбу
      // Заявка исполнена — спрашиваем панель сами: уведомления о смене раскладки может
      // и не быть (размер для tmux не изменился), а экран пересобрать всё равно нужно.
      this.resyncAfterClaim = true;
      void this.askSize()?.then((): void => {
        if (!this.disposed && this.mode === 'control') this.queryPane(false);
      });
      return;
    }
    void this.askSize();
  }

  async snapshot(lines = DEFAULT_SNAPSHOT_LINES): Promise<Uint8Array> {
    const mode = await this.ready;
    if (mode !== 'control' || this.disposed || this.activePane === undefined) return EMPTY;
    // Вывод, пришедший до конца ответа, tmux уже применил к панели — он внутри снимка,
    // и второй раз на экран не идёт; глушение отпускает settle на `%end`.
    try {
      const shot = await this.capture(this.activePane, ` -S -${snapshotDepth(lines)}`);
      return encoder.encode(renderSnapshot(shot.lines, shot.state));
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
