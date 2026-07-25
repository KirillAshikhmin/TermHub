// Точка входа: определяет режим (`GET /api/mode`) и роутит экраны. LAN — прямой
// путь (login/dashboard/term через LanTransport). Relay — remote-режим грузится
// лениво (динамический import('./remote')): вся крипто/relay-код в отдельном
// чанке, LAN-бандл libsodium не тянет. Hash-роутер (#/login, #/, #/term/<name>,
// #/pair) + инициализация темы/звука + перерисовка на смену языка.

import './theme.css';

import { api } from './api';
import { mountDashboard, mountLogin } from './dashboard';
import { mountDiag } from './diag';
import { mountFiles } from './files';
import { getLang, onLangChange } from './i18n';
import type { RemoteController, RemoteRoute } from './remote';
import { initAudioUnlock } from './sound';
import { shouldRegisterSw } from './sw-register';
import { initTheme } from './theme';
import { LanTransport } from './transport';
import type { Transport } from './transport';
import { dismissOverlays } from './ui';
import { mountWorkspace, routeWorkspace } from './workspace';
import type { WorkspaceHandle } from './workspace';

let cleanup: (() => void) | null = null;
let lanTransport: Transport | null = null;
let remote: RemoteController | null = null;
// Живое рабочее пространство сессии (терминал/проводник/репо); переиспользуется, пока
// не сменилась сессия/транспорт — тогда пере-монтируется.
let workspace: WorkspaceHandle | null = null;

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
  // Смена роута: сносим висящие модалки/тосты вместе с их document-слушателями.
  dismissOverlays();
  const root = appRoot();
  const route = parseRoute();
  const transport = remote ? remote.activeTransport() : lanTransport;
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
  cleanup?.();
  cleanup = null;
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

async function boot(): Promise<void> {
  document.documentElement.lang = getLang();
  initTheme();
  initAudioUnlock();

  let mode: 'lan' | 'relay' = 'lan';
  try {
    mode = (await api.mode()).mode;
  } catch {
    // /api/mode недоступен — работаем как LAN (экран входа сам покажет ошибку сети).
  }

  if (mode === 'relay') {
    const { createRemote } = await import('./remote');
    remote = await createRemote({ rerender: render });
  } else {
    lanTransport = new LanTransport();
  }

  // Роутер подключаем только после инициализации транспорта — до этого render()
  // не должен запускаться (иначе lanTransport ещё null).
  window.addEventListener('hashchange', render);
  onLangChange(render);
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
      },
      (err: unknown) => console.warn('SW registration failed:', err),
    );
  });
}

void boot();
