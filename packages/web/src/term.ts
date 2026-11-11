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
  terminalModeLetter,
  terminalModeName,
  terminalModeRequest,
} from './term-mode';
import { markBellSeen, recordBell, unseenBellCount } from './bell-seen';
import { updateAppBadge } from './app-badge';
import { detectPaths, filePathParts, parentRel } from './termlinks';
import { filesHash, sfilesHash, termHash } from './routes';
import { resolveSessionPath } from './session-path';
import { enableTouchScroll } from './touch-scroll';
import { enableTouchSelect } from './touch-select';
import { playBell } from './sound';
import { onTermPrefsChange, readTermPrefs, setTermPrefs, termFontFamily, termIsLight } from './term-prefs';
import { openTermSettings } from './term-settings';
import type { TerminalMode, TermChannel, TermConnState, Transport } from './transport';
import { copyToClipboard, hasServerPicker, iconButton, openServerPicker, renderHoloBar, spinner, svgIcon, toast, wireToolbar } from './ui';

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
// Тёмные black/brightBlack подобраны под «мягкий» фон (#1a2029): тусклый текст держит
// контраст ≈4,9 на нём и не слепит на тёмном (#0d1117).
const DARK_ANSI: Partial<ITheme> = {
  black: '#545d68', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#848d97', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
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

/** Claude Code и Codex красят вывод своими truecolor-цветами под тёмный терминал: белые
 *  маркеры и бледно-голубые ссылки на светлом фоне пропадают. В светлой теме xterm сам
 *  дотягивает такой текст до читаемого контраста; в тёмной цвета идут как есть. */
function minContrast(): number {
  return termIsLight() ? 4.5 : 1;
}

/** Тема xterm из палитры приложения (совпадает с чромом в light/dark). */
function xtermTheme(): ITheme {
  const light = termIsLight();
  const background = cssVar('--term-bg', light ? '#f0f2f5' : '#1a2029');
  const accent = cssVar('--accent', light ? '#16b790' : '#38d3a8');
  return {
    background,
    foreground: cssVar('--term-fg', light ? '#1f2328' : '#e6edf3'),
    cursor: accent,
    cursorAccent: background,
    selectionBackground: cssVar('--accent-tint', 'rgba(56, 211, 168, 0.25)'),
    ...(light ? LIGHT_ANSI : DARK_ANSI),
  };
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
export function mountTerminal(
  root: HTMLElement,
  session: string,
  transport: Transport,
  opts: { embedded?: boolean } = {},
): TerminalHandle {
  // Встроенный терминал (панель сплит-вида): только сам экран — без шапки с вкладками,
  // полосы разделов и панели клавиш; заголовком окна и размером экрана владеет сплит.
  const embedded = opts.embedded === true;
  root.replaceChildren();
  if (!embedded) setSessionDocumentTitle(session, session);
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
  const tabs = embedded ? null : mountSessionTabs({
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
    else await tabs?.refresh();
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

  const modeBtn = document.createElement('button');
  modeBtn.type = 'button';
  modeBtn.className = 'th-termbar__mode';
  const syncMode = (): void => {
    // Видно букву, слово целиком — в подсказке: шапка узкая, а режимов всего два.
    modeBtn.textContent = activeMode ? terminalModeLetter(activeMode) : '—';
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
  // Пометка экрана и показанный режим живут ровно одним подключением: оба знает только
  // агент и оба приходят кадром состояния. Пережить смену канала им нельзя — иначе
  // «включён» от терминала, открытого до перезапуска агента, горит над новой сессией,
  // которой оно не касается. Поэтому каждое подключение начинает с «агент ещё ничего
  // не называл», а зажечь пометку и назвать режим вправе только пришедший следом кадр.
  let paneSize: { cols: number; rows: number } | undefined;
  const forgetAgentState = (): void => {
    setAltScreen(false);
    activeMode = undefined;
    paneSize = undefined;
    sentSize = ''; // новому терминалу агента размер ещё не называли
    syncMode();
  };
  modeBtn.addEventListener('click', () => {
    requestedMode = otherTerminalMode(requestedMode);
    setTerminalModeRequest(requestedMode);
    syncMode();
    toast(t('term.modeNext', { mode: terminalModeName(requestedMode) }));
  });

  const dot = document.createElement('span');
  dot.className = 'th-conn-dot';
  dot.setAttribute('role', 'status');
  // Глобус, окрашенный состоянием связи: он же открывает выбор сервера, когда тот есть.
  dot.append(svgIcon('globe'));
  // «⋮» (показать свёрнутые панели) и ползунки (вид терминала) живут в шапке, а не поверх
  // вывода: плавающая кнопка в углу закрывала текст.
  const toggleSlot = document.createElement('span');
  toggleSlot.className = 'th-termbar__slot';
  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'th-termbar__view';
  viewBtn.append(svgIcon('sliders'));
  viewBtn.title = t('termview.title');
  viewBtn.setAttribute('aria-label', t('termview.title'));
  viewBtn.addEventListener('mousedown', (e) => e.preventDefault());
  viewBtn.addEventListener('click', () => openTermSettings());
  bar.append(...(tabs ? [tabs.el] : []), toggleSlot, viewBtn, modeBtn, dot);
  if (!embedded) screen.append(bar);

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
  /** Полноэкранное приложение забрало альтернативный экран: истории у него нет, и ползунок
   *  библиотеки над ним обещает прокрутку, которой не существует. Прячем его вместе с
   *  зажжённой пометкой — одним переключателем, чтобы они не разъехались. */
  function setAltScreen(on: boolean): void {
    // Видимой пометки у этого состояния больше нет — историю беседы показывает
    // лента. Признак остаётся ради ползунка: листать в альтернативном экране нечего.
    host.classList.toggle('is-alt', on);
  }
  body.append(host);
  screen.append(body);

  root.append(screen);

  // ── xterm ────────────────────────────────────────────────────────────
  let prefs = readTermPrefs();
  const term = new Terminal({
    fontFamily: termFontFamily(prefs.font, cssVar('--font-mono', 'monospace')),
    fontSize: prefs.fontSize,
    lineHeight: prefs.lineHeight,
    minimumContrastRatio: minContrast(),
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
  // Касание или клик по терминалу — тоже работа здесь (см. claimSize).
  const onPointerClaim = (): void => claimSize();
  host.addEventListener('pointerdown', onPointerClaim);
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

  // Мобильный скролл: в обычном буфере тач-драг листает историю через term.scrollLines,
  // в alt-screen — транслируется в wheel на корне xterm (touch xterm в приложение не
  // форвардит; touch-action:none в CSS не даёт жесту утечь в страницу/pull-to-refresh).
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

  // Два размера. `wanted` — под свой контейнер: его клиент просит у агента. `paneSize` —
  // размер панели, который называет агент в control mode: tmux там НЕ подгоняет вывод под
  // клиента, и размер окна держит один клиент — тот, с которым работали последним
  // (системный терминал, второй браузер, телефон). Экран обязан быть размера панели —
  // иначе вывод ложится со сдвигом и переносами. Пока размер чужой, экран показан
  // зеркалом (fitForeign), а действие здесь забирает размер себе (claimSize).
  let wanted = { cols: term.cols, rows: term.rows };
  let sentSize = '';
  const sendResize = (): void => {
    sentSize = `${wanted.cols}x${wanted.rows}`;
    channel?.resize(wanted.cols, wanted.rows);
  };
  /** Размер панели не наш: его держит другой клиент — тот, с которым работали последним. */
  const foreignSize = (): boolean =>
    paneSize !== undefined && (paneSize.cols !== wanted.cols || paneSize.rows !== wanted.rows);
  /** Пока размер чужой, этот экран — зеркало: чужая панель больше контейнера, и без
   *  уменьшения был бы виден только её левый верхний угол (у полноэкранного приложения
   *  там пусто, всё содержимое внизу). Поэтому экран целиком вписывается в контейнер
   *  масштабом; первое же действие здесь забирает размер себе (claimSize), и масштаб уходит. */
  const fitForeign = (): void => {
    const xt = term.element;
    if (!xt) return;
    const screenEl = xt.querySelector<HTMLElement>('.xterm-screen');
    const sw = screenEl?.offsetWidth ?? 0;
    const sh = screenEl?.offsetHeight ?? 0;
    const k = foreignSize() && sw > 0 && sh > 0 ? Math.min(1, host.clientWidth / sw, host.clientHeight / sh) : 1;
    if (k < 1) {
      xt.style.width = `${sw}px`;
      xt.style.height = `${sh}px`;
      xt.style.transformOrigin = '0 0';
      xt.style.transform = `scale(${k})`;
    } else {
      xt.style.width = '';
      xt.style.height = '';
      xt.style.transform = '';
    }
  };
  /** Действие пользователя на этом экране: размер задаёт тот клиент, с которым работают.
   *  Просьба уходит заново — агент делает нас «последним» клиентом tmux, и панель
   *  принимает наш размер. Не чаще раза в секунду: панель могла не принять размер
   *  (пределы агента), и каждое нажатие иначе слало бы просьбу. */
  let lastClaim = 0;
  const claimSize = (): void => {
    if (!connected || readOnly || !foreignSize()) return;
    const now = performance.now();
    if (now - lastClaim < 1000) return;
    lastClaim = now;
    sendResize();
  };
  const doFit = (): void => {
    try {
      const dims = fit.proposeDimensions();
      // Контейнер ещё не измерить — остаётся прежняя просьба: брать её с экрана нельзя,
      // он может держать чужой размер панели.
      if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) wanted = { cols: dims.cols, rows: dims.rows };
      const use = paneSize ?? wanted;
      if (term.cols !== use.cols || term.rows !== use.rows) term.resize(use.cols, use.rows);
    } catch {
      // Контейнер ещё без размеров (не в DOM / скрыт) — ретраит следующий resize.
    }
    fitForeign();
    requestAnimationFrame(fitForeign); // размеры холста xterm обновляет к следующему кадру
    // Экран держит размер панели, а контейнер сменился: onResize не сработает, просим сами.
    // Первый RESIZE подключения шлёт onStatus (он обязан быть первым кадром) — не здесь.
    if (connected && sentSize !== '' && sentSize !== `${wanted.cols}x${wanted.rows}`) sendResize();
  };

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
    markBellSeen(session);
    updateAppBadge(unseenBellCount());
    if (readOnly) return;
    if (connected) {
      claimSize(); // ввод здесь — значит, работают здесь
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
    onBell: () => {
      if (disposed) return;
      recordBell(session);
      updateAppBadge(unseenBellCount());
      playBell();
    },
    onTerminalState: (state) => {
      if (disposed) return;
      // Поля независимы: пришло одно — второе не трогаем.
      if (state.mode) {
        activeMode = state.mode;
        noteTerminalMode(state.mode);
        syncMode();
      }
      if (state.altScreen !== undefined) setAltScreen(state.altScreen);
      if (state.cols !== undefined && state.rows !== undefined) {
        paneSize = { cols: state.cols, rows: state.rows };
        doFit();
      }
    },
    onStatus: (state) => {
      if (disposed) return;
      setDot(state);
      connected = state === 'connected';
      if (state === 'connected') {
        // Новое подключение — новый терминал у агента: всё, что он называл прошлому,
        // здесь недействительно (см. forgetAgentState).
        forgetAgentState();
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
  // Только когда сменилась НАША просьба: экран меняет размер и вслед за панелью, а
  // повторять просьбу на каждую такую смену нельзя — два клиента tmux начали бы
  // перетягивать размер окна друг у друга на каждое нажатие.
  const resizeDisp = term.onResize(() => {
    if (connected && sentSize !== `${wanted.cols}x${wanted.rows}`) sendResize();
  });

  // ── Панель быстрых клавиш ────────────────────────────────────────────
  // Вид (шрифт, интервал, фон) меняет окно «Вид терминала»: оно пишет в term-prefs, а
  // терминал перестраивается здесь.
  const offPrefs = onTermPrefsChange((next) => {
    prefs = next;
    term.options.fontFamily = termFontFamily(next.font, cssVar('--font-mono', 'monospace'));
    term.options.fontSize = next.fontSize;
    term.options.lineHeight = next.lineHeight;
    term.options.theme = xtermTheme();
    term.options.minimumContrastRatio = minContrast();
    doFit(); // → term.onResize → sendResize
  });

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

  const floatingKeyboard = iconButton('keyboard', t('quickkeys.keyboard'), () => {
    panel.querySelector<HTMLButtonElement>('.th-qk__keyboard')?.click();
  });
  floatingKeyboard.className = 'th-term__toolbar-toggle th-term__keyboard-toggle';
  floatingKeyboard.addEventListener('mousedown', (e) => e.preventDefault());
  const syncFloatingKeyboard = (): void => {
    floatingKeyboard.setAttribute('aria-pressed', String(keyboardEnabled));
    floatingKeyboard.classList.toggle('is-off', !keyboardEnabled);
  };
  syncFloatingKeyboard();
  const panel = mountQuickKeys({
    // Фокус не трогаем: кнопки уже держат его через mousedown-preventDefault
    // (клавиатура не закрывается), а насильный term.focus() открывал бы её на
    // каждой стрелке даже при закрытой — ровно то, на что жаловались.
    onKey: (bytes) => sendData(bytes),
    keyboardEnabled,
    onKeyboardToggle: (enabled) => {
      keyboardEnabled = enabled;
      syncFloatingKeyboard();
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
  if (!embedded) {
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
    hideToolbar = wireToolbar({ toolbars, floatMount: body, toggleMount: toggleSlot, collapsedControls: readOnly ? [] : [floatingKeyboard], onChange: doFit }).hide;
  }

  // ── Подгонка под видимую область (клавиатура телефона) ───────────────
  const vv = window.visualViewport;
  let rafId = 0;
  const reposition = (): void => {
    if (vv && !embedded) {
      // Экран точно по видимой области: панель клавиш встаёт над клавиатурой,
      // тело терминала получает ровно оставшуюся высоту (offsetTop+height).
      screen.style.height = `${vv.height}px`;
      screen.style.transform = `translateY(${vv.offsetTop}px)`;
    }
    doFit();
  };
  // Досылка размера. Смена видимой области (клавиатура телефона, поворот, показ вкладки)
  // идёт серией событий, и одна потерянная или обогнанная в пути просьба оставляет агенту
  // прежний размер: tmux рисует в меньшую область, а ниже остаётся старая картинка. Через
  // треть секунды после последнего события размер меряется заново и уходит ещё раз — даже
  // если с точки зрения клиента он уже был отправлен. Повтор безвреден: тот же размер
  // агент применяет без последствий.
  let resendTimer: ReturnType<typeof setTimeout> | undefined;
  const resendSoon = (): void => {
    if (resendTimer) clearTimeout(resendTimer);
    resendTimer = setTimeout(() => {
      resendTimer = undefined;
      if (disposed || !connected) return;
      doFit();
      sendResize();
    }, 350);
  };
  const scheduleFit = (): void => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      reposition();
      resendSoon();
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
      offPrefs();
      if (rafId) cancelAnimationFrame(rafId);
      if (resendTimer) clearTimeout(resendTimer);
      ro.disconnect();
      window.removeEventListener('resize', scheduleFit);
      vv?.removeEventListener('resize', scheduleFit);
      vv?.removeEventListener('scroll', scheduleFit);
      dataDisp.dispose();
      binaryDisp.dispose();
      resizeDisp.dispose();
      selectionDisp.dispose();
      host.removeEventListener('mousedown', onSelectionStart);
      host.removeEventListener('pointerdown', onPointerClaim);
      host.removeEventListener('mouseup', onSelectionEnd);
      stopTouchScroll?.();
      stopTouchSelect?.();
      tabs?.teardown();
      dropPending();
      channel?.close();
      channel = null;
      try {
        term.dispose();
      } catch {
        // повторный dispose безопасен
      }
      root.replaceChildren();
      if (!embedded) resetDocumentTitle();
    },
  };
}
