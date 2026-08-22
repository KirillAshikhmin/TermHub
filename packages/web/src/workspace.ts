// Рабочее пространство сессии: терминал + проводник + репозиторий (+ Gradle у
// Gradle-проекта) как живущие рядом виды (ленивое монтирование по первому показу). Переключение вкладок — показ/скрытие,
// а НЕ пере-монтирование: терминальная сессия (WS) и связь compose↔терминал не рвутся,
// состояние проводника/репозитория сохраняется. Роутер (main.ts/remote.ts) переиспользует
// живой workspace, пока не сменилась сессия/транспорт.

import { mountFiles } from './files';
import { mountGradle } from './gradle';
import { mountRepo } from './repo';
import type { RemoteRoute } from './remote';
import { openTerminal } from './term';
import type { Transport } from './transport';
import { knownGradle } from './ui';

type WsTab = 'term' | 'files' | 'repo' | 'gradle';

export interface WorkspaceHandle {
  session: string;
  transport: Transport;
  show(tab: WsTab): void;
  teardown(): void;
}

/** Session-scoped роут (терминал/проводник/репо одной сессии) → {session, tab} | null. */
export function routeWorkspace(route: RemoteRoute): { session: string; tab: WsTab } | null {
  if (route.name === 'term') return { session: route.session, tab: 'term' };
  if (route.name === 'sfiles') return { session: route.session, tab: 'files' };
  if (route.name === 'srepo') return { session: route.session, tab: 'repo' };
  if (route.name === 'sgradle') return { session: route.session, tab: 'gradle' };
  return null;
}

/** Монтирует рабочее пространство сессии в root; show(tab) переключает видимость. */
export function mountWorkspace(root: HTMLElement, session: string, transport: Transport): WorkspaceHandle {
  root.replaceChildren();
  const views = new Map<WsTab, { el: HTMLElement; clean: () => void }>();
  const ensure = (tab: WsTab): { el: HTMLElement; clean: () => void } => {
    const cached = views.get(tab);
    if (cached) return cached;
    const el = document.createElement('div');
    el.className = 'th-ws-view';
    root.append(el);
    const clean =
      tab === 'term'
        ? openTerminal(el, session, transport)
        : tab === 'files'
          ? mountFiles(el, transport, session)
          : tab === 'repo'
            ? mountRepo(el, transport, session)
            : mountGradle(el, transport, session);
    const v = { el, clean };
    views.set(tab, v);
    return v;
  };
  const show = (tab: WsTab): void => {
    // Вкладки Gradle у обычной папки нет: прямая ссылка уводит на терминал, а не
    // показывает пустой экран. Детект уже спрошен Holo-баром и кэширован; пока
    // ответа нет, вид монтируется и уводит сам (см. mountGradle).
    if (tab === 'gradle' && knownGradle(transport, session) === null) {
      location.hash = `#/term/${encodeURIComponent(session)}`;
      return;
    }
    const v = ensure(tab);
    for (const other of views.values()) other.el.classList.toggle('is-active', other === v);
  };
  return {
    session,
    transport,
    show,
    teardown: () => {
      for (const v of views.values()) v.clean();
      views.clear();
      root.replaceChildren();
    },
  };
}
