// Общие UI-примитивы: иконки, кнопки-иконки, шапка приложения, модалка, тосты,
// спиннер. Держим здесь, чтобы dashboard/main не разрастались вёрсткой.

import { ApiError } from './api';
import { getLang, setLang, t } from './i18n';
import { notificationsSupported, permissionState, requestNotificationPermission } from './notify';
import { enablePush } from './push';
import { currentTheme, toggleTheme } from './theme';
import { SORT_MODES, writeSortMode, type SortMode } from './session-sort';
import type { Transport } from './transport';
import { openDevicesModal, openShareDialog } from './sharing';

const ICONS: Record<string, string> = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  dots: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  devices: '<rect x="3" y="4" width="14" height="11" rx="2"/><path d="M8 20h6M12 15v5"/>',
  coffee: '<path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9h2a2 2 0 0 1 0 4h-2"/><path d="M8 2v2M12 2v2"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v6.5M12 15.5V22"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
};

/** Инлайн-иконка (stroke = currentColor). */
export function svgIcon(name: keyof typeof ICONS | string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'th-icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;
  return span;
}

/** Квадратная кнопка-иконка с доступным именем. */
export function iconButton(name: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'th-iconbtn';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.append(svgIcon(name));
  btn.addEventListener('click', onClick);
  return btn;
}

/** Всплывающее сообщение внизу экрана (info/error), само исчезает. */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  let host = document.querySelector<HTMLDivElement>('.th-toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'th-toasts';
    document.body.append(host);
  }
  const item = document.createElement('div');
  item.className = `th-toast th-toast--${kind}`;
  item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  item.textContent = message;
  host.append(item);
  requestAnimationFrame(() => item.classList.add('is-shown'));
  setTimeout(() => {
    item.classList.remove('is-shown');
    setTimeout(() => item.remove(), 200);
  }, 3200);
}

/** Копирует текст в буфер. В secure context (HTTPS/localhost) — Clipboard API; иначе
 *  (LAN по HTTP, где `navigator.clipboard` не определён и обращение к нему бросает
 *  исключение) — фолбэк через временный textarea + execCommand. Возвращает успех —
 *  вызывающий сам показывает toast. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // недоступно/запрещено — пробуем legacy-фолбэк ниже
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Крутящийся индикатор. */
export function spinner(): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'th-spinner';
  span.setAttribute('role', 'progressbar');
  return span;
}

/** Экран ошибки загрузки: сообщение + кнопка «Обновить» (retry). */
export function errorScreen(message: string, onRetry: () => void): HTMLElement {
  const box = document.createElement('div');
  box.className = 'th-loaderror';
  const p = document.createElement('p');
  p.className = 'th-loaderror__msg';
  p.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'th-btn';
  btn.append(svgIcon('refresh'), document.createTextNode(t('common.retry')));
  btn.addEventListener('click', onRetry);
  box.append(p, btn);
  return box;
}

// Открытые оверлеи (модалки) — держим их close() здесь, чтобы роутер мог снести
// висящий overlay и его document-слушатель при смене экрана (см. dismissOverlays).
const overlayDismissers = new Set<() => void>();

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Снимает открытые модалки и тосты — вызывается роутером при смене роута. */
export function dismissOverlays(): void {
  for (const dismiss of [...overlayDismissers]) dismiss();
  document.querySelector('.th-toasts')?.remove();
}

