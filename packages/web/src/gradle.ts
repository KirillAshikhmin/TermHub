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
import type { GradleRunState } from '@termhub/protocol/frames';

import { openCreateModal } from './dashboard';
import { t } from './i18n';
import { sgradleHash } from './routes';
import { mountSessionBar } from './tabs';
import { currentTheme } from './theme';
import { enableTouchScroll } from './touch-scroll';
import type { TermChannel, Transport } from './transport';
import { detectGradle, errorScreen, iconButton, renderHoloBar, svgIcon, toast, wireToolbar } from './ui';

/** Доля высоты вкладки под список тасок; остальное — вывод (история 19). */
const DEFAULT_SPLIT = 55;
const MIN_SPLIT = 15;
const MAX_SPLIT = 85;
const SPLIT_LS_KEY = 'termhub.gradleSplit';
const EXPAND_LS_KEY = 'termhub.gradleExpanded';
/** Опрос состояния, пока сборка идёт: строку exit мы можем и не увидеть (обрыв связи). */
const POLL_MS = 4000;
/** Код выхода печатает сама сборочная оболочка (см. EXIT_TAIL на агенте): в
 *  GradleRunState его нет, поэтому итог читаем из потока вывода. */
const EXIT_RE = /\[termhub\] gradle exit=(\d+)/g;
/** Хвост вывода, в котором ищем строку exit. Не по длине самой строки: при attach
 *  tmux перерисовывает ЦЕЛЫЙ экран одним всплеском, и короткое окно вытеснило бы
 *  итог прошлого запуска промптом, напечатанным после него. */
const TAIL_LIMIT = 64 * 1024;

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

/** Что вкладка даёт панели списка (её наполняет отдельный таск) и тестам. */
export interface GradleTab {
  /** Верхняя половина: сюда рисуются таски и конфигурации проекта. */
  listPanel: HTMLElement;
  /** Запуск сборки. Сам переподключает вывод к пересозданной сборочной сессии;
   *  `phase: 'running'` в ответе без `force` — «сборка уже идёт», решение за вызывающим;
   *  `null` — запуск не удался (сообщение уже показано). */
  run(opts: { tasks: string[]; args?: string[]; subdir?: string; force?: boolean }): Promise<GradleRunState | null>;
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
    onCreate: () => openCreateModal(transport, (name) => (location.hash = `#/term/${encodeURIComponent(name)}`)),
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
  const placeholder = document.createElement('p');
  placeholder.className = 'th-gradle__placeholder';
  placeholder.textContent = t('gradle.listPlaceholder');
  listPanel.append(placeholder);

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
  let tail = '';

  const scanExit = (bytes: Uint8Array): void => {
    tail = (tail + decoder.decode(bytes, { stream: true })).slice(-TAIL_LIMIT);
    // Берём ПОСЛЕДНЕЕ вхождение: в перерисованном экране их может быть несколько.
    EXIT_RE.lastIndex = 0;
    let m: RegExpExecArray | null = null;
    for (let hit = EXIT_RE.exec(tail); hit; hit = EXIT_RE.exec(tail)) m = hit;
    if (!m) return;
    tail = '';
    sawExit = true;
    phase = 'finished';
    exitCode = Number(m[1]);
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
    tail = '';
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
          location.hash = `#/term/${encodeURIComponent(session)}`;
          return;
        }
        listPanel.replaceChildren(placeholder);
        void refresh();
      },
      () => {
        if (disposed) return;
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

  return { listPanel, run: startBuild, teardown };
}
