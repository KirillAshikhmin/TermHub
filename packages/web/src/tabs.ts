// Полоса табов активных сессий в шапке терминала: переключение между
// tmux-сессиями без возврата на дашборд. Чистые рендеры (тестируются
// отдельно) + mountSessionTabs, владеющий поллингом списка через транспорт.

import { noteOverlayClosed } from './overlay-events';
import type { SessionInfo } from '@termhub/protocol';

import type { TFn } from './i18n';
import { t } from './i18n';
import { setSessionDocumentTitle } from './document-title';
import type { TermConnState, Transport } from './transport';
import { hasServerPicker, iconButton, openServerPicker, renderMenu, sortSelect, svgIcon, toast } from './ui';
import { openRenameModal, renderSessionCard } from './dashboard';
import { moveInOrder, readManualOrder, readSortMode, sortSessions, writeManualOrder } from './session-sort';
import { activity } from './activity';
import { sessionByOutput, sessionTitleText, sessionWorking } from './session-status';
import {
  AGENT_MARK,
  clearGroupHeaders,
  groupSessions,
  sessionGroup,
  syncGroupHeaders,
  syncSessionHead,
  type SessionHeadInfo,
} from './session-view';

export { AGENT_MARK, groupSessions, sessionGroup };
import { bellUnseen, markBellSeen, observeBells, onBellChange, unseenBellCount } from './bell-seen';
import { updateAppBadge } from './app-badge';
import { hasCap } from './capabilities';
import { openFeedSearch } from './feed-search-all';
import { previewOf, refreshPreviews } from './session-preview';
import { openPalette, type PaletteItem } from './palette';
import { sfeedHash, sfilesHash, srepoHash, splitHash, termHash } from './routes';
import { isDesktop, onTermPrefsChange, readTermPrefs } from './term-prefs';
import { openTermSettings } from './term-settings';
import { openUsage } from './usage';

const POLL_INTERVAL = 3000;

// Последний известный список сессий, переживающий пере-монтирование экрана.
// Переключение вкладки меняет hash → экран терминала собирается заново, и без кэша
// полоса каждый раз схлопывалась до одной текущей вкладки, а остальные возвращались
// только после первого полла (до трёх секунд мигания). WeakMap — чтобы кэш уходил
// вместе с транспортом, а не держал его живым.
const tabsCache = new WeakMap<Transport, SessionInfo[]>();

/** Сосед для перехода при закрытии текущей вкладки: тот, что был слева; если
 *  закрыли самую левую — новый первый (сосед справа). null, если вкладок не
 *  осталось (тогда вызывающий уходит на дашборд). */
export function pickNeighbor(names: string[], removed: string): string | null {
  const rest = names.filter((n) => n !== removed);
  if (rest.length === 0) return null;
  const i = names.indexOf(removed);
  return names[i - 1] ?? rest[0]!;
}

/** Кнопки шапки сессии, не привязанные к самому терминалу: шестерёнка настроек и статус
 *  подключения. Одни на терминал и на чат — вторую разметку не заводить. */
export function sessionBarTools(session: string): {
  settings: HTMLButtonElement;
  conn: HTMLElement;
  setConn: (state: TermConnState) => void;
} {
  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'th-termbar__view';
  settings.append(svgIcon('gear'));
  settings.title = t('termview.title');
  settings.setAttribute('aria-label', t('termview.title'));
  settings.addEventListener('mousedown', (e) => e.preventDefault());
  settings.addEventListener('click', () => openTermSettings({ session }));

  const conn = document.createElement('span');
  conn.className = 'th-conn-dot';
  conn.setAttribute('role', 'status');
  // Глобус, окрашенный состоянием связи: он же открывает выбор сервера, когда тот есть
  // (в LAN-режиме выбирать не из чего — там он остаётся просто индикатором).
  conn.append(svgIcon('globe'));
  if (hasServerPicker()) {
    conn.classList.add('is-clickable');
    conn.setAttribute('role', 'button');
    conn.tabIndex = 0;
    conn.addEventListener('click', () => openServerPicker());
    conn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openServerPicker();
      }
    });
  }
  const setConn = (state: TermConnState): void => {
    conn.classList.remove('is-connected', 'is-reconnecting', 'is-closed');
    conn.classList.add(`is-${state}`);
    const label =
      state === 'connected'
        ? t('term.statusConnected')
        : state === 'reconnecting'
          ? t('term.statusReconnecting')
          : t('term.statusClosed');
    conn.setAttribute('aria-label', label);
    conn.title = label;
  };
  return { settings, conn, setConn };
}