/** Циклическая фокус-ловушка внутри модалки: Tab с последнего → на первый и наоборот. */
function trapFocus(e: KeyboardEvent, container: HTMLElement): void {
  const nodes = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
  if (nodes.length === 0) {
    e.preventDefault();
    return;
  }
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const active = document.activeElement;
  const inside = active instanceof Node && container.contains(active);
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

/** Модалка поверх приложения. builder получает close(). Esc и клик по фону закрывают.
 *  Возвращает cleanup() — тихое закрытие БЕЗ history.back (для цепочки модалок:
 *  закрыть текущую и открыть следующую, не роняя её запоздавшим popstate). */
export function openModal(builder: (close: () => void) => HTMLElement): () => void {
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement('div');
  overlay.className = 'th-overlay';

  // Модалка добавляет запись в history — кнопка «Назад» браузера её закрывает.
  // cleanup — тихое снятие (для смены роута/«Назад», без трогания history);
  // close — пользовательское закрытие (Esc/крестик/фон): дополнительно снимает
  // добавленную history-запись через history.back().
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    overlayDismissers.delete(cleanup);
    overlay.classList.remove('is-shown');
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', onPop);
    previouslyFocused?.focus();
    setTimeout(() => overlay.remove(), 200);
  };
  const close = (): void => {
    if (closed) return;
    cleanup();
    history.back(); // снять нашу history-запись → URL возвращается к экрану
  };
  const onPop = (): void => cleanup(); // «Назад» уже снял запись — только чистим
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Tab') trapFocus(e, card);
  };

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  const card = builder(close);
  card.classList.add('th-modal');
  overlay.append(card);
  document.body.append(overlay);
  overlayDismissers.add(cleanup);
  document.addEventListener('keydown', onKey);
  history.pushState({ thModal: true }, '');
  window.addEventListener('popstate', onPop);
  requestAnimationFrame(() => overlay.classList.add('is-shown'));

  // Начальный фокус — на первое осмысленное поле ввода тела модалки, а не на
  // иконку «закрыть» в шапке (первый элемент FOCUSABLE_SELECTOR). Если полей нет
  // (напр. тело ещё грузится и стартует со спиннера) — на первый фокусируемый.
  const firstField = card.querySelector<HTMLElement>(
    'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
  );
  (firstField ?? card.querySelector<HTMLElement>(FOCUSABLE_SELECTOR))?.focus();
  return cleanup;
}

/**
 * Шапка приложения: логотип, язык, тема, уведомления, меню. Возвращает элемент и
 * teardown — снятие document-слушателя меню (иначе слушатели копятся при каждом
 * перемонтировании: смена языка/темы, навигация).
 */
export function renderHeader(
  showActions: boolean,
  transport?: Transport,
  onPickAgent?: () => void,
): { el: HTMLElement; teardown: () => void } {
  const header = document.createElement('header');
  header.className = 'th-header';

  const brand = document.createElement('a');
  brand.className = 'th-logo';
  brand.href = '#/';
  const glyph = document.createElement('span');
  glyph.className = 'th-logo__glyph';
  glyph.textContent = '›_';
  const logoText = document.createElement('span');
  logoText.className = 'th-logo__text';
  logoText.textContent = t('app.name');
  brand.append(glyph, logoText);
  header.append(brand);

  const actions = document.createElement('div');
  actions.className = 'th-header__actions';
  header.append(actions);

  // Единственный элемент действий в шапке — меню «⋯». Тема/язык/уведомления/сон
  // и управление доступом теперь пункты внутри него. showActions включает
  // transport-зависимые пункты (уведомления/сон/устройства/доступ) — они требуют
  // связи с агентом; на login/выборе агента остаются только тема и язык.
  const menu = buildMenu(showActions ? transport : undefined, onPickAgent);
  actions.append(menu.el);

  return { el: header, teardown: menu.teardown };
}

/** Полоса вкладок «Сессии | Проводник» под шапкой (общая для дашборда и
 *  проводника). Навигация — нативные ссылки на hash-роуты, чтобы кнопка «Назад»
 *  браузера работала. Вкладка «Проводник» скрыта у гостя без доступа к файлам. */
export function renderTabs(active: 'sessions' | 'files' | 'repo', transport?: Transport): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'th-navtabs';
  nav.setAttribute('role', 'tablist');

  const mkTab = (key: 'sessions' | 'files' | 'repo', label: string, hash: string): HTMLElement => {
    const tab = document.createElement('a');
    tab.className = `th-navtab${active === key ? ' is-active' : ''}`;
    tab.href = hash;
    tab.textContent = label;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(active === key));
    return tab;
  };

  nav.append(mkTab('sessions', t('nav.sessions'), '#/'));
  // Гость получает scope; владелец (LAN-пароль / полный relay-доступ) — clientScope=null.
  const scope = transport?.clientScope;
  if (!scope || scope.files) nav.append(mkTab('files', t('nav.files'), '#/files'));
  // Репозиторий доступен только внутри сессии (вкладка на экране терминала) — глобальной
  // вкладки на дашборде нет: смотрим текущий репозиторий сессии, а не абстрактный список.
  return nav;
}

