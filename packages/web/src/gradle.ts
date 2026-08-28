// Вкладка Gradle экрана сессии: сверху панель списка (таски и конфигурации),
// снизу — окно вывода сборки. Окно — СВОЙ компактный xterm (xterm + FitAddon +
// transport.openTerm), а не экран из term.ts: тому принадлежит весь экран (полоса
// вкладок сессий, панель клавиш, подгонка под клавиатуру), и вытаскивать оттуда
// «голый» терминал — рефакторинг ради одного потребителя (§8 спецификации).
// Вывод живёт в отдельной tmux-сессии на Mac, поэтому уход на «Терминал»,
// перезагрузка страницы и обрыв связи его не теряют: при монтировании спрашиваем
// `status` и подключаемся к живой сборочной сессии.

import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import type { GradleRunConfig, GradleRunState, GradleTasks } from '@termhub/protocol/frames';

import { openCreateModal } from './dashboard';
import type { RecentRun, TaskGroupTree } from './gradle-view';
import {
  RECENT_LIMIT,
  filterTasks,
  groupTasks,
  pushRecent,
  recentKey,
  renderConfigRow,
  renderRecentRow,
  renderTaskRow,
} from './gradle-view';
import { t } from './i18n';
import { sgradleHash, termHash } from './routes';
import { mountSessionBar } from './tabs';
import { currentTheme } from './theme';
import { enableTouchScroll } from './touch-scroll';
import type { TermChannel, Transport } from './transport';
import {
  detectGradle,
  errorScreen,
  iconButton,
  openModal,
  renderHoloBar,
  spinner,
  svgIcon,
  toast,
  wireToolbar,
} from './ui';

/** Доля высоты вкладки под список тасок; остальное — вывод (история 19). */
const DEFAULT_SPLIT = 55;
const MIN_SPLIT = 15;
const MAX_SPLIT = 85;
const SPLIT_LS_KEY = 'termhub.gradleSplit';
const EXPAND_LS_KEY = 'termhub.gradleExpanded';
/** Недавние запуски (история 27) — префикс, имя сессии дописывается. */
const RECENT_LS_PREFIX = 'termhub.gradleRecent.';
/** Опрос состояния, пока сборка идёт: строку exit мы можем и не увидеть (обрыв связи). */
const POLL_MS = 4000;
/** Код выхода печатает сама сборочная оболочка (см. EXIT_TAIL на агенте): в
 *  GradleRunState его нет, поэтому итог читаем из потока вывода. */
const EXIT_MARK = '[termhub] gradle exit=';
/** Цифры сразу за маркером и обязательный перевод строки за ними: без него код,
 *  разрезанный между кадрами (`…exit=1` | `2\n`), прочитался бы как «1». Годится и
 *  `\r` — в pty перевод строки едет как CRLF. Без флага `g`: регулярка со счётчиком
 *  `lastIndex` в общей константе — это состояние, поделённое всеми вкладками. */
const EXIT_CODE_RE = /^(\d+)[\r\n]/;
/** Сколько символов кадра переносим в следующий: строка итога может прийти
 *  разрезанной между двумя записями канала. Ровно её длина с запасом на код. */
const EXIT_CARRY = EXIT_MARK.length + 16;

// Палитра ANSI под тему приложения — копия из term.ts: тот файл владеет целым
// экраном терминала, и вынос общей палитры означал бы его рефакторинг (вне рамок).
const DARK_ANSI: Partial<ITheme> = {
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
  brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
};
const LIGHT_ANSI: Partial<ITheme> = {
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00',
  blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01',
  brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
};

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function xtermTheme(): ITheme {
  const light = currentTheme() === 'light';
  const background = cssVar('--bg', light ? '#f6f8fa' : '#0d1117');
  const accent = cssVar('--accent', light ? '#16b790' : '#38d3a8');
  return {
    background,
    foreground: cssVar('--text', light ? '#1f2328' : '#e6edf3'),
    cursor: accent,
    cursorAccent: background,
    selectionBackground: cssVar('--accent-tint', 'rgba(56, 211, 168, 0.25)'),
    ...(light ? LIGHT_ANSI : DARK_ANSI),
  };
}

function clampSplit(value: number): number {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, Math.round(value)));
}