/** Верхняя панель сессии (как на терминале): «назад» + вкладки сессий. Переиспользуется
 *  на session-scoped Проводнике/Репозитории, чтобы панель сессий была на любой вкладке.
 *  onSwitch — навигация при клике на таб (тип экрана задаёт вызывающий). */
export function mountSessionBar(opts: {
  transport: Transport;
  current: string;
  onSwitch: (name: string) => void;
  /** Нажали на вкладку текущей сессии (вид остаётся прежним). */
  onCurrent?: () => void;
  onCreate: () => void;
  /** Шестерёнка настроек и статус подключения — как в шапке терминала (вид «Чат»). */
  tools?: boolean;
}): { el: HTMLElement; toggleSlot: HTMLElement; setConn: (state: TermConnState) => void; teardown: () => void } {
  const bar = document.createElement('div');
  bar.className = 'th-termbar';
  bar.append(iconButton('back', t('term.back'), () => (location.hash = '#/')));
  const tabs = mountSessionTabs({
    transport: opts.transport,
    current: opts.current,
    onSwitch: opts.onSwitch,
    onCurrent: opts.onCurrent,
    onKill: async (name) => {
      if (!confirm(t('card.confirmKill', { name }))) return;
      try {
        await opts.transport.kill(name);
      } catch {
        toast(t('card.killError'), 'error');
        return;
      }
      if (name === opts.current) location.hash = '#/';
      else await tabs.refresh();
    },
    onCreate: opts.onCreate,
    onCurrentTitle: (title) => setSessionDocumentTitle(title, opts.current),
  });
  // Место под «⋮» (показать свёрнутую полосу разделов): в шапке, а не поверх содержимого.
  const toggleSlot = document.createElement('span');
  toggleSlot.className = 'th-termbar__slot';
  bar.append(tabs.el, toggleSlot);
  let setConn: (state: TermConnState) => void = () => {};
  if (opts.tools) {
    const tools = sessionBarTools(opts.current);
    bar.append(tools.settings, tools.conn);
    setConn = tools.setConn;
  }
  return { el: bar, toggleSlot, setConn, teardown: tabs.teardown };
}

/** Минимум, который нужен табу от сессии (SessionInfo подходит структурно). */
export type TabInfo = SessionHeadInfo;

