// Экран терминала: xterm.js поверх WS-фреймов агента. Владеет всем экраном —
// шапка (назад/имя/индикатор соединения), тело с xterm, баннер переподключения,
// оверлей «сессия завершена» и панель быстрых клавиш. Позиционируется по
// visualViewport, чтобы панель клавиш стояла над экранной клавиатурой телефона.

import '@xterm/xterm/css/xterm.css';

import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { ILinkProvider, ITheme } from '@xterm/xterm';

import { openCreateModal } from './dashboard';
import { resetDocumentTitle, setSessionDocumentTitle } from './document-title';
import { t } from './i18n';
import { mountQuickKeys } from './quickkeys';
import { mountSessionTabs, pickNeighbor } from './tabs';
import { createTerminalCopyController } from './term-copy';
import { enterAction } from './term-keys';
import {
  noteTerminalMode,
  otherTerminalMode,
  setTerminalModeRequest,
  terminalModeName,
  terminalModeRequest,
} from './term-mode';
import { markBellSeen, unseenBellCount } from './bell-seen';
import { updateAppBadge } from './app-badge';
import { detectPaths, filePathParts, parentRel } from './termlinks';
import { filesHash, sfilesHash, termHash } from './routes';
import { resolveSessionPath } from './session-path';
import { enableTouchScroll } from './touch-scroll';
import { enableTouchSelect } from './touch-select';
import { playBell } from './sound';
import { currentTheme } from './theme';
import type { TerminalMode, TermChannel, TermConnState, Transport } from './transport';
import { copyToClipboard, hasServerPicker, iconButton, openServerPicker, renderHoloBar, spinner, toast, wireToolbar } from './ui';

const FONT_MIN = 10;
const FONT_MAX = 22;
const FONT_DEFAULT = 14;
const FONT_LS_KEY = 'termhub.fontSize';
const KEYBOARD_LS_KEY = 'termhub.keyboard';
const ENTER_SENDS_LS_KEY = 'termhub.enterSends';
// Потолок очереди ввода до подключения (см. sendData): не влезающий чанк отбрасывается целиком.
const INPUT_QUEUE_MAX = 8 * 1024;

// Открыта ли compose-строка — на уровне модуля, чтобы состояние переживало
// переключение вкладок (пере-монтирование term-экрана). Содержимое не храним:
// строку ввода держит терминал (tmux), compose зеркалит её на лету.
let composeOpen = false;

// ANSI-палитры под тему приложения (fg/bg/курсор берём из CSS-переменных, а 16
// цветов ANSI фиксируем — в theme.css их нет). Дают читаемый вывод в обеих темах.
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

/** Значение CSS-переменной темы (или fallback, если пусто). */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Тема xterm из палитры приложения (совпадает с чромом в light/dark). */
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

/** Размер шрифта из localStorage, зажатый в [10, 22]. */
function readFontSize(): number {
  try {
    const raw = Number(localStorage.getItem(FONT_LS_KEY));
    if (Number.isFinite(raw) && raw > 0) return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(raw)));
  } catch {
    // localStorage недоступен — размер по умолчанию.
  }
  return FONT_DEFAULT;
}

/** Состояние экранной клавиатуры из localStorage (по умолчанию включена). */
function readKeyboardEnabled(): boolean {
  try {
    return localStorage.getItem(KEYBOARD_LS_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeKeyboardEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEYBOARD_LS_KEY, enabled ? '1' : '0');
  } catch {
    // Персист состояния необязателен.
  }
}