const TOOLBAR_LS_KEY = 'termhub.toolbar';

/** Видимость тулбара (Holo-бар + панель клавиш) из localStorage (по умолчанию показан). */
export function readToolbarVisible(): boolean {
  try {
    return localStorage.getItem(TOOLBAR_LS_KEY) !== '0';
  } catch {
    return true;
  }
}
export function writeToolbarVisible(visible: boolean): void {
  try {
    localStorage.setItem(TOOLBAR_LS_KEY, visible ? '1' : '0');
  } catch {
    // Персист необязателен.
  }
}

/** Android-Holo таб-бар рабочего пространства сессии: Сессия / Проводник / Репозиторий
 *  + «⋮» справа (сворачивает тулбар). Активный таб подчёркнут снизу цветной полосой во
 *  всю ширину. Скролла нет — табы делят ширину поровну. Проводник/Репозиторий ведут на
 *  session-scoped роуты (по пути сессии). */
export function renderHoloBar(opts: {
  active: 'term' | 'files' | 'repo';
  session: string;
  transport?: Transport;
  onHide: () => void;
}): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'th-holobar';
  bar.setAttribute('role', 'tablist');
  const enc = encodeURIComponent(opts.session);
  const mkTab = (key: 'term' | 'files' | 'repo', label: string, hash: string): HTMLElement => {
    const a = document.createElement('a');
    a.className = `th-holotab${opts.active === key ? ' is-active' : ''}`;
    a.href = hash;
    a.textContent = label;
    a.setAttribute('role', 'tab');
    a.setAttribute('aria-selected', String(opts.active === key));
    return a;
  };
  bar.append(mkTab('term', t('holo.session'), `#/term/${enc}`));
  const scope = opts.transport?.clientScope;
  if (!scope || scope.files) {
    bar.append(mkTab('files', t('nav.files'), `#/sfiles/${enc}`));
    bar.append(mkTab('repo', t('nav.repo'), `#/srepo/${enc}`));
  }
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'th-holobar__hide';
  hide.textContent = '⋮';
  hide.setAttribute('aria-label', t('term.toolbarHide'));
  hide.title = t('term.toolbarHide');
  hide.addEventListener('mousedown', (e) => e.preventDefault());
  hide.addEventListener('click', opts.onHide);
  bar.append(hide);
  return bar;
}

/** Плавающая «⋮» + сворачивание тулбара (persist). toolbars — элементы, сворачиваемые
 *  вместе (на терминале: Holo-бар сверху + панель клавиш снизу); floatMount — куда
 *  положить плавающую кнопку (видна, только когда свёрнуто); onChange — колбэк после
 *  смены (напр. пере-fit терминала). Возвращает hide() для кнопки «⋮» внутри Holo-бара. */
export function wireToolbar(opts: {
  toolbars: HTMLElement[];
  floatMount: HTMLElement;
  onChange?: () => void;
}): { hide: () => void } {
  let visible = readToolbarVisible();
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'th-term__toolbar-toggle';
  toggle.textContent = '⋮';
  toggle.addEventListener('mousedown', (e) => e.preventDefault());
  const apply = (): void => {
    for (const el of opts.toolbars) el.classList.toggle('is-hidden', !visible);
    toggle.classList.toggle('is-hidden', visible);
    const label = visible ? t('term.toolbarHide') : t('term.toolbarShow');
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  };
  const set = (v: boolean): void => {
    visible = v;
    writeToolbarVisible(v);
    apply();
    opts.onChange?.();
  };
  toggle.addEventListener('click', () => set(true));
  opts.floatMount.append(toggle);
  apply();
  return { hide: () => set(false) };
}

