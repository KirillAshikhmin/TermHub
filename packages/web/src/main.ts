// Точка входа: определяет режим (`GET /api/mode`) и роутит экраны. LAN — прямой
// путь (login/dashboard/term через LanTransport). Relay — remote-режим грузится
// лениво (динамический import('./remote')): вся крипто/relay-код в отдельном
// чанке, LAN-бандл libsodium не тянет. Hash-роутер (#/login, #/, #/term/<name>,
// #/pair) + инициализация темы/звука + перерисовка на смену языка.

import './theme.css';

import { api } from './api';
import { ACTION_WAIT_MS, actionOfUrl, parseAction } from './app-actions';
import type { AppAction } from './app-actions';
import { negotiateCaps, whenCap } from './capabilities';
import { mountDashboard, mountLogin, openCreateModal } from './dashboard';
import { resetDocumentTitle } from './document-title';
import { mountDiag } from './diag';
import { mountFiles } from './files';
import { getLang, onLangChange } from './i18n';
import type { RemoteController, RemoteRoute } from './remote';
import { initAudioUnlock, playBell } from './sound';
import { shouldRegisterSw } from './sw-register';
import { initTheme } from './theme';
import { parseSplit, termHash } from './routes';
import { mountSplit } from './split';
import { initTermPrefs } from './term-prefs';
import { openTermSettings } from './term-settings';
import { LanTransport } from './transport';
import type { Transport } from './transport';
import { openUsage } from './usage';
import { dismissOverlays } from './ui';
import { mountWorkspace, routeWorkspace } from './workspace';
import type { WorkspaceHandle } from './workspace';

let cleanup: (() => void) | null = null;
let lanTransport: Transport | null = null;
let remote: RemoteController | null = null;
// Живое рабочее пространство сессии (терминал/проводник/репо); переиспользуется, пока
// не сменилась сессия/транспорт — тогда пере-монтируется.
let workspace: WorkspaceHandle | null = null;

// Действие из меню иконки приложения (`#/do/<действие>`): ждёт экрана, на котором его можно
// выполнить, но недолго — окно, всплывшее через минуту после просьбы, уже некстати.
let pending: { action: AppAction; at: number } | null = null;
// Последний адрес экрана: к нему возвращаемся, сняв адрес действия.
let screenHash = '#/';

/** Адрес — просьба о действии? Тогда запоминаем её и возвращаем адрес экрана. */
function takeAction(): boolean {
  const action = parseAction(location.hash);
  if (!action) return false;
  pending = { action, at: Date.now() };
  history.replaceState(null, '', screenHash);
  return true;
}

function runPending(): void {
  if (!pending) return;
  const { action, at } = pending;
  if (Date.now() - at > ACTION_WAIT_MS) {
    pending = null;
    return;
  }
  if (action === 'settings') {
    pending = null;
    openTermSettings();
    return;
  }
  const route = parseRoute().name;
  const transport = remote ? remote.activeTransport() : lanTransport;
  if (!transport || route === 'login' || route === 'pair') return;
  pending = null;
  if (action === 'new') openCreateModal(transport);
  else void whenCap('usage', transport).then((can) => can && openUsage(transport));
}

function appRoot(): HTMLElement {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app not found');
  return root;
}

function parseRoute(): RemoteRoute {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/login')) return { name: 'login' };
  if (hash.startsWith('#/pair')) return { name: 'pair' };
  if (hash.startsWith('#/files')) return { name: 'files' };
  if (hash.startsWith('#/diag')) return { name: 'diag' };
  const split = parseSplit(hash);
  if (split) return { name: 'split', sessions: split };
  const sfiles = /^#\/sfiles\/([^/]*)/.exec(hash);
  if (sfiles) {
    try {
      return { name: 'sfiles', session: decodeURIComponent(sfiles[1]!) };
    } catch {
      return { name: 'dashboard' };
    }
  }
  const srepo = /^#\/srepo\/([^/]*)/.exec(hash);
  if (srepo) {
    try {
      return { name: 'srepo', session: decodeURIComponent(srepo[1]!) };
    } catch {
      return { name: 'dashboard' };
    }
  }
  const sgradle = /^#\/sgradle\/([^/]*)/.exec(hash);
  if (sgradle) {
    try {
      return { name: 'sgradle', session: decodeURIComponent(sgradle[1]!) };
    } catch {
      return { name: 'dashboard' };
    }
  }
  const sfeed = /^#\/sfeed\/([^/]*)/.exec(hash);
  if (sfeed) {
    try {
      return { name: 'sfeed', session: decodeURIComponent(sfeed[1]!) };
    } catch {
      return { name: 'dashboard' };
    }
  }
  const term = /^#\/term\/(.+)$/.exec(hash);
  if (term) {
    try {
      return { name: 'term', session: decodeURIComponent(term[1]!) };
    } catch {
      return { name: 'dashboard' };
    }
  }
  return { name: 'dashboard' };
}

function render(): void {
  renderScreen();
  runPending();
}