/** «Отправлять по Enter» из localStorage (по умолчанию включено — Enter отправляет). */
function readEnterSends(): boolean {
  try {
    return localStorage.getItem(ENTER_SENDS_LS_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeEnterSends(enabled: boolean): void {
  try {
    localStorage.setItem(ENTER_SENDS_LS_KEY, enabled ? '1' : '0');
  } catch {
    // Персист состояния необязателен.
  }
}

/** Хэндл экрана терминала: фокус (его зовёт workspace при показе вкладки) и снятие. */
export interface TerminalHandle {
  focus(): void;
  teardown(): void;
}

/** Совместимая обёртка для роутера (remote.ts): ему нужна только функция снятия. */
export function openTerminal(root: HTMLElement, session: string, transport: Transport): () => void {
  return mountTerminal(root, session, transport).teardown;
}

/** Монтирует терминал сессии в root через транспорт. */
export function mountTerminal(root: HTMLElement, session: string, transport: Transport): TerminalHandle {
  root.replaceChildren();
  setSessionDocumentTitle(session, session);
  let disposed = false;
  markBellSeen(session); // открыли сессию — её звонок прочитан
  updateAppBadge(unseenBellCount()); // бейдж на иконке гаснет сразу, не ждя полла
  // Гость без права записи (relay scope) — терминал только на просмотр: ввод не шлём,
  // панель клавиш и экранную клавиатуру прячем. Агент дополнительно игнорирует ввод.
  const readOnly = !!transport.clientScope && !transport.clientScope.write;

  // ── Разметка экрана ──────────────────────────────────────────────────
  const screen = document.createElement('div');
  screen.className = 'th-term';

  const bar = document.createElement('div');
  bar.className = 'th-termbar';
  bar.append(iconButton('back', t('term.back'), () => (location.hash = '#/')));
  if (readOnly) {
    const badge = document.createElement('span');
    badge.className = 'th-termbar__readonly';
    badge.textContent = t('term.readOnly');
    bar.append(badge);
  }
  // Переход между сессиями: смена hash → штатный remount экрана. Клик по
  // активному табу просто возвращает фокус в терминал.
  const goTo = (name: string): void => {
    if (name === session) term.focus();
    else location.hash = termHash(name);
  };
  const tabs = mountSessionTabs({
    transport,
    current: session,
    onSwitch: goTo,
    onKill: (name) => void killSession(name),
    onCreate: () => openCreateModal(transport),
    onCurrentTitle: (title) => setSessionDocumentTitle(title, session),
  });
  // Флаг: закрываем ТЕКУЩУЮ вкладку и уходим на соседнюю — onEnd не должен показать
  // оверлей «сессия завершена» (это не аварийный конец, а осознанное закрытие).
  let leavingToNeighbor = false;
  // Завершение сессии по крестику таба: подтверждение + kill. Чужой таб исчезнет на
  // refresh; закрытие ТЕКУЩЕЙ вкладки переключает на соседнюю (слева, иначе первую
  // оставшуюся), либо на дашборд, если вкладок не осталось — вместо оверлея.
  async function killSession(name: string): Promise<void> {
    if (!confirm(t('card.confirmKill', { name }))) return;
    // До kill фиксируем порядок вкладок, чтобы выбрать соседа.
    let neighbor: string | null = null;
    if (name === session) {
      const names = (await transport.list()).map((s) => s.name);
      neighbor = pickNeighbor(names, name);
      leavingToNeighbor = true;
    }
    try {
      await transport.kill(name);
    } catch {
      leavingToNeighbor = false;
      toast(t('card.killError'), 'error');
      return;
    }
    if (name === session) location.hash = neighbor ? termHash(neighbor) : '#/';
    else await tabs.refresh();
  }
  // ── Способ подключения и пометка альтернативного экрана ──────────────
  // Режим выбирает агент (его настройка старше просьбы клиента), поэтому чип
  // показывает то, что пришло кадром состояния, а переключатель меняет просьбу
  // для СЛЕДУЮЩЕГО открытия терминала — живой терминал остаётся в своём режиме.
  // Просьба, с которой открыт ЭТОТ терминал (уезжает в кадр открытия ниже), и просьба,
  // выбранная переключателем сейчас: расходятся ровно тогда, когда переключили уже после
  // открытия — тогда просьба ждёт следующего.
  const openedMode: TerminalMode = terminalModeRequest();
  let requestedMode: TerminalMode = openedMode;
  let activeMode: TerminalMode | undefined;

  const altBadge = document.createElement('button');
  altBadge.type = 'button';
  altBadge.className = 'th-termbar__alt';
  altBadge.hidden = true;
  altBadge.textContent = t('term.altScreen');
  altBadge.title = t('term.altScreenHint');
  altBadge.setAttribute('aria-label', `${t('term.altScreen')}: ${t('term.altScreenHint')}`);
  // На телефоне подсказки по наведению нет, а объяснение — половина смысла пометки:
  // по нажатию говорим, почему история в этом приложении не листается.
  altBadge.addEventListener('click', () => toast(t('term.altScreenHint')));

  const modeBtn = document.createElement('button');
  modeBtn.type = 'button';
  modeBtn.className = 'th-termbar__mode';
  const syncMode = (): void => {
    modeBtn.textContent = activeMode ? terminalModeName(activeMode) : '—';
    // Просьбу переключили после открытия — она уедет только в следующий терминал.
    // Совпала с работающим режимом (агент уже подключил так) — обещать нечего.
    const awaitsOpen = requestedMode !== openedMode && requestedMode !== activeMode;
    // Агент ответил не тем, что просили: его настройка старше просьбы, плюс возможен
    // откат на attach. Просьба уже уехала, ждать её нечего — но расхождение видно.
    const overridden = activeMode !== undefined && activeMode !== openedMode;
    modeBtn.classList.toggle('is-pending', awaitsOpen);
    modeBtn.classList.toggle('is-overridden', overridden);
    const parts = [
      activeMode ? t('term.modeActive', { mode: terminalModeName(activeMode) }) : t('term.modeUnknown'),
    ];
    if (overridden) parts.push(t('term.modeOverridden', { mode: terminalModeName(openedMode) }));
    if (awaitsOpen) parts.push(t('term.modeNext', { mode: terminalModeName(requestedMode) }));
    parts.push(t('term.modeSwitch'));
    const label = parts.join(' · ');
    modeBtn.title = label;
    modeBtn.setAttribute('aria-label', label);
  };
  syncMode();
  modeBtn.addEventListener('click', () => {
    requestedMode = otherTerminalMode(requestedMode);
    setTerminalModeRequest(requestedMode);
    syncMode();
    toast(t('term.modeNext', { mode: terminalModeName(requestedMode) }));
  });

  const dot = document.createElement('span');
  dot.className = 'th-conn-dot';
  dot.setAttribute('role', 'status');
  bar.append(tabs.el, altBadge, modeBtn, dot);
  screen.append(bar);

  // Баннер переподключения (скрыт, пока соединение живо).
  const banner = document.createElement('div');
  banner.className = 'th-term__banner';
  banner.setAttribute('role', 'status');
  const bannerText = document.createElement('span');
  bannerText.textContent = t('term.reconnecting');
  const bannerCancel = document.createElement('button');
  bannerCancel.type = 'button';
  bannerCancel.className = 'th-term__banner-cancel';
  bannerCancel.textContent = t('common.cancel');
  bannerCancel.addEventListener('click', () => (location.hash = '#/'));
  banner.append(spinner(), bannerText, bannerCancel);
  screen.append(banner);

  const body = document.createElement('div');
  body.className = 'th-term__body';
  const host = document.createElement('div');
  host.className = 'th-term__host';
  body.append(host);
  screen.append(body);

  root.append(screen);

  // ── xterm ────────────────────────────────────────────────────────────
  let fontSize = readFontSize();
  const term = new Terminal({
    fontFamily: cssVar('--font-mono', 'monospace'),
    fontSize,
    theme: xtermTheme(),
    cursorBlink: true,
    // В control mode локальный scrollback — основной путь: tmux не держит терминал в
    // alt-screen, вывод ложится в обычный буфер, и история листается без сети. При
    // откате на `tmux attach` (и в приложениях, ушедших в alt-screen) прокрутка снова
    // идёт через copy-mode самого tmux — тач-скролл выбирает путь по активному буферу.
    scrollback: 5000,
    macOptionIsMeta: true,
    // Codex включает mouse tracking, поэтому обычный drag должен оставаться у TUI.
    // На macOS Option+drag штатно обходит mouse mode и создаёт xterm selection.
    macOptionClickForcesSelection: true,
    // Нужен для proposed API: unicode11 (unicode.activeVersion) и search-декорации.
    allowProposedApi: true,
    // OSC 8 гиперссылки (ESC]8;;URL) — так их выводит Claude Code и др. CLI, где
    // видимый текст ≠ URL. WebLinksAddon (ниже) их не ловит — только сырые http://.
    linkHandler: {
      activate: (_event, uri) => {
        // OSC 8 задаёт произвольный URI, а его источник — вывод сессии (то есть всё,
        // что там выполняется). Без allowlist схем один `printf` открывал бы
        // javascript:/data:/file: по клику пользователя. Пускаем только веб-схемы.
        let scheme = '';
        try {
          scheme = new URL(uri, location.href).protocol;
        } catch {
          return;
        }
        if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'mailto:') return;
        window.open(uri, '_blank', 'noopener,noreferrer');
      },
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Кликабельные ссылки: URL в выводе открываются в новой вкладке (WebLinksAddon
  // сам ставит noopener). Без аддона xterm ссылки не делает кликабельными.
  term.loadAddon(new WebLinksAddon());
  // OSC 52: приложения в терминале могут класть текст в системный буфер обмена.
  term.loadAddon(new ClipboardAddon());
  // Unicode 11 ширины: корректный рендер эмодзи/CJK/составных символов (иначе
  // вывод современных CLI с эмодзи «разъезжается»).
  const unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = '11';
  // Поиск по буферу терминала (UI — панель поиска ниже).
  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);
  term.open(host);

  // Часто перерисовывающиеся TUI успевают сбросить визуальное выделение xterm до
  // mouseup/Command+C. Держим последний непустой снимок в пределах этого mount и
  // используем общий clipboard helper (включая LAN HTTP fallback).
  const copyController = createTerminalCopyController({
    getSelection: () => term.getSelection(),
    copy: copyToClipboard,
  });
  const selectionDisp = term.onSelectionChange(copyController.selectionChanged);
  const onSelectionStart = (): void => copyController.gestureStarted();
  const onSelectionEnd = (): void => copyController.gestureEnded();
  host.addEventListener('mousedown', onSelectionStart);
  host.addEventListener('mouseup', onSelectionEnd);

  // Кликабельные пути: путь в выводе открывает ПРОВОДНИК СЕССИИ (переключение вкладки,
  // терминал жив), если он внутри корня сессии; иначе — обычный файловый браузер.
  // Корни/корень сессии грузим с ретраем: relay-поток мог ещё не подняться → dirs()
  // вернул бы [] и ссылки не появлялись бы.
  let fileRoots: string[] = [];
  let sessionRoot = ''; // корень-whitelist сессии
  // База CWD для относительных путей — стартовый каталог сессии; уточняется OSC 7 (после cd).
  let termCwd = '';
  const loadRoots = (tries = 0): void => {
    if (disposed) return; // экран снят — цепочку ретраев не продолжаем
    void Promise.all([transport.dirs(), resolveSessionPath(transport, session)])
      .then(([g, res]) => {
        if (g.length) fileRoots = g.map((x) => x.root);
        if (res) {
          sessionRoot = res.root;
          if (!termCwd) termCwd = res.subpath ? `${res.root}/${res.subpath}` : res.root;
        }
        if (!disposed && !fileRoots.length && tries < 10) setTimeout(() => loadRoots(tries + 1), 1500);
      })
      .catch(() => {
        if (!disposed && tries < 10) setTimeout(() => loadRoots(tries + 1), 1500);
      });
  };
  loadRoots();
  term.parser.registerOscHandler(7, (data) => {
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    if (m) {
      try {
        termCwd = decodeURIComponent(m[1]!);
      } catch {
        termCwd = m[1]!;
      }
    }
    return true;
  });
  const pathLinks: ILinkProvider = {
    provideLinks(lineNo, cb) {
      const line = term.buffer.active.getLine(lineNo - 1)?.translateToString(true) ?? '';
      cb(
        detectPaths(line).flatMap((m) => {
          const p = filePathParts(m.path, fileRoots, termCwd || undefined);
          if (!p) return [];
          // Внутри корня этой сессии → её вкладка «Проводник» (переключение вкладки,
          // терминал жив; полный путь — чтобы открыть папку И превью файла). Иначе —
          // обычный файловый браузер на родительской папке.
          const target = p.root === sessionRoot ? sfilesHash(session, p.rel) : filesHash(p.root, parentRel(p.rel));
          return [
            {
              range: { start: { x: m.index + 1, y: lineNo }, end: { x: m.index + m.length, y: lineNo } },
              text: m.path,
              activate: () => {
                location.hash = target;
              },
            },
          ];
        }),
      );
    },
  };
  term.registerLinkProvider(pathLinks);

  // WebGL-рендер по возможности; при ошибке (нет GL/контекст потерян) — canvas.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // Без WebGL — дефолтный рендер xterm.
  }

  // Мобильный скролл: транслируем тач-драг в wheel на корне xterm (touch xterm
  // в приложение не форвардит; touch-action:none в CSS не даёт жесту утечь в
  // страницу/pull-to-refresh). Цель — .xterm; если ещё не создан, host.
  // По умолчанию тач-драг скроллит историю; в режиме выделения (тумблер в панели)
  // тот же драг выделяет текст для копирования — активен ровно один из двух.
  let stopTouchScroll: (() => void) | null = enableTouchScroll(host, term);
  let stopTouchSelect: (() => void) | null = null;
  const applySelectMode = (enabled: boolean): void => {
    if (enabled) {
      stopTouchScroll?.();
      stopTouchScroll = null;
      const screenEl =
        (term.element?.querySelector('.xterm-screen') as HTMLElement | null) ?? term.element ?? host;
      stopTouchSelect = enableTouchSelect(host, screenEl);
    } else {
      stopTouchSelect?.();
      stopTouchSelect = null;
      stopTouchScroll = enableTouchScroll(host, term);
    }
  };
  // ── Экранная клавиатура (чекбокс в панели) ───────────────────────────
  // Выключенная — textarea xterm переводится в inputmode=none: браузер не
  // показывает экранную клавиатуру даже при фокусе (тап/реконнект). Это же
  // глушит «сама открывается» при навигации стрелками и скролле.
  let keyboardEnabled = readKeyboardEnabled();
  const applyKeyboardMode = (): void => {
    const ta = term.textarea;
    if (!ta) return;
    ta.inputMode = keyboardEnabled && !readOnly ? 'text' : 'none';
    // Глушим предиктив/автозамену/свайп у терминальной textarea: на Android они
    // дают дубликаты и «стирается копия». Нативный ввод — через compose bar.
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.autocomplete = 'off';
    ta.spellcheck = false;
  };
  applyKeyboardMode();
  // Фокус — сразу при монтаже, не дожидаясь connected, и независимо от тумблера ⌨: поле
  // уже в нужном режиме (при выключенном тумблере — inputmode=none: экранная клавиатура
  // не всплывёт, аппаратная работает), поэтому applyKeyboardMode обязан отработать ДО
  // фокуса. Раньше фокус давал только onStatus('connected'), и набранное до него пропадало.
  // Кому этот фокус достаётся: на пути openTerminal/remote.ts — экрану сразу; на пути
  // workspace вид в момент монтажа ещё скрыт (без is-active), браузер такой фокус
  // игнорирует, и рабочий фокус там даёт show('term') после показа вкладки.
  term.focus();

  // ── Соединение (через транспорт) ─────────────────────────────────────
  // Канал владеет жизненным циклом соединения (WS/E2E, backoff-реконнект);
  // этот экран лишь отражает статус и рисует данные/оверлеи.
  let channel: TermChannel | null = null;
  let endedOverlay: HTMLElement | null = null;

  // Кружок статуса — вход в выбор сервера (в LAN-режиме выбирать не из чего, там
  // реестр пуст и кружок остаётся просто индикатором).
  if (hasServerPicker()) {
    dot.classList.add('is-clickable');
    dot.setAttribute('role', 'button');
    dot.tabIndex = 0;
    dot.addEventListener('click', () => openServerPicker());
    dot.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openServerPicker();
      }
    });
  }

  const setDot = (state: TermConnState): void => {
    dot.classList.remove('is-connected', 'is-reconnecting', 'is-closed');
    dot.classList.add(`is-${state}`);
    const label =
      state === 'connected'
        ? t('term.statusConnected')
        : state === 'reconnecting'
          ? t('term.statusReconnecting')
          : t('term.statusClosed');
    dot.setAttribute('aria-label', label);
    dot.title = label;
  };

  const doFit = (): void => {
    try {
      fit.fit();
    } catch {
      // Контейнер ещё без размеров (не в DOM / скрыт) — ретраит следующий resize.
    }
  };

  const sendResize = (): void => channel?.resize(term.cols, term.rows);

  // ── Очередь ввода до подключения ─────────────────────────────────────
  // Транспорт молча роняет байты, пока соединение не поднято (LAN: WebSocket ещё не
  // OPEN; relay — до OpenOk), а фокус в терминале стоит с монтажа — набранное в это
  // окно копим и отдаём на connected. Инвариант «ПЕРВЫЙ кадр — RESIZE» (иначе агент не
  // спавнит pty) неприкосновенен: очередь сбрасывается строго ПОСЛЕ sendResize().
  // Потолок INPUT_QUEUE_MAX: чанк, который не влезает целиком, отбрасывается целиком —
  // резать его нельзя, граница байтов пройдёт внутри многобайтового символа, и в pty
  // уйдёт разорванный UTF-8. onEnd и teardown очищают.
  let connected = false;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const sendData = (bytes: Uint8Array): void => {
    if (readOnly) return;
    if (connected) {
      channel?.write(bytes);
      return;
    }
    if (pendingBytes + bytes.length > INPUT_QUEUE_MAX) return;
    pending.push(bytes);
    pendingBytes += bytes.length;
  };
  const dropPending = (): void => {
    pending = [];
    pendingBytes = 0;
  };
  const flushPending = (): void => {
    const queued = pending;
    dropPending();
    for (const chunk of queued) channel?.write(chunk);
  };

  // Общий оверлей конца сессии — используется и для штатного CLOSE («сессия
  // завершена»), и для ERROR (причина в heading), текст подставляет вызывающий.
  const showOverlay = (heading: string, hint: string): void => {
    if (endedOverlay) return;
    endedOverlay = document.createElement('div');
    endedOverlay.className = 'th-term__ended';
    const card = document.createElement('div');
    card.className = 'th-term__ended-card';
    const headingEl = document.createElement('h2');
    headingEl.textContent = heading;
    const hintEl = document.createElement('p');
    hintEl.className = 'th-term__ended-hint';
    hintEl.textContent = hint;
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'th-btn th-btn--primary';
    backBtn.textContent = t('term.back');
    backBtn.addEventListener('click', () => (location.hash = '#/'));
    card.append(headingEl, hintEl, backBtn);
    endedOverlay.append(card);
    body.append(endedOverlay);
    backBtn.focus();
  };

  channel = transport.openTerm(session, {
    cols: term.cols,
    rows: term.rows,
    // Снимок просьбы на момент открытия: переключатель после этого меняет только
    // то, что уедет в следующий терминал.
    mode: openedMode,
    onData: (bytes) => term.write(bytes),
    onBell: () => playBell(),
    onTerminalState: (state) => {
      if (disposed) return;
      // Поля независимы: пришло одно — второе не трогаем.
      if (state.mode) {
        activeMode = state.mode;
        noteTerminalMode(state.mode);
        syncMode();
      }
      if (state.altScreen !== undefined) altBadge.hidden = !state.altScreen;
    },
    onStatus: (state) => {
      if (disposed) return;
      setDot(state);
      connected = state === 'connected';
      if (state === 'connected') {
        banner.classList.remove('is-shown');
        doFit();
        // ПЕРВЫЙ кадр обязан быть RESIZE — иначе агент не спавнит pty.
        sendResize();
        flushPending(); // набранное до подключения — только после RESIZE
        // Фокус (и клавиатуру) на connect — только если клавиатура включена.
        if (keyboardEnabled) term.focus();
      } else if (state === 'reconnecting') {
        banner.classList.add('is-shown');
      } else {
        banner.classList.remove('is-shown');
      }
    },
    onEnd: (reason) => {
      connected = false;
      dropPending(); // сессии больше нет — набранное для неё некуда слать
      if (disposed || leavingToNeighbor) return;
      if (reason.kind === 'error')
        showOverlay(t('term.sessionError', { message: reason.message ?? '' }), t('term.sessionEndedHint'));
      else showOverlay(t('term.sessionEnded'), t('term.sessionEndedHint'));
    },
  });

  // ── Ввод из терминала → pty ──────────────────────────────────────────
  const encoder = new TextEncoder();
  const dataDisp = term.onData((s) => sendData(encoder.encode(s)));
  // Правило Enter — чистая enterAction (term-keys.ts): тумблер «Отправлять по Enter»
  // меняет поведение ТОЛЬКО чистого Enter, Shift+Enter — всегда перенос. «Перенос» шлём
  // как ESC+CR (\x1b\r) — это то, что терминал отправляет на Option/Alt+Enter, и Claude
  // Code (как и другие readline/ink-TUI) вставляет новую строку. Голый \n не годится:
  // Claude Code трактует его как submit (проверено на v2.1.209).
  // Почему preventDefault обязателен: при `false` xterm выходит из _keyDown ДО своего
  // cancel(), браузер порождает keypress, и _keyPress xterm шлёт \r через onData — одно
  // нажатие давало перенос И отправку. Гасим keydown сами, а keypress Enter подавляем
  // ещё и явно — страховка от второго \r и от \n в скрытой textarea.
  let enterSends = readEnterSends();
  term.attachCustomKeyEventHandler((e) => {
    if (!copyController.keyEvent(e)) return false;
    const action = enterAction(e, enterSends);
    if (action === 'newline') {
      sendData(encoder.encode('\x1b\r'));
      e.preventDefault();
      return false;
    }
    if (action === 'suppress') {
      e.preventDefault();
      return false;
    }
    // 'send': xterm сам шлёт \r и гасит событие. Остальное ниже — только keydown.
    if (action === 'send' || e.type !== 'keydown') return true;
    // Cmd+←/→ — в начало/конец строки ввода, как в нативных полях macOS. Шлём Ctrl-A/
    // Ctrl-E: их понимают и readline (zsh/bash), и ink-TUI вроде Claude Code, тогда как
    // Home/End (\x1b[H, \x1b[F) обрабатывают далеко не все. Сам xterm на Cmd+стрелку
    // не шлёт ничего, поэтому без перехвата клавиша просто пропадала.
    if (e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      sendData(encoder.encode(e.key === 'ArrowLeft' ? '\x01' : '\x05'));
      return false;
    }
    // Option+←/→ — по словам, как в нативных полях macOS. Шлём ESC b / ESC f —
    // словесные привязки readline, понятные и zsh/bash, и ink-TUI. Сам xterm на
    // Alt+стрелку шлёт \x1b[1;3D/\x1b[1;3C, который большинство TUI игнорирует.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      sendData(encoder.encode(e.key === 'ArrowLeft' ? '\x1bb' : '\x1bf'));
      return false;
    }
    return true;
  });
  // onBinary: последовательности, непредставимые как UTF-16 строка (raw-байты).
  const binaryDisp = term.onBinary((s) => {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) bytes[i] = s.charCodeAt(i) & 0xff;
    sendData(bytes);
  });
  // Перекладка (fit / смена шрифта) → сообщаем агенту новые cols/rows.
  const resizeDisp = term.onResize(() => sendResize());

  // ── Панель быстрых клавиш ────────────────────────────────────────────
  const stepFont = (delta: number): void => {
    fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, fontSize + delta));
    term.options.fontSize = fontSize;
    try {
      localStorage.setItem(FONT_LS_KEY, String(fontSize));
    } catch {
      // Персист размера необязателен.
    }
    doFit(); // → term.onResize → sendResize
  };

  // ── Панель поиска по буферу терминала (по кнопке ⌕) ──────────────────
  const searchBar = document.createElement('div');
  searchBar.className = 'th-term__search is-hidden';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'th-input';
  searchInput.autocomplete = 'off';
  searchInput.placeholder = t('term.searchPlaceholder');
  const searchClose = document.createElement('button');
  searchClose.type = 'button';
  searchClose.className = 'th-term__search-close';
  searchClose.textContent = '✕';
  searchClose.setAttribute('aria-label', t('common.close'));
  searchBar.append(searchInput, searchClose);
  body.append(searchBar);
  const closeSearch = (): void => {
    searchBar.classList.add('is-hidden');
    searchAddon.clearDecorations();
    term.focus();
  };
  const openSearch = (): void => {
    searchBar.classList.remove('is-hidden');
    searchInput.select();
    searchInput.focus();
  };
  searchClose.addEventListener('click', closeSearch);
  // Декорации обязательны для ВИДИМОЙ подсветки: без них find* лишь ставит невидимое
  // с WebGL-рендером выделение. Цвета берём под тему (акцент + жёлтый highlight).
  const searchOptions = {
    decorations: {
      matchBackground: 'rgba(210, 153, 34, 0.4)',
      matchOverviewRuler: '#d29922',
      activeMatchBackground: '#d29922',
      activeMatchColorOverviewRuler: cssVar('--accent', '#38d3a8'),
    },
  };
  const runSearch = (dir: 'next' | 'prev'): void => {
    const q = searchInput.value;
    if (!q) return;
    const found =
      dir === 'prev' ? searchAddon.findPrevious(q, searchOptions) : searchAddon.findNext(q, searchOptions);
    if (!found) toast(t('term.searchNotFound'), 'info');
  };
  searchInput.addEventListener('keydown', (e) => {
    // Enter — след. совпадение, Shift+Enter — предыдущее, Esc — закрыть.
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  });

  // ── Compose bar: нативное поле ввода (свайп/подсказки/автозамена работают) →
  // по Enter/Send отправляет строку в pty. Отдельно от терминальной textarea,
  // у которой предиктив выключен для надёжного посимвольного ввода. ──
  const compose = document.createElement('div');
  compose.className = 'th-compose';
  compose.hidden = !composeOpen; // видимость строки переживает переключение вкладок
  const composeInput = document.createElement('textarea');
  composeInput.className = 'th-compose__input';
  composeInput.rows = 1;
  composeInput.placeholder = t('compose.placeholder');
  composeInput.setAttribute('aria-label', t('compose.placeholder'));
  composeInput.setAttribute('enterkeyhint', 'send');
  const composeSend = document.createElement('button');
  composeSend.type = 'button';
  composeSend.className = 'th-compose__send';
  composeSend.textContent = '➤';
  composeSend.setAttribute('aria-label', t('compose.send'));
  // Автовысота textarea (до ~5 строк).
  const composeGrow = (): void => {
    composeInput.style.height = 'auto';
    composeInput.style.height = `${Math.min(composeInput.scrollHeight, 140)}px`;
  };

  // ── Compose bar в простом режиме ──
  // Живой двусторонний sync с терминалом отключён (работал плохо): текст живёт в
  // поле локально и уходит в pty только по отправке. Автоопределение строки
  // терминала и подстановка её обратно в поле убраны. Планируется переделать.

  // Отправка: переносы внутри черновика → ESC+CR (перенос в Claude, не submit),
  // затем финальный CR — сама отправка.
  const doCompose = (): void => {
    const out = composeInput.value.replace(/\n/g, '\x1b\r') + '\r';
    sendData(encoder.encode(out));
    composeInput.value = '';
    composeGrow();
    composeInput.focus();
  };

  composeSend.addEventListener('mousedown', (e) => e.preventDefault());
  composeSend.addEventListener('click', doCompose);
  composeInput.addEventListener('input', composeGrow);
  composeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      sendData(encoder.encode('\x1b')); // Esc — сразу в терминал
      return;
    }
    if (e.key === 'Enter') {
      // Как и в терминале: Shift+Enter — всегда перенос строки (textarea вставит \n,
      // при отправке станет ESC+CR), тумблер меняет только поведение чистого Enter.
      if (!e.shiftKey && enterSends) {
        e.preventDefault();
        doCompose();
      }
    }
  });
  compose.append(composeInput, composeSend);

  const panel = mountQuickKeys({
    // Фокус не трогаем: кнопки уже держат его через mousedown-preventDefault
    // (клавиатура не закрывается), а насильный term.focus() открывал бы её на
    // каждой стрелке даже при закрытой — ровно то, на что жаловались.
    onKey: (bytes) => sendData(bytes),
    onFontStep: stepFont,
    keyboardEnabled,
    onKeyboardToggle: (enabled) => {
      keyboardEnabled = enabled;
      writeKeyboardEnabled(enabled);
      applyKeyboardMode();
      // Включили — открываем клавиатуру сразу, выключили — прячем.
      if (enabled) term.focus();
      else term.textarea?.blur();
    },
    selectEnabled: false,
    onSelectToggle: (enabled) => applySelectMode(enabled),
    onSearch: openSearch,
    enterSendsEnabled: enterSends,
    onEnterSendsToggle: (enabled) => {
      enterSends = enabled;
      writeEnterSends(enabled);
    },
    composeEnabled: composeOpen,
    onComposeToggle: (enabled) => {
      composeOpen = enabled;
      compose.hidden = !enabled;
      if (enabled) composeInput.focus();
    },
    t,
  });
  // ── Тулбар: Holo-таббар СВЕРХУ (под вкладками сессий) + панель клавиш СНИЗУ (над
  // клавиатурой); «⋮» сворачивает оба в плавающую кнопку. Compose bar — ОТДЕЛЬНЫЙ
  // сосед: его видимость не зависит от сворачивания, ей управляет только тумблер ✎. ──
  let hideToolbar = (): void => {};
  const holobar = renderHoloBar({ active: 'term', session, transport, onHide: () => hideToolbar() });
  const holoWrap = document.createElement('div');
  holoWrap.className = 'th-slide th-slide--top';
  holoWrap.append(holobar);
  bar.after(holoWrap); // под вкладками сессий (сверху, выезжает вниз)

  const toolbars: HTMLElement[] = [holoWrap];
  if (!readOnly) {
    const panelWrap = document.createElement('div');
    panelWrap.className = 'th-slide th-slide--bottom';
    panelWrap.append(panel);
    screen.append(panelWrap); // панель клавиш — снизу (над клавиатурой), выезжает снизу
    screen.append(compose); // независим от тулбара (см. onComposeToggle)
    toolbars.push(panelWrap);
  }

  // Плавающая «⋮» (в теле терминала) — видна только когда тулбар свёрнут. ResizeObserver
  // на host сам пере-fit'ит терминал по кадрам анимации высоты панелей.
  hideToolbar = wireToolbar({ toolbars, floatMount: body, onChange: doFit }).hide;

  // ── Подгонка под видимую область (клавиатура телефона) ───────────────
  const vv = window.visualViewport;
  let rafId = 0;
  const reposition = (): void => {
    if (vv) {
      // Экран точно по видимой области: панель клавиш встаёт над клавиатурой,
      // тело терминала получает ровно оставшуюся высоту (offsetTop+height).
      screen.style.height = `${vv.height}px`;
      screen.style.transform = `translateY(${vv.offsetTop}px)`;
    }
    doFit();
  };
  const scheduleFit = (): void => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      reposition();
    });
  };
  const ro = new ResizeObserver(scheduleFit);
  ro.observe(host);
  window.addEventListener('resize', scheduleFit);
  vv?.addEventListener('resize', scheduleFit);
  vv?.addEventListener('scroll', scheduleFit);

  // Первичная раскладка (соединение уже стартовало в transport.openTerm).
  reposition();

  return {
    focus: () => term.focus(),
    teardown: (): void => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener('resize', scheduleFit);
      vv?.removeEventListener('resize', scheduleFit);
      vv?.removeEventListener('scroll', scheduleFit);
      dataDisp.dispose();
      binaryDisp.dispose();
      resizeDisp.dispose();
      selectionDisp.dispose();
      host.removeEventListener('mousedown', onSelectionStart);
      host.removeEventListener('mouseup', onSelectionEnd);
      stopTouchScroll?.();
      stopTouchSelect?.();
      tabs.teardown();
      dropPending();
      channel?.close();
      channel = null;
      try {
        term.dispose();
      } catch {
        // повторный dispose безопасен
      }
      root.replaceChildren();
      resetDocumentTitle();
    },
  };
}
