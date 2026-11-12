// Общие UI-примитивы: иконки, кнопки-иконки, шапка приложения, модалка, тосты,
// спиннер. Держим здесь, чтобы dashboard/main не разрастались вёрсткой.

import type { GradleProject } from '@termhub/protocol/frames';

import { ApiError, type CaffeinateState } from './api';
import { t } from './i18n';
import { notificationsSupported, permissionState, requestNotificationPermission } from './notify';
import { enablePush } from './push';
import { openDiag } from './diag';
import { openFeedSearch } from './feed-search-all';
import { openTermSettings } from './term-settings';
import { openUsage } from './usage';
import { SORT_MODES, writeSortMode, type SortMode } from './session-sort';
import type { Transport } from './transport';
import { openDevicesModal, openShareDialog } from './sharing';
import { whenCap } from './capabilities';
import { sfeedHash, sgradleHash, termHash } from './routes';
import { chatCapable, effectiveView, sessionInfo, setSessionViewPref, type SessionView } from './view-pref';

const ICONS: Record<string, string> = {
  terminal: '<path d="M4 6l6 6-6 6M12 18h8"/>',
  branch: '<circle cx="6" cy="5" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="19" r="3"/><path d="M6 8v8M18 9a9 9 0 0 1-9 9"/>',
  build: '<path d="M14 3l7 7-4 4-3-3-8 9-3-3 9-8-3-3z"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
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
  // Столбики — расход; «i» в круге — сведения о подключении; «A» с иероглифом — язык.
  chart: '<path d="M3 21h18M7 21V11M12 21V4M17 21v-7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  lang: '<path d="M3 5h9M7.5 3v2M5 9c1.2 2.6 3.4 4.6 6 5.6M10.5 5c-.6 4-2.8 7.4-6.5 9.5"/><path d="M13 21l4-10 4 10M14.5 17.5h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  paste: '<path d="M9 4h6v3H9zM9 5H6v16h12V5h-3"/><path d="M9 12h6M9 16h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  // Ползунки — параметры отображения (окно «Вид терминала»).
  sliders: '<path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1"/><circle cx="16" cy="6" r="2.2"/><circle cx="10" cy="12" r="2.2"/><circle cx="18" cy="18" r="2.2"/>',
  paperclip: '<path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>',
  camera: '<path d="M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  chat: '<path d="M4 4h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M20 9a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2v3l-3.5-3H12"/>',
  bulb: '<path d="M9 18h6M10 21.5h4"/><path d="M12 2.5a6.5 6.5 0 0 0-4 11.6c.7.6 1 1.3 1 2.1V18h6v-1.8c0-.8.3-1.5 1-2.1a6.5 6.5 0 0 0-4-11.6z"/>',
  bolt: '<path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12z"/>',
  feed: '<path d="M21 11.5a8.4 8.4 0 0 1-11.9 7.6L3.5 21l1.9-5.5A8.4 8.4 0 1 1 21 11.5z"/><path d="M8.5 9.5h7M8.5 13h4.5"/>',
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

/** Закрытие модалки. close() — снять её history-запись через history.back(); close(next)
 *  с hash-маршрутом — уйти «в сторону» next, заменив запись модалки маршрутом. Всё, что не
 *  строка (Event: close часто вешают слушателем напрямую), — обычное закрытие. */
export type ModalClose = (next?: string | Event) => void;

/** Модалка поверх приложения. builder получает close(next?). Esc и клик по фону закрывают.
 *  Возвращает cleanup() — тихое закрытие БЕЗ history.back (для цепочки модалок:
 *  закрыть текущую и открыть следующую, не роняя её запоздавшим popstate). */
export function openModal(builder: (close: ModalClose) => HTMLElement): () => void {
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
  const close: ModalClose = (next) => {
    if (closed) return;
    cleanup();
    if (typeof next !== 'string') {
      history.back(); // снять нашу history-запись → URL возвращается к экрану
      return;
    }
    // Уход на маршрут next (в только что созданную сессию). Нельзя «history.back() и
    // location.hash = next»: back() — асинхронная траверса, а смена hash синхронна.
    // Браузер сперва пушит next, потом исполняет отложенный back уже от новой записи и
    // возвращается на запись модалки со СТАРЫМ URL — роутер сносит только что
    // смонтированный экран (баг R11). Поэтому запись модалки ЗАМЕНЯЕМ маршрутом:
    // история — [откуда пришли, next], «Назад» ведёт ровно на шаг, back() не нужен.
    location.replace(next);
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

// Открыватель списка серверов регистрирует remote-режим (он один знает про агентов).
// Реестр нужен, чтобы экран терминала мог показать список по клику на кружок статуса,
// не импортируя remote/keys: те тянут libsodium, которому нельзя попасть в LAN-бандл.
let serverPicker: (() => void) | null = null;

export function setServerPicker(open: (() => void) | null): void {
  serverPicker = open;
}

/** Есть ли кому показать список серверов (в LAN-режиме сервер один — некому). */
export function hasServerPicker(): boolean {
  return serverPicker !== null;
}

export function openServerPicker(): void {
  serverPicker?.();
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

// Детект Gradle-проекта — на сессию, на транспорт (relay: агентов несколько) и
// на срок: Holo-бар рисуют три экрана, и каждое переключение вкладки дёргало бы
// агента заново, но вечным кэш быть не может — папка меняется под живой страницей.
const gradleDetects = new Map<string, { at: number; req: Promise<GradleProject | null> }>();
const gradleKnown = new Map<string, { at: number; value: GradleProject | null }>();
let gradleOwner: unknown = null;
/** Срок жизни ответа. Папка становится Gradle-проектом (и перестаёт им быть) при
 *  живой странице — `gradle init`, `git clone`, checkout другой ветки, — и без
 *  срока таб появился бы только после перезагрузки (история 4). */
const GRADLE_TTL_MS = 5 * 60_000;

function gradleFresh(at: number): boolean {
  return Date.now() - at < GRADLE_TTL_MS;
}

function resetGradleIfForeign(transport: Transport): void {
  if (gradleOwner === transport) return;
  gradleOwner = transport;
  gradleDetects.clear();
  gradleKnown.clear();
}

/** Gradle-проект сессии (кэш на сессию); `null` — обычная папка. Сбой запроса
 *  ПРОБРАСЫВАЕТСЯ и не кэшируется: «не Gradle-проект» и «не удалось спросить» —
 *  разные ответы, и вызывающий по ним поступает по-разному (таб не рисуем против
 *  «остаться на вкладке и повторить»). */
export function detectGradle(transport: Transport, session: string): Promise<GradleProject | null> {
  resetGradleIfForeign(transport);
  const at = Date.now();
  const cached = gradleDetects.get(session);
  if (cached && gradleFresh(cached.at)) return cached.req;
  const req = transport.gradle<GradleProject | null>('detect', { session }).then(
    (project) => {
      const value = project ?? null;
      // Обе ветки сверяют, наша ли ещё запись: пока запрос был в полёте, срок мог
      // выйти и следующий рендер бара спросил заново — опоздавший ответ не должен
      // перебивать свежий (ни значением, ни удалением чужого запроса).
      if (gradleDetects.get(session)?.req === req) gradleKnown.set(session, { at, value });
      return value;
    },
    (err: unknown) => {
      if (gradleDetects.get(session)?.req === req) gradleDetects.delete(session);
      throw err;
    },
  );
  gradleDetects.set(session, { at, req });
  return req;
}

/** Уже известный результат детекта, без запроса: undefined — ещё не спрашивали.
 *  Нужен роутеру, чтобы не показывать вкладку там, где её нет (см. workspace.ts). */
export function knownGradle(transport: Transport, session: string): GradleProject | null | undefined {
  if (gradleOwner !== transport) return undefined;
  const known = gradleKnown.get(session);
  // Протухший ответ — это «ещё не спрашивали»: вид смонтируется и уведёт сам,
  // когда свежий детект вернёт `null` (см. workspace.ts).
  return known && gradleFresh(known.at) ? known.value : undefined;
}

/** Переключатель «Терминал / Чат» внутри плашки сессии: заменяет подпись плашки. Нажатие
 *  запоминает выбор по сессии и ведёт на нужный адрес; плашка сама (мимо кнопок) ведёт
 *  в тот вид, в котором сессию сейчас открывают. */
function mountViewSwitch(
  tab: HTMLElement,
  session: string,
  active: 'term' | 'files' | 'repo' | 'gradle' | 'feed',
  view: SessionView,
): void {
  const sw = document.createElement('span');
  sw.className = 'th-viewsw';
  sw.setAttribute('role', 'group');
  sw.setAttribute('aria-label', t('chat.view.label'));
  const current = active === 'term' ? 'term' : active === 'feed' ? 'chat' : null;
  for (const v of ['term', 'chat'] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'th-viewsw__opt';
    b.dataset.view = v;
    // Те же классы, что у иконки и подписи вкладки: там, где вкладки полосы показаны
    // иконками без подписей, позиция переключателя — тоже иконка.
    const icon = svgIcon(v === 'term' ? 'terminal' : 'chat');
    icon.classList.add('th-holotab__icon');
    const label = document.createElement('span');
    label.className = 'th-holotab__label';
    label.textContent = t(`chat.view.${v}`);
    b.append(icon, label);
    b.setAttribute('aria-label', t(`chat.view.${v}`));
    b.title = t(`chat.view.${v}`);
    b.setAttribute('aria-pressed', String(current === v));
    b.addEventListener('click', (e) => {
      // Кнопка живёт внутри ссылки на плашку: без этого клик ушёл бы ещё и в её переход.
      e.preventDefault();
      e.stopPropagation();
      setSessionViewPref(session, v);
      if (tab instanceof HTMLAnchorElement) tab.href = v === 'chat' ? sfeedHash(session) : termHash(session);
      location.hash = v === 'chat' ? sfeedHash(session) : termHash(session);
    });
    sw.append(b);
  }
  tab.querySelector(':scope > .th-holotab__label')?.replaceWith(sw);
  // Плашка мимо кнопок — в текущий вид сессии.
  if (tab instanceof HTMLAnchorElement) tab.href = view === 'chat' ? sfeedHash(session) : termHash(session);
}

/** Android-Holo таб-бар рабочего пространства сессии: Сессия / Проводник / Репозиторий
 *  (+ Gradle у Gradle-проекта, + Лента у агента с возможностью `feed`) и «⋮» справа
 *  (сворачивает тулбар). Активный таб подчёркнут снизу цветной полосой во всю ширину.
 *  Скролла нет — табы делят ширину поровну. Проводник/Репозиторий ведут на
 *  session-scoped роуты (по пути сессии). */
export function renderHoloBar(opts: {
  active: 'term' | 'files' | 'repo' | 'gradle' | 'feed';
  session: string;
  transport?: Transport;
  onHide: () => void;
}): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'th-holobar';
  bar.setAttribute('role', 'tablist');
  const enc = encodeURIComponent(opts.session);
  const mkTab = (key: 'term' | 'files' | 'repo' | 'gradle', label: string, hash: string): HTMLElement => {
    const a = document.createElement('a');
    a.className = `th-holotab th-holotab--${key}${opts.active === key ? ' is-active' : ''}`;
    a.href = hash;
    const icon = svgIcon({ term: 'terminal', files: 'folder', repo: 'branch', gradle: 'build' }[key]);
    icon.classList.add('th-holotab__icon');
    const text = document.createElement('span');
    text.className = 'th-holotab__label';
    text.textContent = label;
    a.append(icon, text);
    a.setAttribute('aria-label', label);
    a.title = label;
    a.setAttribute('role', 'tab');
    a.setAttribute('aria-selected', String(opts.active === key));
    return a;
  };
  const termTab = mkTab('term', t('holo.session'), termHash(opts.session));
  bar.append(termTab);
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
  const transport = opts.transport;
  // Лента — не пятая вкладка. Там, где возможен чат (Claude или Codex в панели и
  // возможность `chat` у обеих сторон), в плашке «Терминал» стоит переключатель вида
  // «Терминал / Чат»; во всех остальных сессиях — прежняя маленькая кнопка ленты
  // внутри плашки (если есть возможность `feed`, ADR 0018). Пересечение возможностей
  // считается на подключении, но после перезагрузки обмен бывает ещё в пути — тогда
  // элемент встаёт по его ответу. Файловой области это не касается: гостю без файлов
  // чат и лента видны (§8). На экране чата подсвечена позиция «Чат», а не вкладка.
  if (transport) {
    void Promise.all([
      whenCap('feed', transport),
      whenCap('chat', transport),
      sessionInfo(transport, opts.session),
    ]).then(([feedOk, chatOk, info]) => {
      const caps = [...(feedOk ? ['feed'] : []), ...(chatOk ? ['chat'] : [])];
      if (info && chatCapable(info, caps)) {
        mountViewSwitch(termTab, opts.session, opts.active, effectiveView(opts.session, info, caps));
        return;
      }
      if (!feedOk) return;
      const feed = document.createElement('button');
      feed.type = 'button';
      feed.className = 'th-holotab__feed';
      feed.setAttribute('aria-label', t('holo.feed'));
      feed.title = t('holo.feed');
      feed.append(svgIcon('feed'));
      feed.addEventListener('click', (e) => {
        // Кнопка живёт внутри ссылки на терминал: без этих двух строк клик по ней
        // ушёл бы и в переход вкладки, и промахнуться мимо ленты стало бы легко.
        e.preventDefault();
        e.stopPropagation();
        location.hash = sfeedHash(opts.session);
      });
      termTab.append(feed);
    });
  }
  //
  // Таб Gradle — только у Gradle-проекта, и бар его не ждёт: остальные табы уже на
  // экране, Gradle встаёт последним, когда детект вернул проект (история 4).
  if (transport && (!scope || scope.files)) {
    void detectGradle(transport, opts.session).then(
      (project) => {
        if (project) bar.insertBefore(mkTab('gradle', t('holo.gradle'), sgradleHash(opts.session)), hide);
      },
      () => {
        // Не спросили — таба нет; следующий рендер бара спросит снова (кэш не занят).
      },
    );
  }
  return bar;
}

/** Плавающая «⋮» + сворачивание тулбара (persist). toolbars — элементы, сворачиваемые
 *  вместе (на терминале: Holo-бар сверху + панель клавиш снизу); floatMount — куда
 *  положить плавающую кнопку (видна, только когда свёрнуто); toggleMount — место в шапке,
 *  куда «⋮» встаёт вместо плавания поверх содержимого; onChange — колбэк после
 *  смены (напр. пере-fit терминала). Возвращает hide() для кнопки «⋮» внутри Holo-бара. */
export function wireToolbar(opts: {
  toolbars: HTMLElement[];
  floatMount: HTMLElement;
  toggleMount?: HTMLElement;
  collapsedControls?: HTMLElement[];
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
    for (const control of opts.collapsedControls ?? []) control.classList.toggle('is-hidden', visible);
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
  if (opts.toggleMount) {
    toggle.classList.add('th-term__toolbar-toggle--bar');
    opts.toggleMount.append(toggle);
    opts.floatMount.append(...(opts.collapsedControls ?? []));
  } else {
    opts.floatMount.append(toggle, ...(opts.collapsedControls ?? []));
  }
  apply();
  return { hide: () => set(false) };
}

/** То же меню «⋯», что в шапке главной, — для шапки сессии: класс `th-menu--inline`
 *  раскладывает его пункты в ряд иконок. Снимать через teardown. */
export function renderMenu(
  transport?: Transport,
  onPickAgent?: () => void,
  layout: MenuLayout = 'menu',
): { el: HTMLElement; teardown: () => void } {
  return buildMenu(transport, onPickAgent, layout);
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
  opts?: { keepOpen?: boolean; primary?: boolean },
) => HTMLButtonElement;

/** Раскладка меню: `menu` — всё в выпадающем списке под «⋯» (шапка главной); `bar` —
 *  частые действия рядом иконками, редкие остаются под «⋯» (шапка сессии); `strip` — все
 *  действия одним рядом иконок, без «⋯» (полоса в окне сессий: на телефоне в шапке сессии
 *  этим кнопкам нет места). */
export type MenuLayout = 'menu' | 'bar' | 'strip';

/** Меню «⋯»: тема и язык — всегда; при связи с агентом (transport) добавляются
 *  уведомления, «не давать засыпать», устройства и «поделиться доступом». Гостю
 *  (ограниченный scope) transport-пункты не показываем. Возвращает элемент и
 *  teardown (снимает document-слушатель закрытия и опрос caffeinate). */
function buildMenu(
  transport?: Transport,
  onPickAgent?: () => void,
  layout: MenuLayout = 'menu',
): { el: HTMLElement; teardown: () => void } {
  const wrap = document.createElement('div');
  wrap.className = layout === 'menu' ? 'th-menu' : `th-menu th-menu--${layout}`;
  // Ряд частых действий (только раскладка `bar`).
  const row = document.createElement('div');
  row.className = 'th-menu__row';

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
    // Подсказка нужна там, где пункт показан одной иконкой (ряд в шапке сессии).
    item.title = label;
    // Тумблер, меняющий вид на месте: окно вокруг него закрывать не нужно.
    if (opts.keepOpen) item.dataset.keep = '';
    item.addEventListener('click', () => {
      if (!opts.keepOpen) closeMenu();
      onClick(item);
    });
    (layout === 'strip' || (layout === 'bar' && opts.primary) ? row : pop).append(item);
    return item;
  };
  /** Частое действие: в раскладке `bar` встаёт иконкой в ряд. */
  const addPrimary: AddItem = (iconName, label, onClick, opts = {}) =>
    addItem(iconName, label, onClick, { ...opts, primary: true });

  /** Граница группы — в списке и в ряду. Пустых и двойных границ не ставит. */
  const addSep = (): void => {
    for (const target of layout === 'bar' ? [row, pop] : layout === 'strip' ? [row] : [pop]) {
      const last = target.lastElementChild;
      if (!last || last.classList.contains('th-menu__sep')) continue;
      const sep = document.createElement('div');
      sep.className = 'th-menu__sep';
      sep.setAttribute('role', 'separator');
      target.append(sep);
    }
  };

  // Группы идут в одном порядке в обеих раскладках: работа с беседами, вид, агент и
  // связь, доступ. Пункт, зависящий от возможности агента (ADR 0018), встаёт на своё
  // место сразу, но скрытым — и показывается ответом обмена, не сдвигая соседей.
  const guest = !!transport?.clientScope;
  let stopCaffeine = (): void => {};

  // — Выбор агента (только remote): переключиться на другой сопряжённый агент.
  if (onPickAgent) {
    addItem('globe', t('remote.pickTitle'), () => onPickAgent());
    addSep();
  }

  // — Беседы: поиск по лентам всех сессий и расход.
  if (transport) {
    const tr = transport;
    const search = addPrimary('search', t('feedall.title'), () => openFeedSearch(tr));
    const usage = addPrimary('chart', t('usage.title'), () => openUsage(tr));
    search.hidden = true;
    usage.hidden = true;
    void whenCap('feed', tr).then((ok) => (search.hidden = !ok));
    void whenCap('usage', tr).then((ok) => (usage.hidden = !ok));
    addSep();
  }

  // — Настройки: вид, раскладка, ввод, язык — одним окном (term-settings).
  addPrimary('gear', t('termview.title'), () => openTermSettings());
  addSep();

  // — Агент и связь: уведомления и «не давать засыпать» — только при связи с агентом и
  //   только владельцу (у гостя ограниченный scope); сведения о подключении — всем.
  if (transport && !guest) {
    if (notificationsSupported()) addNotificationsItem(addPrimary, transport);
    stopCaffeine = addCaffeineItem(addPrimary, transport);
  }
  addItem('info', t('diag.title'), () => openDiag());

  // — Доступ: устройства и «поделиться» — владельцу.
  if (transport && !guest) {
    addSep();
    addItem('devices', t('header.devices'), () => openDevicesModal(transport));
    addItem('share', t('header.share'), () => openShareDialog(transport));
  }
  // Ряд не должен кончаться границей.
  if (row.lastElementChild?.classList.contains('th-menu__sep')) row.lastElementChild.remove();

  if (layout !== 'menu') wrap.append(row);
  if (layout !== 'strip') wrap.append(trigger, pop);
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

/** Сколько держать кнопку «не давать засыпать», чтобы включить режим закрытой крышки. */
export const LID_HOLD_MS = 600;

/** Пункт «не давать Mac засыпать» (caffeinate). Появляется, только когда агент
 *  подтвердил поддержку платформой (probe, в relay первый опрос может прийтись на
 *  ещё не поднятый поток — ретраим). Тумблер: галочка справа отражает состояние.
 *  Возвращает stop — снятие опроса при teardown меню. */
function addCaffeineItem(addItem: AddItem, transport: Transport): () => void {
  let state: CaffeinateState = { active: false, supported: false };
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lidPoll: ReturnType<typeof setInterval> | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** Удержание сработало: следующий клик — его хвост, а не нажатие. */
  let held = false;

  const item = addItem('coffee', t('header.keepAwake'), () => void toggle(), { keepOpen: true });
  item.hidden = true; // до подтверждения поддержки платформой
  item.disabled = true;

  const sync = (): void => {
    const lid = state.lid === true;
    item.classList.toggle('is-on', state.active && !lid);
    item.classList.toggle('is-lid', lid);
    const label = lid ? t('header.lidAwakeOn') : state.active ? t('header.keepAwakeOn') : t('header.keepAwake');
    item.replaceChildren(svgIcon('coffee'), menuLabel(label));
    if (state.active || lid) item.append(svgIcon('check'));
    item.setAttribute('aria-pressed', String(state.active || lid));
    // Подсказка про удержание — только там, где хост его умеет (macOS).
    item.title = state.lidSupported ? `${label} · ${t('header.lidAwakeHint')}` : label;
    // Пока режим крышки включён, следим за ним: хост снимает его сам, когда крышку открыли.
    if (lid && !lidPoll) lidPoll = setInterval(watchLid, 5000);
    if (!lid && lidPoll) {
      clearInterval(lidPoll);
      lidPoll = undefined;
    }
  };
  const failed = (err: unknown): void => {
    if (!(err instanceof ApiError && err.status === 401)) toast(t('header.keepAwakeError'), 'error');
  };
  /** Нажатие: обычное удержание сна. Пока включён режим крышки, нажатие выключает его:
   *  мигающую кнопку жмут, чтобы погасить, и «переключить другой режим» тут не ждут. */
  const toggle = async (): Promise<void> => {
    if (state.lid === true) return toggleLid();
    item.disabled = true;
    try {
      state = await transport.setCaffeinate(!state.active);
      sync();
      toast(state.active ? t('header.keepAwakeOnToast') : t('header.keepAwakeOffToast'));
    } catch (err) {
      failed(err);
    } finally {
      item.disabled = false;
    }
  };
  /** Удержание: не спать и с закрытой крышкой. Хост без разрешения отвечает прежним
   *  состоянием — тогда говорим, что нужна настройка на Mac. */
  const toggleLid = async (): Promise<void> => {
    const want = state.lid !== true;
    item.disabled = true;
    try {
      state = await transport.setLidAwake(want);
      sync();
      if (state.lid === want) toast(want ? t('header.lidAwakeOnToast') : t('header.lidAwakeOffToast'));
      else toast(t('header.lidAwakeSetup'), 'error');
    } catch (err) {
      failed(err);
    } finally {
      item.disabled = false;
    }
  };
  const watchLid = (): void => {
    transport.caffeinate().then(
      (next) => {
        if (stopped) return;
        const was = state.lid === true;
        state = next;
        sync();
        if (was && next.lid !== true) toast(t('header.lidAwakeAuto'));
      },
      () => {
        // Обрыв связи: спросим на следующем заходе.
      },
    );
  };
  const cancelHold = (): void => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = undefined;
  };
  item.addEventListener('pointerdown', () => {
    held = false;
    cancelHold();
    if (!state.lidSupported || item.disabled) return;
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      held = true;
      void toggleLid();
    }, LID_HOLD_MS);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) item.addEventListener(type, cancelHold);
  // Долгое нажатие на телефоне зовёт контекстное меню — оно здесь не нужно.
  item.addEventListener('contextmenu', (e) => e.preventDefault());
  item.addEventListener(
    'click',
    (e) => {
      if (!held) return;
      held = false;
      e.stopImmediatePropagation();
    },
    true,
  );
  const probe = (): void => {
    transport
      .caffeinate()
      .then((next) => {
        if (stopped || !next.supported) return;
        state = next;
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
    cancelHold();
    if (retry) clearTimeout(retry);
    if (lidPoll) clearInterval(lidPoll);
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