/** Текстовая метка пункта меню. */
function menuLabel(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'th-menu__label';
  span.textContent = text;
  return span;
}

/** Добавитель пункта меню (см. buildMenu): иконка + подпись; keepOpen оставляет
 *  меню открытым (для тумблеров, меняющих вид на месте). Возвращает саму кнопку. */
type AddItem = (
  iconName: string,
  label: string,
  onClick: (item: HTMLButtonElement) => void,
  opts?: { keepOpen?: boolean },
) => HTMLButtonElement;

/** Меню «⋯»: тема и язык — всегда; при связи с агентом (transport) добавляются
 *  уведомления, «не давать засыпать», устройства и «поделиться доступом». Гостю
 *  (ограниченный scope) transport-пункты не показываем. Возвращает элемент и
 *  teardown (снимает document-слушатель закрытия и опрос caffeinate). */
function buildMenu(
  transport?: Transport,
  onPickAgent?: () => void,
): { el: HTMLElement; teardown: () => void } {
  const wrap = document.createElement('div');
  wrap.className = 'th-menu';

  const trigger = iconButton('dots', t('header.menu'), () => {
    const open = wrap.classList.toggle('is-open');
    trigger.setAttribute('aria-expanded', String(open));
  });
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');

  const pop = document.createElement('div');
  pop.className = 'th-menu__pop';
  pop.setAttribute('role', 'menu');

  const closeMenu = (): void => {
    wrap.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
  };

  const addItem: AddItem = (iconName, label, onClick, opts = {}) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'th-menu__item';
    item.setAttribute('role', 'menuitem');
    item.append(svgIcon(iconName), menuLabel(label));
    item.addEventListener('click', () => {
      if (!opts.keepOpen) closeMenu();
      onClick(item);
    });
    pop.append(item);
    return item;
  };

  const addSep = (): void => {
    const sep = document.createElement('div');
    sep.className = 'th-menu__sep';
    sep.setAttribute('role', 'separator');
    pop.append(sep);
  };

  // — Выбор агента (только remote): переключиться на другой сопряжённый агент.
  if (onPickAgent) {
    addItem('globe', t('remote.pickTitle'), () => onPickAgent());
    addSep();
  }

  // — Тема (тумблер): иконка и подпись отражают, куда переключит клик.
  const themeLabel = (): string => (currentTheme() === 'dark' ? t('header.themeToLight') : t('header.themeToDark'));
  const themeIcon = (): string => (currentTheme() === 'dark' ? 'moon' : 'sun');
  const themeItem = addItem(
    themeIcon(),
    themeLabel(),
    () => {
      toggleTheme();
      themeItem.replaceChildren(svgIcon(themeIcon()), menuLabel(themeLabel()));
    },
    { keepOpen: true },
  );

  // — Язык (RU↔EN). setLang перерисует приложение (onLangChange) — меню
  //   пересоберётся уже на новом языке, обновлять пункт на месте не нужно.
  addItem(
    'globe',
    `${t('header.language')}: ${getLang().toUpperCase()}`,
    () => setLang(getLang() === 'ru' ? 'en' : 'ru'),
    { keepOpen: true },
  );

  // — Диагностика (статус агента и связи с relay).
  addItem('pulse', t('diag.title'), () => (location.hash = '#/diag'));

  let stopCaffeine = (): void => {};

  // Transport-пункты — только при связи с агентом и только владельцу (у гостя
  // ограниченный scope; управление уведомлениями/сном/доступом ему не даём).
  const guest = !!transport?.clientScope;
  if (transport && !guest) {
    if (notificationsSupported()) addNotificationsItem(addItem, transport);
    stopCaffeine = addCaffeineItem(addItem, transport);
    addSep();
    addItem('devices', t('header.devices'), () => openDevicesModal(transport));
    addItem('share', t('header.share'), () => openShareDialog(transport));
  }

  wrap.append(trigger, pop);
  const onDocClick = (e: MouseEvent): void => {
    if (!wrap.contains(e.target as Node)) closeMenu();
  };
  document.addEventListener('click', onDocClick);
  return {
    el: wrap,
    teardown: () => {
      document.removeEventListener('click', onDocClick);
      stopCaffeine();
    },
  };
}