/** Чистый рендер таба сессии: кнопка-имя (переключение) + крестик (завершить). */
export function renderSessionTab(
  info: TabInfo,
  active: boolean,
  translate: TFn,
  onSwitch: (name: string) => void,
  onKill: (name: string) => void,
  showActivity = false,
): HTMLElement {
  const tab = document.createElement('div');
  tab.className = 'th-tab';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'th-tab__btn';
  // Тап по вкладке не должен уводить фокус с textarea xterm (на телефоне это закрывает
  // экранную клавиатуру ещё до смены экрана) — тот же приём, что у быстрых клавиш.
  main.addEventListener('mousedown', (e) => e.preventDefault());
  main.addEventListener('click', () => {
    markBellSeen(info.name);
    updateAppBadge(unseenBellCount());
    onSwitch(info.name);
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'th-tab__close';
  close.setAttribute('aria-label', `${translate('card.kill')}: ${info.name}`);
  close.title = translate('card.kill');
  close.textContent = '×';
  close.addEventListener('click', () => onKill(info.name));
  tab.append(main, close);
  updateSessionTab(tab, info, active, translate, showActivity);
  return tab;
}

/** Обновляет таб на месте: активность и непрочитанный звонок видны независимо друг от друга. */
export function updateSessionTab(
  tab: HTMLElement,
  info: TabInfo,
  active: boolean,
  translate: TFn,
  showActivity = false,
): void {
  tab.classList.toggle('is-active', active);
  tab.classList.toggle('has-bell', info.bell);
  const main = tab.querySelector<HTMLElement>('.th-tab__btn');
  if (!main) return;
  main.setAttribute('aria-current', active ? 'true' : 'false');
  // Вкладка — компактный вид сессии: одна шапка (session-view), без подробностей.
  const agent = syncSessionHead(main, 'th-tab', info, translate, showActivity);
  if (agent) tab.dataset.agent = agent;
  else delete tab.dataset.agent;
}

export interface SessionTabsOpts {
  transport: Transport;
  /** Имя текущей сессии: её таб существует с первого кадра и не удаляется,
   *  даже когда сессия пропала из списка (конец показывает оверлей терминала). */
  current: string;
  onSwitch(name: string): void;
  /** Нажали на текущую сессию (вкладка, боковая панель, панель по стрелке): открытый вид
   *  остаётся каким был, onSwitch не зовётся. Терминал возвращает себе фокус. */
  onCurrent?(): void;
  /** Завершение сессии по крестику (подтверждение — на вызывающей стороне). */
  onKill(name: string): void;
  onCreate(): void;
  /** Содержательная подпись текущей сессии для внешнего browser/PWA title. */
  onCurrentTitle?(title: string): void;
}

/** Полоса табов с поллингом; el вставляется в шапку, teardown останавливает
 *  поллинг, refresh форсирует перечитывание (например, после kill). */
export function mountSessionTabs(opts: SessionTabsOpts): {
  el: HTMLElement;
  teardown(): void;
  refresh(): Promise<void>;
} {
  const wrap = document.createElement('div');
  wrap.className = 'th-tabs-wrap';
  const strip = document.createElement('div');
  strip.className = 'th-tabs';
  strip.setAttribute('aria-label', t('term.tabs'));

  // ── Полноэкранная панель быстрого переключения сессий ──────────────────────
  // Кнопка-стрелка разворачивает список ВСЕХ сессий на весь экран (крупные цели для
  // тапа с телефона), снизу — «Создать сессию». Стрелка поворачивается на 180°,
  // оставаясь на месте, и повторным нажатием закрывает панель.
  // Снимок полного списка: панель рисует из него карточки дашборда, поэтому нужны
  // все поля SessionInfo, а не только те, что требует таб.
  let latest: SessionInfo[] = [];
  let panelOpen = false;
  // Единственный вход перехода из полосы, боковой панели и панели по стрелке. Нажатие на
  // уже открытую сессию — не переход: адрес вкладки ведёт на вход в сессию, и из чата он
  // увёл бы на терминал (вход решает вид только для вновь открытой сессии).
  const switchTo = (name: string): void => {
    if (name === opts.current) opts.onCurrent?.();
    else opts.onSwitch(name);
  };
  // Порядок общий с дашбордом (session-sort): «третья сверху» означает одно и то же
  // на главной, в панели и в полосе вкладок.
  let sortMode = readSortMode();

  const panel = document.createElement('div');
  panel.className = 'th-spanel';
  const sheet = document.createElement('div');
  sheet.className = 'th-spanel__sheet';
  // Шапка окна: название, порядок и крестик. Окно закрывается без выбора сессии —
  // крестиком, Esc или кликом по затемнению под ним.
  const sortBar = document.createElement('div');
  sortBar.className = 'th-spanel__head';
  const panelTitle = document.createElement('h2');
  panelTitle.className = 'th-spanel__title';
  panelTitle.textContent = t('term.tabs');
  sortBar.append(
    panelTitle,
    sortSelect(readSortMode(), (mode) => {
      sortMode = mode;
      buildPanelRows();
      render(latest); // полоса вкладок идёт в том же порядке
    }),
    iconButton('close', t('common.close'), () => closePanel()),
  );
  const list = document.createElement('div');
  list.className = 'th-spanel__list th-grid';
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'th-btn th-btn--primary th-spanel__create';
  createBtn.append(svgIcon('plus'), document.createTextNode(t('dashboard.newSession')));
  // Создание сессий — только владельцу. Для relay scope известен после первого list();
  // до него прячем (mode==='relay'), иначе «+» мигнул бы гостю. render() ниже выставит
  // финальное состояние по transport.clientScope.
  createBtn.hidden = opts.transport.mode === 'relay';
  createBtn.addEventListener('click', () => {
    closePanel();
    opts.onCreate();
  });
  // Полоса действий под шапкой окна: поиск по лентам, расход, настройки, уведомления и
  // остальное из меню главной. На телефоне в шапке сессии этим кнопкам нет места (там
  // только стрелка, настройки и связь), а в боковом режиме на десктопе они уже в шапке —
  // там полосу прячет CSS. Строится при первом открытии окна: пункты спрашивают агента.
  const panelTools = document.createElement('div');
  panelTools.className = 'th-spanel__tools';
  let panelMenu: { el: HTMLElement; teardown: () => void } | null = null;
  const ensurePanelMenu = (): void => {
    if (panelMenu) return;
    panelMenu = renderMenu(opts.transport, undefined, 'strip');
    // Действие открывает своё окно — окно сессий под ним закрываем; тумблеры оставляют.
    panelMenu.el.addEventListener('click', (e) => {
      const item = e.target instanceof Element ? e.target.closest<HTMLElement>('.th-menu__item') : null;
      if (item && !('keep' in item.dataset)) closePanel();
    });
    panelTools.append(panelMenu.el);
  };
  sheet.append(sortBar, panelTools, list, createBtn);
  panel.append(sheet);
  panel.inert = true; // стартовое состояние — закрыта
  panel.addEventListener('click', (e) => {
    if (e.target === panel) closePanel(); // тап по затемнённому фону закрывает
  });
  // Escape закрывает панель (ожидаемое поведение оверлея).
  // Ctrl+Alt+1…9 — вкладка по номеру (9 — последняя), Ctrl+Alt+←/→ — соседняя по кругу.
  // Сочетание выбрано свободным и от браузера (Ctrl/Cmd+цифра — его вкладки), и от
  // терминала (Alt+цифра уходит в TUI как Meta). Смотрим `code`, а не `key`: Option на
  // macOS меняет печатаемый символ.
  let order: string[] = [];
  const hotkeyTarget = (e: KeyboardEvent): string | undefined => {
    if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey || order.length === 0) return undefined;
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) return digit[1] === '9' ? order[order.length - 1] : order[Number(digit[1]) - 1];
    if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return undefined;
    const at = order.indexOf(opts.current);
    const step = e.code === 'ArrowLeft' ? -1 : 1;
    return order[(Math.max(at, 0) + step + order.length) % order.length];
  };
  /** Сессии, ждущие внимания (звонок или конец работы, который ещё не смотрели), кроме текущей. */
  const waiting = (): string[] => order.filter((name) => name !== opts.current && bellUnseen(name));
  /** Следующая ждущая — по порядку вкладок после текущей, по кругу. */
  const nextWaiting = (): string | undefined => {
    const names = waiting();
    const at = order.indexOf(opts.current);
    return names.find((name) => order.indexOf(name) > at) ?? names[0];
  };
  const goNextWaiting = (): void => {
    const name = nextWaiting();
    if (name) opts.onSwitch(name);
  };
  const paletteItems = (): PaletteItem[] => {
    const items: PaletteItem[] = [];
    const next = nextWaiting();
    if (next) items.push({ label: t('palette.nextWaiting'), hint: next, run: goNextWaiting });
    for (const s of latest) {
      if (s.name === opts.current) continue;
      const title = sessionTitleText(s.title);
      const flag = bellUnseen(s.name) ? '🔔 ' : '';
      items.push({ label: flag + (title || s.name), hint: title ? s.name : undefined, hash: termHash(s.name) });
    }
    // Сплит-вид: текущая сессия и выбранная рядом.
    for (const s of latest) {
      if (s.name === opts.current) continue;
      const title = sessionTitleText(s.title);
      items.push({
        label: t('split.beside', { name: title || s.name }),
        hint: title ? s.name : undefined,
        hash: splitHash([opts.current, s.name]),
      });
    }
    const scope = opts.transport.clientScope;
    items.push({ label: t('holo.session'), hint: opts.current, hash: termHash(opts.current) });
    if (!scope || scope.files) {
      items.push({ label: t('nav.files'), hint: opts.current, hash: sfilesHash(opts.current, '') });
      items.push({ label: t('nav.repo'), hint: opts.current, hash: srepoHash(opts.current, '') });
    }
    if (hasCap('feed')) {
      items.push({ label: t('holo.feed'), hint: opts.current, hash: sfeedHash(opts.current) });
      items.push({ label: t('feedall.title'), run: () => openFeedSearch(opts.transport) });
    }
    if (hasCap('usage')) items.push({ label: t('usage.title'), run: () => openUsage(opts.transport) });
    if (!scope) items.push({ label: t('dashboard.newSession'), run: opts.onCreate });
    items.push({ label: t('termview.title'), run: openTermSettings });
    items.push({ label: t('palette.dashboard'), hash: '#/' });
    return items;
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && panelOpen) {
      e.preventDefault();
      closePanel();
      return;
    }
    // Палитра: Ctrl+Alt+K (и ⌘K). Голый Ctrl+K занят оболочкой — «стереть до конца строки».
    const combo = e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey;
    const cmdK = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (e.code === 'KeyK' && (combo || cmdK)) {
      e.preventDefault();
      e.stopPropagation();
      if (!document.querySelector('.th-palette')) openPalette(paletteItems());
      return;
    }
    // Ctrl+Alt+↓ — к следующей сессии, ждущей внимания.
    if (combo && e.code === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      goNextWaiting();
      return;
    }
    const target = hotkeyTarget(e);
    if (target === undefined) return;
    // Перехват на capture: иначе сочетание успеет уйти в терминал вводом.
    e.preventDefault();
    e.stopPropagation();
    if (target !== opts.current) opts.onSwitch(target);
  };
  document.addEventListener('keydown', onKeyDown, true);

  const expandBtn = iconButton('down', t('term.sessionsPanel'), () => (panelOpen ? closePanel() : openPanel()));
  expandBtn.classList.add('th-tabs-expand');
  expandBtn.setAttribute('aria-haspopup', 'true');
  expandBtn.setAttribute('aria-expanded', 'false');

  // Панель показывает РОВНО те же карточки, что и дашборд (renderSessionCard) — с
  // точкой активности, звонком, каталогом, командой, временем и меню
  // переименования/завершения. Раньше здесь был свой упрощённый список строк, и он
  // расходился с главным экраном по составу и по порядку.
  const buildPanelRows = (): void => {
    list.replaceChildren();
    const now = Date.now();
    // Текущая сессия присутствует всегда (как и в полосе), даже если её нет в списке.
    const rows = latest.some((s) => s.name === opts.current)
      ? latest
      : [{ name: opts.current, bell: false, title: '', path: '', command: '', activityTs: now, attached: 0 }, ...latest];
    const guest = opts.transport.clientScope != null;
    // Тот же вид, что на главной: по проектам, с заголовками групп.
    const shown = groupSessions(sortSessions(rows, sortMode, bellUnseen, readManualOrder()));
    const visible = shown.map((x) => x.name);
    const cardOf = new Map<string, HTMLElement>();
    const move = (name: string, delta: -1 | 1): void => {
      writeManualOrder(moveInOrder(readManualOrder(), visible, name, delta));
      buildPanelRows();
      render(latest); // полоса вкладок идёт в том же порядке
    };
    for (const s of shown) {
      const hot = sessionWorking(s.title) || (sessionByOutput(s.title) && activity.isHot(s.name));
      // 🔔 — только пока звонок «не прочитан»; у текущей сессии он всегда прочитан.
      const info = { ...s, bell: bellUnseen(s.name) };
      const card = renderSessionCard(info, t, {
        now,
        showActivity: hot,
        preview: previewOf(opts.transport, s.name),
        onOpen: () => {
          closePanel();
          switchTo(s.name);
        },
        // Управление — только владельцу, как и на дашборде.
        onKill: guest ? undefined : () => opts.onKill(s.name),
        onRename: guest
          ? undefined
          : () =>
              openRenameModal(opts.transport, s.name, () => {
                void refresh();
                if (panelOpen) buildPanelRows();
              }),
        onMoveUp: guest || sortMode !== 'manual' ? undefined : () => move(s.name, -1),
        onMoveDown: guest || sortMode !== 'manual' ? undefined : () => move(s.name, 1),
      });
      if (s.name === opts.current) card.classList.add('is-current');
      cardOf.set(s.name, card);
      list.append(card);
    }
    syncGroupHeaders(list, visible, (name) => cardOf.get(name));
  };
  function closePanel(): void {
    if (panelOpen) noteOverlayClosed();
    panelOpen = false;
    panel.classList.remove('is-open');
    panel.inert = true; // закрытая панель — вне порядка табуляции и недоступна скринридеру
    expandBtn.classList.remove('is-open');
    expandBtn.setAttribute('aria-expanded', 'false');
  }
  function openPanel(): void {
    panelOpen = true;
    ensurePanelMenu();
    buildPanelRows();
    // Превью бесед читаем, только пока панель открыта: закрытой они не нужны.
    void refreshPreviews(opts.transport, latest, () => {
      if (panelOpen) buildPanelRows();
    });
    panel.inert = false;
    panel.classList.add('is-open');
    expandBtn.classList.add('is-open');
    expandBtn.setAttribute('aria-expanded', 'true');
  }

  // Очередь ждущих: счётчик сессий, где агент закончил или спросил, а туда ещё не
  // заглядывали. Клик ведёт к следующей такой. Источник тот же, что у 🔔 на вкладках.
  const queueBtn = document.createElement('button');
  queueBtn.type = 'button';
  queueBtn.className = 'th-tabs-queue';
  queueBtn.hidden = true;
  queueBtn.addEventListener('mousedown', (e) => e.preventDefault());
  queueBtn.addEventListener('click', goNextWaiting);
  const syncQueue = (): void => {
    const n = waiting().length;
    queueBtn.hidden = n === 0;
    queueBtn.textContent = `🔔 ${n}`;
    const label = t('term.queue', { n });
    queueBtn.title = label;
    queueBtn.setAttribute('aria-label', label);
  };

  // Общая шапка бокового режима: вкладки ушли в столбец слева, а в шапке слева стоит
  // текущая сессия (название и состояние, как на вкладке), справа — действия меню главной
  // иконками. В обычном режиме обоих нет: текущую сессию показывает её вкладка.
  const currentEl = document.createElement('div');
  currentEl.className = 'th-tabs-current';
  let sideMenu: { el: HTMLElement; teardown: () => void } | null = null;
  const syncSideHeader = (side: boolean, info: TabInfo, working: boolean): void => {
    syncSessionHead(currentEl, 'th-tabs-current', info, t, working);
    // Меню строится только в боковом режиме: в обычном оно скрыто, а его пункты
    // спрашивают агента (caffeinate) — впустую это делать незачем.
    if (side && !sideMenu) {
      // Без пункта выбора сервера: на терминале его открывает глобус состояния связи,
      // второй глобус рядом был бы дублем.
      sideMenu = renderMenu(opts.transport, undefined, 'bar');
      wrap.append(sideMenu.el);
    } else if (!side && sideMenu) {
      sideMenu.teardown();
      sideMenu.el.remove();
      sideMenu = null;
    }
  };

  wrap.append(currentEl, strip, queueBtn, expandBtn, panel);

  const tabs = new Map<string, HTMLElement>();
  const currentTab = renderSessionTab(
    { name: opts.current, bell: false, title: '' },
    true,
    t,
    switchTo,
    opts.onKill,
  );
  tabs.set(opts.current, currentTab);
  // До первого list у relay scope неизвестен — на всякий случай прячем крестик текущей
  // вкладки (render ниже вернёт его владельцу). Гость сессии не убивает.
  if (opts.transport.mode === 'relay') {
    const c = currentTab.querySelector<HTMLElement>('.th-tab__close');
    if (c) c.style.display = 'none';
  }
  strip.append(currentTab);
  opts.onCurrentTitle?.(opts.current);

  // Точечное обновление, как в дашборде: не пересоздаём узлы, чтобы не сбрасывать
  // горизонтальный скролл полосы и фокус.
  const render = (input: SessionInfo[]): void => {
    latest = input; // снимок для панели быстрого переключения
    tabsCache.set(opts.transport, input); // переживёт пере-монтирование экрана
    // Боковая панель (десктоп, по выбору) кучкует вкладки по проектам.
    const side = isDesktop() && readTermPrefs().sideTabs;
    const sorted = sortSessions(input, sortMode, bellUnseen, readManualOrder());
    const sessions = side ? groupSessions(sorted) : sorted;
    order = sessions.map((s) => s.name);
    const currentInfo = input.find((session) => session.name === opts.current);
    opts.onCurrentTitle?.(currentInfo ? sessionTitleText(currentInfo.title) || opts.current : opts.current);
    // Гость (scope задан после первого list) не управляет сессиями: прячем «+» и
    // крестики-закрытия табов.
    const guest = opts.transport.clientScope != null;
    createBtn.hidden = guest;
    for (const el of tabs.values()) {
      const c = el.querySelector<HTMLElement>('.th-tab__close');
      if (c) c.style.display = guest ? 'none' : '';
    }
    if (panelOpen) {
      buildPanelRows(); // панель открыта во время поллинга — держим свежей
      void refreshPreviews(opts.transport, input, () => {
        if (panelOpen) buildPanelRows();
      });
    }
    const wanted = new Set(sessions.map((s) => s.name));
    wanted.add(opts.current);
    for (const [name, el] of [...tabs]) {
      if (!wanted.has(name)) {
        el.remove();
        tabs.delete(name);
      }
    }
    for (const s of sessions) {
      const existing = tabs.get(s.name);
      const isCurrent = s.name === opts.current;
      // Работает: Claude-спиннер в заголовке; не-Claude сессии — fallback по
      // session_activity (потока к ним нет, судим по опросу).
      const show = sessionWorking(s.title) || (sessionByOutput(s.title) && activity.isHot(s.name));
      // 🔔 — только пока звонок «не прочитан» (не открывали сессию).
      const info = { ...s, bell: bellUnseen(s.name) };
      if (existing) updateSessionTab(existing, info, isCurrent, t, show);
      else {
        const el = renderSessionTab(info, isCurrent, t, switchTo, opts.onKill, show);
        if (guest) {
          const c = el.querySelector<HTMLElement>('.th-tab__close');
          if (c) c.style.display = 'none';
        }
        tabs.set(s.name, el);
        strip.append(el);
      }
    }
    // Порядок — как в списке агента; перестановка сбросила бы фокус, поэтому
    // пропускаем, пока фокус внутри полосы. Узлы вне списка (текущая пропавшая
    // сессия) дрейфуют в конец.
    syncQueue();
    const cur = currentInfo ?? { name: opts.current, bell: false, title: '' };
    syncSideHeader(
      side,
      { ...cur, bell: false },
      sessionWorking(cur.title) || (sessionByOutput(cur.title) && activity.isHot(cur.name)),
    );
    const focusInside = document.activeElement instanceof Node && strip.contains(document.activeElement);
    if (!focusInside) {
      // Заголовки групп — не вкладки: снимаем перед перестановкой и ставим заново.
      clearGroupHeaders(strip);
      let anchor: ChildNode | null = strip.firstChild;
      for (const s of sessions) {
        const el = tabs.get(s.name);
        if (!el) continue;
        if (el === anchor) anchor = anchor.nextSibling;
        else strip.insertBefore(el, anchor);
      }
      if (side) syncGroupHeaders(strip, order, (name) => tabs.get(name));
    }
  };

  markBellSeen(opts.current); // просмотр при переключении, а не на каждом полле
  // Переключили «сверху / сбоку» в окне вида — перестраиваем полосу на месте.
  const unsubscribePrefs = onTermPrefsChange(() => {
    if (latest.length) render(latest);
  });
  const unsubscribeBell = onBellChange(() => {
    updateAppBadge(unseenBellCount());
    if (latest.length) render(latest);
  });
  let stopped = false;
  let scrolledOnce = false;
  const refresh = async (): Promise<void> => {
    try {
      const sessions = await opts.transport.list();
      if (stopped) return;
      activity.observe(sessions);
      observeBells(sessions);
      updateAppBadge(unseenBellCount());
      render(sessions);
      if (!scrolledOnce) {
        scrolledOnce = true;
        // Активный таб в зону видимости (happy-dom метода не имеет — опционально).
        currentTab.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
      }
    } catch {
      // Обрыв list() полосу не трогает: статус соединения уже показывает «●».
    }
  };
  const tick = (): void => {
    if (document.visibilityState === 'visible') void refresh();
  };
  const timer = window.setInterval(tick, POLL_INTERVAL);
  // Сразу рисуем прошлый список: вкладки остаются на месте при переключении, а полл
  // ниже их лишь обновит. Данные могут быть слегка устаревшими — это честнее, чем
  // схлопнуть полосу до одной вкладки и собрать её заново через секунды.
  const cached = tabsCache.get(opts.transport);
  if (cached && cached.length > 0) render(cached);
  void refresh();

  return {
    el: wrap,
    teardown(): void {
      stopped = true;
      unsubscribeBell();
      unsubscribePrefs();
      sideMenu?.teardown();
      panelMenu?.teardown();
      window.clearInterval(timer);
      document.removeEventListener('keydown', onKeyDown, true);
    },
    refresh,
  };
}