function readSplit(): number {
  try {
    const raw = Number(localStorage.getItem(SPLIT_LS_KEY));
    if (Number.isFinite(raw) && raw > 0) return clampSplit(raw);
  } catch {
    // localStorage недоступен — раскладка по умолчанию.
  }
  return DEFAULT_SPLIT;
}

function writeSplit(value: number): void {
  try {
    localStorage.setItem(SPLIT_LS_KEY, String(value));
  } catch {
    // Персист необязателен.
  }
}

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPAND_LS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeExpanded(value: boolean): void {
  try {
    localStorage.setItem(EXPAND_LS_KEY, value ? '1' : '0');
  } catch {
    // Персист необязателен.
  }
}

/** Строка ввода → список токенов: пробелы внутри аргумента агент всё равно отвергнет. */
function tokens(value: string): string[] {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

/** Папка запуска конфигурации относительно корня сессии ('' — сам корень).
 *  `null` — папка вне корня: правдоподобная подмена корнем хуже отказа. */
function relSubdir(root: string, dir: string): string | null {
  if (!root || dir === root) return '';
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : null;
}

function isRecent(value: unknown): value is RecentRun {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const strings = (x: unknown): boolean => Array.isArray(x) && x.every((s) => typeof s === 'string');
  return strings(v.tasks) && strings(v.args) && typeof v.subdir === 'string';
}

/** Недавние запуски — на сессию: у соседней сессии свой проект и свои таски. */
function recentStoreKey(session: string): string {
  return `${RECENT_LS_PREFIX}${session}`;
}

function readRecents(session: string): RecentRun[] {
  try {
    const raw = localStorage.getItem(recentStoreKey(session));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecent).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function writeRecents(session: string, list: RecentRun[]): void {
  try {
    localStorage.setItem(recentStoreKey(session), JSON.stringify(list));
  } catch {
    // Персист необязателен.
  }
}

/** Что вкладка даёт панели списка (её наполняет отдельный таск) и тестам. */
export interface GradleTab {
  /** Верхняя половина: сюда рисуются таски и конфигурации проекта. */
  listPanel: HTMLElement;
  /** Запуск сборки. Сам переподключает вывод к пересозданной сборочной сессии;
   *  `phase: 'running'` в ответе без `force` — «сборка уже идёт», решение за вызывающим;
   *  `null` — запуск не удался (сообщение уже показано). */
  run(opts: { tasks: string[]; args?: string[]; subdir?: string; force?: boolean }): Promise<GradleRunState | null>;
  /** Спросить детект заново. Нужен тому, кто показывает вид повторно: свой детект
   *  вид спрашивает один раз при монтировании, и с протухшим ответом панель не-Gradle
   *  сессии осталась бы на загрузочной заглушке (см. workspace.ts). */
  recheck(): void;
  teardown(): void;
}

/** Монтирует вкладку Gradle сессии (для роутера: только teardown). */
export function mountGradle(root: HTMLElement, transport: Transport, session: string): () => void {
  return mountGradleTab(root, transport, session).teardown;
}

/** То же монтирование, но с доступом к панели списка и запуску сборки. */
export function mountGradleTab(root: HTMLElement, transport: Transport, session: string): GradleTab {
  root.replaceChildren();
  let disposed = false;
  const canWrite = !transport.clientScope || transport.clientScope.write;

  // ── Каркас: полоса сессий + Holo-бар + тело вкладки ──────────────────
  const sbar = mountSessionBar({
    transport,
    current: session,
    onSwitch: (name) => (location.hash = sgradleHash(name)),
    onCreate: () => openCreateModal(transport),
  });
  let hideBar = (): void => {};
  const holo = renderHoloBar({ active: 'gradle', session, transport, onHide: () => hideBar() });
  const toolbar = document.createElement('div');
  toolbar.className = 'th-holowrap th-slide th-slide--top';
  toolbar.append(holo);
  const main = document.createElement('main');
  main.className = 'th-gradle';
  root.append(sbar.el, toolbar, main);

  // ── Верхняя половина: место под список тасок и конфигураций ──────────
  const listPanel = document.createElement('section');
  listPanel.className = 'th-gradle__list';
  // До ответа детекта панель не пуста: список тасок уже едет (история 7).
  const bootNote = document.createElement('p');
  bootNote.className = 'th-gradle__placeholder';
  bootNote.textContent = t('gradle.loadingTasks');
  listPanel.append(bootNote);

  const splitter = document.createElement('div');
  splitter.className = 'th-gradle__splitter';
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-label', t('gradle.resize'));

  // ── Нижняя половина: шапка со статусом + окно вывода ─────────────────
  const outPanel = document.createElement('section');
  outPanel.className = 'th-gradle__output';
  const head = document.createElement('div');
  head.className = 'th-gradle__outhead';
  const statusEl = document.createElement('span');
  statusEl.className = 'th-gradle__status';
  statusEl.setAttribute('role', 'status');
  // Состояние канала вывода: без него обрыв связи выглядел бы как замерший вывод.
  const connEl = document.createElement('span');
  connEl.className = 'th-gradle__conn';
  connEl.setAttribute('role', 'status');
  head.append(statusEl, connEl);
  const host = document.createElement('div');
  host.className = 'th-gradle__term';
  outPanel.append(head, host);
  main.append(listPanel, splitter, outPanel);

  // ── xterm вывода ─────────────────────────────────────────────────────
  const term = new Terminal({
    fontFamily: cssVar('--font-mono', 'monospace'),
    fontSize: 12,
    theme: xtermTheme(),
    cursorBlink: false,
    scrollback: 5000,
    convertEol: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // Тач-скролл — тот же, что и у основного терминала: пальцем по выводу сборки.
  const stopTouchScroll = enableTouchScroll(host, term);

  let rafId = 0;
  const doFit = (): void => {
    try {
      fit.fit();
    } catch {
      // Контейнер ещё без размеров (вкладка скрыта) — пере-fit'ит ResizeObserver.
    }
  };
  const scheduleFit = (): void => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      doFit();
    });
  };

  hideBar = wireToolbar({ toolbars: [toolbar], floatMount: main, onChange: scheduleFit }).hide;

  // ── Раскладка: список сверху, вывод снизу, разделитель тянется ───────
  let split = readSplit();
  let expanded = readExpanded();
  const expandBtn = iconButton('up', t('gradle.expand'), () => setExpanded(!expanded));
  head.append(expandBtn);

  const applyLayout = (): void => {
    listPanel.style.flexBasis = `${split}%`;
    main.classList.toggle('is-expanded', expanded);
    const label = expanded ? t('gradle.collapse') : t('gradle.expand');
    expandBtn.replaceChildren(svgIcon(expanded ? 'down' : 'up'));
    expandBtn.setAttribute('aria-label', label);
    expandBtn.title = label;
    scheduleFit();
  };
  const setExpanded = (value: boolean): void => {
    expanded = value;
    writeExpanded(value);
    applyLayout();
  };

  let dragging = false;
  const onSplitDown = (e: PointerEvent): void => {
    if (expanded) return;
    dragging = true;
    splitter.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onSplitMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const box = main.getBoundingClientRect();
    if (box.height <= 0) return;
    split = clampSplit(((e.clientY - box.top) / box.height) * 100);
    applyLayout();
  };
  const onSplitUp = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    try {
      splitter.releasePointerCapture(e.pointerId);
    } catch {
      // Захват мог быть снят браузером — не важно.
    }
    writeSplit(split);
  };
  splitter.addEventListener('pointerdown', onSplitDown);
  splitter.addEventListener('pointermove', onSplitMove);
  splitter.addEventListener('pointerup', onSplitUp);
  splitter.addEventListener('pointercancel', onSplitUp);
  applyLayout();

  // ── Состояние сборки ─────────────────────────────────────────────────
  let phase: GradleRunState['phase'] = 'idle';
  let command: string | null = null;
  let startedAt: number | null = null;
  let exitCode: number | null = null;
  // Строка `[termhub] gradle exit=N` уже напечатана: runStatus первые 5 с после
  // старта отдаёт `running` независимо от реальности, и без этого флага ответ
  // опроса «воскресил» бы только что завершившуюся сборку.
  let sawExit = false;

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'th-btn th-btn--sm th-gradle__stop';
  stopBtn.textContent = t('gradle.stop');
  stopBtn.addEventListener('click', () => void stopBuild());
  if (canWrite) head.insertBefore(stopBtn, expandBtn);

  const renderStatus = (): void => {
    let text: string;
    if (phase === 'running') text = t('gradle.running', { command: command ?? '' });
    else if (phase !== 'finished') text = t('gradle.never');
    else if (exitCode === null) text = t('gradle.done');
    else if (exitCode === 0) text = t('gradle.doneCode', { code: exitCode });
    else text = t('gradle.failed', { code: exitCode });
    statusEl.textContent = text;
    statusEl.classList.toggle('is-running', phase === 'running');
    statusEl.classList.toggle('is-error', phase === 'finished' && exitCode !== null && exitCode !== 0);
    stopBtn.disabled = phase !== 'running';
  };

  // ── Канал вывода: attach к сборочной tmux-сессии ─────────────────────
  let channel: TermChannel | null = null;
  let attached: string | null = null;
  const decoder = new TextDecoder();
  // Хвост прошлого кадра — всё состояние разбора, и оно своё у каждой вкладки.
  let carry = '';

  const scanExit = (bytes: Uint8Array): void => {
    // Поток сборки — самый горячий путь вкладки, поэтому смотрим только в том,
    // что пришло (плюс перехлёст), а не в накопленном окне: при attach tmux
    // перерисовывает ЦЕЛЫЙ экран одним всплеском, и окно фиксированной длины
    // вытеснило бы итог промптом, напечатанным после него.
    const chunk = carry + decoder.decode(bytes, { stream: true });
    carry = chunk.slice(-EXIT_CARRY);
    // Берём ПОСЛЕДНЕЕ вхождение: в перерисованном экране их может быть несколько.
    const at = chunk.lastIndexOf(EXIT_MARK);
    if (at < 0) return;
    const code = EXIT_CODE_RE.exec(chunk.slice(at + EXIT_MARK.length));
    // Код ещё не дописан — ждём следующий кадр: маркер остался в перехлёсте.
    if (!code) return;
    carry = '';
    sawExit = true;
    phase = 'finished';
    exitCode = Number(code[1]);
    renderStatus();
    schedulePoll();
  };

  const detach = (): void => {
    channel?.close();
    channel = null;
    attached = null;
    connEl.textContent = '';
    connEl.classList.remove('is-shown');
  };

  const attach = (buildSession: string): void => {
    if (disposed || attached === buildSession) return;
    detach();
    attached = buildSession;
    carry = '';
    channel = transport.openTerm(buildSession, {
      cols: term.cols,
      rows: term.rows,
      onData: (bytes) => {
        term.write(bytes);
        scanExit(bytes);
      },
      onBell: () => {},
      onStatus: (state) => {
        if (disposed) return;
        connEl.textContent =
          state === 'reconnecting' ? t('term.reconnecting') : state === 'closed' ? t('term.statusClosed') : '';
        connEl.classList.toggle('is-shown', state !== 'connected');
        if (state !== 'connected') return;
        doFit();
        // ПЕРВЫЙ кадр обязан быть RESIZE — иначе агент не спавнит pty.
        channel?.resize(term.cols, term.rows);
      },
      onEnd: () => {
        // Сборочная сессия исчезла (её убрал следующий запуск или «Стоп» дважды).
        attached = null;
      },
    });
  };

  // ── Опрос состояния и применение ответов агента ──────────────────────
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePoll = (): void => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
    if (disposed || phase !== 'running') return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void refresh();
    }, POLL_MS);
  };

  const applyState = (state: GradleRunState): void => {
    if (disposed) return;
    // Новый запуск (сменилось время старта) — итог прошлого больше не наш.
    if (state.startedAt !== startedAt) {
      startedAt = state.startedAt;
      sawExit = false;
      exitCode = null;
    }
    command = state.command;
    // `running` в первые 5 с после старта агент отдаёт авансом (START_GRACE_MS):
    // уже увиденную строку exit это не отменяет.
    if (!(state.phase === 'running' && sawExit)) phase = state.phase;
    renderStatus();
    if (state.session) attach(state.session);
    else detach();
    schedulePoll();
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    try {
      applyState(await transport.gradle<GradleRunState>('status', { session }));
    } catch {
      // Связь моргнула — состояние не меняем, спросим снова следующим опросом.
      schedulePoll();
    }
  };

  const stopBuild = async (): Promise<void> => {
    stopBtn.disabled = true;
    try {
      applyState(await transport.gradle<GradleRunState>('stop', { session }));
    } catch {
      toast(t('gradle.stopError'), 'error');
      renderStatus();
    }
  };

  const startBuild = async (opts: {
    tasks: string[];
    args?: string[];
    subdir?: string;
    force?: boolean;
  }): Promise<GradleRunState | null> => {
    try {
      const state = await transport.gradle<GradleRunState>('run', {
        session,
        tasks: opts.tasks,
        args: opts.args ?? [],
        subdir: opts.subdir ?? '',
        force: opts.force === true,
      });
      // Каждый запуск ПЕРЕСОЗДАЁТ сборочную сессию (kill + new): прежний attach
      // отвалился вместе с ней, и без переподключения окно осталось бы пустым.
      detach();
      term.clear();
      applyState(state);
      return state;
    } catch (err) {
      // Причину от агента показываем, но обёрнутой в локализованную строку —
      // мимо i18n в интерфейс не уходит ничего.
      const message = err instanceof Error ? err.message : '';
      toast(message ? t('gradle.runErrorDetail', { message }) : t('gradle.runError'), 'error');
      return null;
    }
  };

  // ── Верхняя панель: конфигурации, недавние, дерево тасок с поиском ───
  const panel = document.createElement('div');
  panel.className = 'th-gpanel';

  const taskInput = document.createElement('input');
  taskInput.type = 'text';
  taskInput.className = 'th-input th-grun__task';
  taskInput.placeholder = t('gradle.taskPlaceholder');
  taskInput.setAttribute('aria-label', t('gradle.taskField'));
  const argsInput = document.createElement('input');
  argsInput.type = 'text';
  argsInput.className = 'th-input th-grun__args';
  argsInput.placeholder = t('gradle.argsPlaceholder');
  argsInput.setAttribute('aria-label', t('gradle.argsField'));
  const goBtn = document.createElement('button');
  goBtn.type = 'submit';
  goBtn.className = 'th-btn th-btn--primary th-grun__go';
  goBtn.textContent = t('gradle.run');
  const runBar = document.createElement('form');
  runBar.className = 'th-grun';
  runBar.append(taskInput, argsInput, goBtn);

  const section = (title: string): { el: HTMLElement; list: HTMLElement; head: HTMLElement } => {
    const el = document.createElement('section');
    el.className = 'th-gsec';
    const head = document.createElement('div');
    head.className = 'th-gsec__head';
    const h = document.createElement('h3');
    h.textContent = title;
    head.append(h);
    const list = document.createElement('div');
    list.className = 'th-glist';
    el.append(head, list);
    return { el, list, head };
  };

  const configsSec = section(t('gradle.configs'));
  configsSec.el.classList.add('th-gsec--configs');
  const recentSec = section(t('gradle.recent'));
  recentSec.el.classList.add('th-gsec--recent');
  const tasksSec = section(t('gradle.tasks'));
  tasksSec.el.classList.add('th-gsec--tasks');
  tasksSec.head.append(iconButton('refresh', t('gradle.refresh'), () => void loadTasks(true)));
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'th-input th-gsearch';
  search.placeholder = t('gradle.search');
  search.setAttribute('aria-label', t('gradle.search'));
  tasksSec.el.insertBefore(search, tasksSec.list);

  let projectDir = '';
  let tree: TaskGroupTree = [];
  let configs: GradleRunConfig[] = [];
  let recents = readRecents(session);
  let tasksError: string | null = null;
  let tasksLoading = true;

  // Порядок секций фиксирован; перекладываем детей только когда меняется состав,
  // иначе перенос узла сбрасывал бы фокус с поля поиска на каждый запуск.
  let layoutKey = '';
  const relayout = (): void => {
    const key = `${configs.length > 0}|${recents.length > 0}`;
    if (key === layoutKey) return;
    layoutKey = key;
    const kids: HTMLElement[] = [];
    if (canWrite) kids.push(runBar);
    if (configs.length > 0) kids.push(configsSec.el);
    if (recents.length > 0) kids.push(recentSec.el);
    kids.push(tasksSec.el);
    panel.replaceChildren(...kids);
  };

  const note = (text: string): HTMLElement => {
    const el = document.createElement('p');
    el.className = 'th-gnote';
    el.textContent = text;
    return el;
  };

  // Гость без права записи видит список, но запустить не может (история 26):
  // после каждой перерисовки строки блокируем заново — они созданы с нуля.
  const lockRowsForGuest = (host: HTMLElement): void => {
    if (canWrite) return;
    for (const btn of host.querySelectorAll('button')) btn.disabled = true;
  };

  const renderConfigs = (): void => {
    configsSec.list.replaceChildren(...configs.map((cfg) => renderConfigRow(cfg)));
    lockRowsForGuest(configsSec.list);
  };

  const renderRecents = (): void => {
    recentSec.list.replaceChildren(...recents.map((entry) => renderRecentRow(entry)));
    lockRowsForGuest(recentSec.list);
  };

  const renderTree = (): void => {
    if (tasksLoading) {
      const box = document.createElement('p');
      box.className = 'th-gnote';
      box.append(spinner(), document.createTextNode(t('gradle.loadingTasks')));
      tasksSec.list.replaceChildren(box);
      return;
    }
    if (tasksError !== null) {
      // Хвост stderr от Gradle — через ключ с параметром: мимо i18n ничего не уходит.
      const message = tasksError
        ? t('gradle.tasksErrorDetail', { message: tasksError })
        : t('gradle.tasksError');
      tasksSec.list.replaceChildren(errorScreen(message, () => void loadTasks(true)));
      return;
    }
    // «В проекте нет тасок» и «поиск ничего не дал» — разные беды: с одним текстом
    // пустой проект читался бы как неудачный поиск.
    if (tree.length === 0) {
      tasksSec.list.replaceChildren(note(t('gradle.noTasks')));
      return;
    }
    const shown = filterTasks(tree, search.value);
    if (shown.length === 0) {
      tasksSec.list.replaceChildren(note(t('gradle.noMatches')));
      return;
    }
    const nodes: HTMLElement[] = [];
    for (const project of shown) {
      const box = document.createElement('div');
      box.className = 'th-gproj';
      const title = document.createElement('h4');
      title.className = 'th-gproj__title';
      title.textContent = project.project === ':' ? t('gradle.rootProject') : project.project;
      box.append(title);
      for (const group of project.groups) {
        const gt = document.createElement('h5');
        gt.className = 'th-ggroup__title';
        gt.textContent = group.group;
        box.append(gt, ...group.tasks.map((task) => renderTaskRow(task, search.value)));
      }
      nodes.push(box);
    }
    tasksSec.list.replaceChildren(...nodes);
    lockRowsForGuest(tasksSec.list);
  };

  search.addEventListener('input', renderTree);

  // ── Запуск: строка панели, конфигурация или недавний ──────────────────
  const askRestart = (req: RecentRun): void => {
    openModal((close) => {
      const box = document.createElement('div');
      box.className = 'th-gbusy';
      const head = document.createElement('div');
      head.className = 'th-modal__head';
      const title = document.createElement('h2');
      title.textContent = t('gradle.busyTitle');
      head.append(title, iconButton('close', t('common.close'), close));
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'th-btn';
      cancel.textContent = t('common.cancel');
      cancel.addEventListener('click', close);
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'th-btn th-btn--danger th-gbusy__go';
      go.textContent = t('gradle.restart');
      go.addEventListener('click', () => {
        close();
        void launch(req, true);
      });
      const foot = document.createElement('div');
      foot.className = 'th-modal__foot';
      foot.append(cancel, go);
      box.append(head, note(t('gradle.running', { command: command ?? '' })), foot);
      return box;
    });
  };

  const launch = async (req: RecentRun, force = false): Promise<void> => {
    if (!canWrite || req.tasks.length === 0) return;
    // Сборка уже идёт — молча вторую не запускаем (история 16).
    if (!force && phase === 'running') {
      askRestart(req);
      return;
    }
    const before = startedAt;
    const state = await startBuild({ tasks: req.tasks, args: req.args, subdir: req.subdir, force });
    if (state === null || disposed) return;
    // Отказ агента выглядит как состояние ЧУЖОЙ идущей сборки. Сверять один
    // `startedAt` нельзя: до первого ответа `status` прежнего старта мы не знаем,
    // и отказ на первом же клике прошёл бы за успех. Опорный признак — команда:
    // агент собирает её как `<bin> <таски…> <аргументы…>`.
    const wanted = [...req.tasks, ...req.args].join(' ');
    const ours = state.command !== null && state.command.endsWith(wanted) && state.startedAt !== before;
    if (!force && state.phase === 'running' && !ours) {
      askRestart(req);
      return;
    }
    recents = pushRecent(recents, req);
    writeRecents(session, recents);
    renderRecents();
    relayout();
  };

  const fillInputs = (req: RecentRun): void => {
    taskInput.value = req.tasks.join(' ');
    argsInput.value = req.args.join(' ');
  };

  runBar.addEventListener('submit', (e) => {
    e.preventDefault();
    void launch({ tasks: tokens(taskInput.value), args: tokens(argsInput.value), subdir: '' });
  });

  panel.addEventListener('click', (e) => {
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>('.th-grow') : null;
    if (!row) return;
    if (row.dataset.task !== undefined) {
      const req: RecentRun = { tasks: [row.dataset.task], args: tokens(argsInput.value), subdir: '' };
      fillInputs(req);
      void launch(req);
      return;
    }
    if (row.dataset.config !== undefined) {
      const cfg = configs.find((c) => c.name === row.dataset.config);
      if (!cfg) return;
      const subdir = relSubdir(projectDir, cfg.dir);
      if (subdir === null) {
        toast(t('gradle.configOutside', { name: cfg.name }), 'error');
        return;
      }
      // Аргументы конфигурации подставляются в поле, папка запуска — её own dir (история 11а).
      const req: RecentRun = { tasks: cfg.tasks, args: tokens(cfg.args), subdir };
      fillInputs(req);
      void launch(req);
      return;
    }
    // Ручка — ключ записи, а не её позиция: список переупорядочивается запусками.
    const entry = recents.find((e) => recentKey(e) === row.dataset.recent);
    if (!entry) return;
    fillInputs(entry);
    void launch(entry);
  });

  // ── Данные панели ────────────────────────────────────────────────────
  async function loadTasks(refresh = false): Promise<void> {
    tasksLoading = true;
    tasksError = null;
    renderTree();
    try {
      const data = await transport.gradle<GradleTasks>('tasks', { session, refresh });
      if (disposed) return;
      tree = groupTasks(data);
    } catch (err) {
      if (disposed) return;
      tree = [];
      tasksError = err instanceof Error ? err.message : '';
    }
    tasksLoading = false;
    renderTree();
  }

  const loadConfigs = async (): Promise<void> => {
    try {
      const list = await transport.gradle<GradleRunConfig[]>('configs', { session });
      if (disposed) return;
      configs = Array.isArray(list) ? list : [];
    } catch {
      // Конфигураций может не быть вовсе — это не ошибка вкладки, секции просто нет.
      configs = [];
    }
    renderConfigs();
    relayout();
  };

  // ── Ввод с клавиатуры → сборочная сессия (сборка иногда спрашивает) ───
  const encoder = new TextEncoder();
  const dataDisp = term.onData((s) => {
    if (canWrite) channel?.write(encoder.encode(s));
  });
  const resizeDisp = term.onResize(() => channel?.resize(term.cols, term.rows));

  const ro = new ResizeObserver(scheduleFit);
  ro.observe(host);
  window.addEventListener('resize', scheduleFit);

  renderStatus();
  // Детект: явный `null` («обычная папка») уводит на терминал сессии — вкладки у
  // такой сессии нет (история 3). Сбой запроса — совсем другое: проект никуда не
  // делся, и выкидывать пользователя со вкладки из-за моргнувшей связи нельзя.
  const askDetect = (): void => {
    void detectGradle(transport, session).then(
      (project) => {
        if (disposed) return;
        if (!project) {
          location.hash = termHash(session);
          return;
        }
        projectDir = project.dir;
        listPanel.replaceChildren(panel);
        relayout();
        renderRecents();
        renderTree();
        void loadTasks();
        void loadConfigs();
        void refresh();
      },
      () => {
        if (disposed) return;
        // Панель уже полна списком проекта — обрыв на перепроверке её не стирает:
        // прятать рабочий список на время обрыва незачем.
        if (projectDir !== '') return;
        listPanel.replaceChildren(errorScreen(t('gradle.detectError'), askDetect));
      },
    );
  };
  askDetect();

  const teardown = (): void => {
    disposed = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (pollTimer) clearTimeout(pollTimer);
    ro.disconnect();
    window.removeEventListener('resize', scheduleFit);
    splitter.removeEventListener('pointerdown', onSplitDown);
    splitter.removeEventListener('pointermove', onSplitMove);
    splitter.removeEventListener('pointerup', onSplitUp);
    splitter.removeEventListener('pointercancel', onSplitUp);
    dataDisp.dispose();
    resizeDisp.dispose();
    stopTouchScroll();
    detach();
    sbar.teardown();
    try {
      term.dispose();
    } catch {
      // повторный dispose безопасен
    }
    root.replaceChildren();
  };

  return { listPanel, run: startBuild, recheck: askDetect, teardown };
}