/** Пункт «уведомления»: запрос разрешения + оформление web-push. Отражает
 *  состояние (granted → «включены», disabled; denied → «запрещены», disabled). */
function addNotificationsItem(addItem: AddItem, transport: Transport): void {
  const labelFor = (): string => {
    const state = permissionState();
    if (state === 'granted') return t('header.notificationsOn');
    if (state === 'denied') return t('notify.denied');
    return t('header.enableNotifications');
  };
  const sync = (item: HTMLButtonElement): void => {
    item.replaceChildren(svgIcon('bell'), menuLabel(labelFor()));
    const state = permissionState();
    item.classList.toggle('is-on', state === 'granted');
    item.disabled = state !== 'default';
  };
  const item = addItem(
    'bell',
    labelFor(),
    async (self) => {
      const state = await requestNotificationPermission();
      sync(self);
      if (state === 'granted') {
        toast(t('notify.granted'));
        // Подписка идёт через транспорт — работает и в relay (VAPID/подписка по E2E).
        void enablePush(transport);
      } else if (state === 'denied') toast(t('notify.denied'), 'error');
    },
    { keepOpen: true },
  );
  sync(item);
  // Разрешение уже выдано ранее — переоформляем подписку в текущем транспорте.
  if (permissionState() === 'granted') void enablePush(transport);
}

/** Пункт «не давать Mac засыпать» (caffeinate). Появляется, только когда агент
 *  подтвердил поддержку платформой (probe, в relay первый опрос может прийтись на
 *  ещё не поднятый поток — ретраим). Тумблер: галочка справа отражает состояние.
 *  Возвращает stop — снятие опроса при teardown меню. */
function addCaffeineItem(addItem: AddItem, transport: Transport): () => void {
  let active = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const item = addItem('coffee', t('header.keepAwake'), () => void toggle(), { keepOpen: true });
  item.hidden = true; // до подтверждения поддержки платформой
  item.disabled = true;

  const sync = (): void => {
    item.classList.toggle('is-on', active);
    item.replaceChildren(svgIcon('coffee'), menuLabel(active ? t('header.keepAwakeOn') : t('header.keepAwake')));
    if (active) item.append(svgIcon('check'));
    item.setAttribute('aria-pressed', String(active));
  };
  const toggle = async (): Promise<void> => {
    item.disabled = true;
    try {
      active = (await transport.setCaffeinate(!active)).active;
      sync();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) toast(t('header.keepAwakeError'), 'error');
    } finally {
      item.disabled = false;
    }
  };
  const probe = (): void => {
    transport
      .caffeinate()
      .then((state) => {
        if (stopped || !state.supported) return;
        active = state.active;
        item.hidden = false;
        item.disabled = false;
        sync();
      })
      .catch(() => {
        if (!stopped) retry = setTimeout(probe, 3000);
      });
  };
  probe();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
  };
}

/**
 * Селект порядка сессий. Один и тот же контрол на дашборде и в панели быстрого
 * переключения — выбор общий (persist в session-sort), поэтому оба списка и полоса
 * вкладок всегда идут в одном порядке.
 *
 * Именно `<select>`, а не сегмент-контрол: режимов уже три, подписи длинные, а на
 * телефоне нативный селект даёт крупные цели для тапа без своей вёрстки.
 */
export function sortSelect(current: SortMode, onChange: (mode: SortMode) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'th-sort';
  const caption = document.createElement('span');
  caption.className = 'th-sort__label';
  caption.textContent = t('sort.label');
  const select = document.createElement('select');
  select.className = 'th-sort__select';
  select.setAttribute('aria-label', t('sort.label'));
  for (const mode of SORT_MODES) {
    const opt = document.createElement('option');
    opt.value = mode;
    opt.textContent = t(`sort.${mode}`);
    if (mode === current) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener('change', () => {
    const mode = select.value as SortMode;
    writeSortMode(mode);
    onChange(mode);
  });
  wrap.append(caption, select);
  return wrap;
}