function renderScreen(): void {
  // Смена роута: сносим висящие модалки/тосты вместе с их document-слушателями.
  dismissOverlays();
  const root = appRoot();
  const route = parseRoute();
  const transport = remote ? remote.activeTransport() : lanTransport;
  // Объявление возможностей (ADR 0018) в LAN: обмен один на транспорт, но не на
  // экране входа — незалогиненному агент отвечает 401, а это про вход, не про
  // умения агента. Любой другой экран означает живую cookie (или только что
  // выполненный вход), и там обмен уместен. В relay его ведёт remote.ts по online.
  if (!remote && transport && route.name !== 'login') void negotiateCaps(transport);
  const wsRoute = routeWorkspace(route);

  // Session-scoped роут при живом транспорте → рабочее пространство: вкладки живут,
  // переключение = показ/скрытие (терминал и его WS/compose не пересоздаются).
  if (wsRoute && transport) {
    if (workspace && workspace.session === wsRoute.session && workspace.transport === transport) {
      workspace.show(wsRoute.tab);
      return;
    }
    workspace?.teardown();
    cleanup?.();
    cleanup = null;
    workspace = mountWorkspace(root, wsRoute.session, transport);
    workspace.show(wsRoute.tab);
    return;
  }

  // Иначе — сносим живой workspace и рендерим обычный экран.
  workspace?.teardown();
  workspace = null;
  resetDocumentTitle();
  cleanup?.();
  cleanup = null;
  // Сплит-вид: несколько сессий рядом — нужен живой транспорт; без него (relay ещё не
  // выбран) ниже отработает обычный путь и покажет выбор агента.
  if (route.name === 'split' && transport) {
    // Одна сессия — это уже не сплит, а обычный терминал.
    if (route.sessions.length < 2) {
      location.replace(termHash(route.sessions[0]!));
      return;
    }
    cleanup = mountSplit(root, route.sessions, transport);
    return;
  }
  // Диагностика — отдельная страница (LAN-режим; в relay покажет подсказку).
  if (route.name === 'diag') {
    cleanup = mountDiag(root, transport ?? undefined);
    return;
  }
  // Relay-режим (не workspace): выбор агента/пейринг/дашборд — remote-контроллер.
  if (remote) {
    cleanup = remote.render(root, route);
    return;
  }
  const t = lanTransport!;
  if (route.name === 'login') cleanup = mountLogin(root);
  else if (route.name === 'files') cleanup = mountFiles(root, t);
  else cleanup = mountDashboard(root, t);
}

/** Запуск из меню иконки при уже открытом окне (`launch_handler: focus-existing`): страница
 *  не переходит, адрес запуска отдаёт `launchQueue`. Первый запуск окна с адресом действия
 *  уже разобран по hash — его повтор из очереди пропускаем. */
function watchLaunches(): void {
  const queue = (window as { launchQueue?: { setConsumer(fn: (p: { targetURL?: string }) => void): void } })
    .launchQueue;
  if (!queue) return;
  let first = true;
  queue.setConsumer((params) => {
    const own = first && params.targetURL === initialHref;
    first = false;
    const action = params.targetURL ? actionOfUrl(params.targetURL) : null;
    if (!action || own) return;
    pending = { action, at: Date.now() };
    runPending();
  });
}

const initialHref = location.href;

async function boot(): Promise<void> {
  document.documentElement.lang = getLang();
  initTheme();
  initTermPrefs();
  initAudioUnlock();

  let mode: 'lan' | 'relay' = 'lan';
  let relayTransport: unknown;
  try {
    const info = await api.mode();
    mode = info.mode;
    relayTransport = info.transport;
  } catch {
    // /api/mode недоступен — работаем как LAN (экран входа сам покажет ошибку сети).
  }

  if (mode === 'relay') {
    const { createRemote } = await import('./remote');
    remote = await createRemote({ rerender: render, transport: relayTransport });
  } else {
    lanTransport = new LanTransport();
  }

  // Роутер подключаем только после инициализации транспорта — до этого render()
  // не должен запускаться (иначе lanTransport ещё null).
  if (!takeAction()) screenHash = location.hash || '#/';
  window.addEventListener('hashchange', () => {
    // Просьба о действии экран не меняет: адрес уже возвращён, осталось её выполнить.
    if (takeAction()) {
      runPending();
      return;
    }
    screenHash = location.hash || '#/';
    render();
  });
  watchLaunches();
  // Смена языка перерисовывает всё, включая живое рабочее пространство сессии: роутер его
  // переиспользует, и без пересборки экран сессии оставался на прежнем языке — выглядело
  // так, будто язык обратно не переключается.
  onLangChange(() => {
    workspace?.teardown();
    workspace = null;
    render();
  });
  render();
}

// Регистрируем service worker (PWA-установка + web-push) только там, где он вообще
// работает; приложение живёт и без SW, но ошибку не глушим молча — иначе будущий
// сбой регистрации (напр. sw.js перестал быть classic-совместимым) убьёт PWA/push
// без единого сигнала. Пишем предупреждение в консоль.
if (shouldRegisterSw({ isSecureContext: window.isSecureContext, hasServiceWorker: 'serviceWorker' in navigator })) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(
      (reg) => {
        // Явно спрашиваем обновление при запуске и при каждом возврате в приложение.
        // Установленная PWA может месяцами не перезагружаться, а протокол агент↔клиент
        // меняется вместе с бандлом: залипший старый клиент просто перестаёт
        // подключаться. Новая версия активируется сама (skipWaiting + clients.claim).
        const checkUpdate = (): void => {
          if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
        };
        checkUpdate();
        document.addEventListener('visibilitychange', checkUpdate);
        // Звук пуш-уведомления выбирает система (канал уведомлений) — из веба его
        // не задать. Поэтому SW просит открытую страницу проиграть наш «звонок»:
        // тот же звук, что и при звонке в активном приложении. Работает, пока
        // страница жива и аудио разблокировано; иначе слышен системный звук.
        navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as { t?: unknown } | null;
          if (data && data.t === 'termhub-bell') playBell();
        });
      },
      (err: unknown) => console.warn('SW registration failed:', err),
    );
  });
}

void boot();
