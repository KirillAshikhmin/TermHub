// Рабочее пространство сессии: терминал + проводник + репозиторий (+ Gradle у
// Gradle-проекта) как живущие рядом виды (ленивое монтирование по первому показу). Переключение вкладок — показ/скрытие,
// а НЕ пере-монтирование: терминальная сессия (WS) и связь compose↔терминал не рвутся,
// состояние проводника/репозитория сохраняется. Роутер (main.ts/remote.ts) переиспользует
// живой workspace, пока не сменилась сессия/транспорт.

import { whenCap } from './capabilities';
import { mountFeed } from './feed';
import { mountFiles } from './files';
import { resetDocumentTitle, setSessionDocumentTitle } from './document-title';
import type { GradleTab } from './gradle';
import { mountGradleTab } from './gradle';
import { mountRepo } from './repo';
import type { RemoteRoute } from './remote';
import { termHash } from './routes';
import { mountTerminal } from './term';
import type { Transport } from './transport';
import { detectGradle, knownGradle } from './ui';

type WsTab = 'term' | 'files' | 'repo' | 'gradle' | 'feed';

/** Смонтированный вид вкладки; focus есть только у терминала. */
interface WsView {
  el: HTMLElement;
  clean: () => void;
  focus?: () => void;
}

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
  if (route.name === 'sfeed') return { session: route.session, tab: 'feed' };
  return null;
}

/** Монтирует рабочее пространство сессии в root; show(tab) переключает видимость. */
export function mountWorkspace(root: HTMLElement, session: string, transport: Transport): WorkspaceHandle {
  root.replaceChildren();
  setSessionDocumentTitle(session, session);
  const views = new Map<WsTab, WsView>();
  // Вкладка Gradle — единственная, у которой показ повторно спрашивает детект,
  // поэтому от неё держим хэндл, а не только teardown (см. show).
  let gradleView: GradleTab | null = null;
  const ensure = (tab: WsTab): WsView => {
    const cached = views.get(tab);
    if (cached) return cached;
    const el = document.createElement('div');
    el.className = 'th-ws-view';
    root.append(el);
    let v: WsView;
    if (tab === 'term') {
      const term = mountTerminal(el, session, transport);
      v = { el, clean: term.teardown, focus: term.focus };
    } else if (tab === 'files') v = { el, clean: mountFiles(el, transport, session) };
    else if (tab === 'repo') v = { el, clean: mountRepo(el, transport, session) };
    else if (tab === 'feed') v = { el, clean: mountFeed(el, session, transport).teardown };
    else {
      gradleView = mountGradleTab(el, transport, session);
      v = { el, clean: gradleView.teardown };
    }
    views.set(tab, v);
    return v;
  };
  const reveal = (v: WsView): void => {
    for (const other of views.values()) other.el.classList.toggle('is-active', other === v);
  };
  const toTerm = (): void => {
    location.hash = termHash(session);
  };
  let alive = true;
  // Номер последнего показа: пока ответ детекта в пути, пользователь может уйти
  // на другую вкладку — опоздавший ответ не должен перетягивать её на себя.
  let showSeq = 0;
  const show = (tab: WsTab): void => {
    const seq = (showSeq += 1);
    // Ленты у старого агента нет вовсе (ADR 0018), и прямая ссылка на неё уводит на
    // терминал, а не показывает пустой экран. Пересечение считается на подключении,
    // но после перезагрузки обмен может быть ещё в пути — тогда ждём его ответа.
    if (tab === 'feed') {
      void whenCap('feed', transport).then((ok) => {
        if (!alive || seq !== showSeq) return;
        if (ok) reveal(ensure('feed'));
        else toTerm();
      });
      return;
    }
    if (tab === 'gradle') {
      const known = knownGradle(transport, session);
      // Вкладки Gradle у обычной папки нет: прямая ссылка уводит на терминал, а не
      // показывает пустой экран. Пока ответа нет вовсе, вид монтируется и уводит
      // сам (см. mountGradle).
      if (known === null) {
        toTerm();
        return;
      }
      // А вот у уже смонтированного вида askDetect отработал однажды и не
      // повторится: с протухшим ответом спрашиваем сами и показываем только после
      // него — иначе возврат по закладке спустя срок кэша показал бы пустую панель
      // не-Gradle сессии вместо ухода на терминал (история 3).
      if (known === undefined && views.has('gradle')) {
        void detectGradle(transport, session).then(
          (project) => {
            if (!alive || seq !== showSeq) return;
            if (project) reveal(ensure('gradle'));
            else toTerm();
          },
          () => {
            if (!alive || seq !== showSeq) return;
            // Не спросили — вид показываем как есть (он может быть полон списком
            // тасок, и прятать вкладку на время обрыва незачем), но детект он
            // перезадаёт сам: иначе панель не-Gradle сессии осталась бы на
            // загрузочной заглушке навсегда (история 3).
            gradleView?.recheck();
            reveal(ensure('gradle'));
          },
        );
        return;
      }
    }
    const v = ensure(tab);
    // Признак перехода — из состояния ДО показа: роутер зовёт show и на повтор события
    // маршрута для уже активной вкладки, и тогда фокус трогать нельзя — он мог стоять в
    // compose-баре.
    const wasActive = v.el.classList.contains('is-active');
    reveal(v);
    // Вкладка сессии: фокус в терминал ПОСЛЕ показа (скрытый элемент фокус не берёт),
    // только при переходе на неё и безусловно к тумблеру ⌨ — он здесь не условие, а
    // режим поля ввода (см. term.ts).
    if (tab === 'term' && !wasActive) v.focus?.();
  };
  return {
    session,
    transport,
    show,
    teardown: () => {
      alive = false;
      for (const v of views.values()) v.clean();
      views.clear();
      gradleView = null;
      root.replaceChildren();
      resetDocumentTitle();
    },
  };
}
