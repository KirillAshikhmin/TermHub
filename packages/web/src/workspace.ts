// Рабочее пространство сессии: терминал + проводник + репозиторий как ТРИ живущих
// вида (ленивое монтирование по первому показу). Переключение вкладок — показ/скрытие,
// а НЕ пере-монтирование: терминальная сессия (WS) и связь compose↔терминал не рвутся,
// состояние проводника/репозитория сохраняется. Роутер (main.ts/remote.ts) переиспользует
// живой workspace, пока не сменилась сессия/транспорт.

import { mountFiles } from './files';
import { mountRepo } from './repo';
import type { RemoteRoute } from './remote';
import { openTerminal } from './term';
import type { Transport } from './transport';

type WsTab = 'term' | 'files' | 'repo';

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
          : mountRepo(el, transport, session);
    const v = { el, clean };
    views.set(tab, v);
    return v;
  };
  const show = (tab: WsTab): void => {
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
