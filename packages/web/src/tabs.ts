// Полоса табов активных сессий в шапке терминала: переключение между
// tmux-сессиями без возврата на дашборд. Чистые рендеры (тестируются
// отдельно) + mountSessionTabs, владеющий поллингом списка через транспорт.

import type { TFn } from './i18n';
import { t } from './i18n';
import type { Transport } from './transport';
import { iconButton, svgIcon, toast } from './ui';
import { makeActivityDot } from './activity-dot';
import { activity } from './activity';
import { sessionManaged, sessionTitleText, sessionWorking } from './session-status';
import { bellUnseen, markBellSeen, observeBells } from './bell-seen';

const POLL_INTERVAL = 3000;

/** Сосед для перехода при закрытии текущей вкладки: тот, что был слева; если
 *  закрыли самую левую — новый первый (сосед справа). null, если вкладок не
 *  осталось (тогда вызывающий уходит на дашборд). */
export function pickNeighbor(names: string[], removed: string): string | null {
  const rest = names.filter((n) => n !== removed);
  if (rest.length === 0) return null;
  const i = names.indexOf(removed);
  return names[i - 1] ?? rest[0]!;
}

/** Верхняя панель сессии (как на терминале): «назад» + вкладки сессий. Переиспользуется
 *  на session-scoped Проводнике/Репозитории, чтобы панель сессий была на любой вкладке.
 *  onSwitch — навигация при клике на таб (тип экрана задаёт вызывающий). */
export function mountSessionBar(opts: {
  transport: Transport;
  current: string;
  onSwitch: (name: string) => void;
  onCreate: () => void;
}): { el: HTMLElement; teardown: () => void } {
  const bar = document.createElement('div');
  bar.className = 'th-termbar';
  bar.append(iconButton('back', t('term.back'), () => (location.hash = '#/')));
  const tabs = mountSessionTabs({
    transport: opts.transport,
    current: opts.current,
    onSwitch: opts.onSwitch,
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
  });
  bar.append(tabs.el);
  return { el: bar, teardown: tabs.teardown };
}

/** Минимум, который нужен табу от сессии (SessionInfo подходит структурно). */
export interface TabInfo {
  name: string;
  bell: boolean;
  title: string;
}

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
  const label = document.createElement('span');
  label.className = 'th-tab__label';
  const name = document.createElement('span');
  name.className = 'th-tab__name';
  label.append(name);
  main.append(label);
  main.addEventListener('click', () => onSwitch(info.name));
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

/** Точка активности — первый элемент в .th-tab__btn (перед именем). */
function setTabActivityDot(main: HTMLElement | null, translate: TFn, show: boolean): void {
  if (!main) return;
  const dot = main.querySelector<HTMLElement>('.th-tab__activity');
  if (show) {
    if (!dot) main.prepend(makeActivityDot('th-tab__activity', translate('card.activity')));
  } else {
    dot?.remove();
  }
}

/** Подпись таба: заголовок терминала (крупно) + tmux-имя (мелко, второй строкой),
 *  если отличается. Индикатор активности из заголовка срезан (он — точкой).
 *  Обновляется на месте — заголовок меняет Claude. */
function setTabLabel(main: HTMLElement | null, info: TabInfo): void {
  const label = main?.querySelector<HTMLElement>('.th-tab__label');
  const nameEl = label?.querySelector<HTMLElement>('.th-tab__name');
  if (!label || !nameEl) return;
  const title = sessionTitleText(info.title);
  const hasTitle = title !== '' && title !== info.name;
  nameEl.textContent = hasTitle ? title : info.name;
  let sub = label.querySelector<HTMLElement>('.th-tab__sub');
  if (hasTitle) {
    if (!sub) {
      sub = document.createElement('span');
      sub.className = 'th-tab__sub';
      label.append(sub);
    }
    sub.textContent = info.name;
  } else {
    sub?.remove();
  }
}

/** Обновляет таб НА МЕСТЕ: подсветка активного, значок звонка (только на
 *  неактивных — активная сессия и так звенит через свой канал). */
export function updateSessionTab(
  tab: HTMLElement,
  info: TabInfo,
  active: boolean,
  translate: TFn,
  showActivity = false,
): void {
  tab.classList.toggle('is-active', active);
  const main = tab.querySelector<HTMLElement>('.th-tab__btn');
  main?.setAttribute('aria-current', active ? 'true' : 'false');
  setTabActivityDot(main, translate, showActivity);
  setTabLabel(main, info);

  const showBell = info.bell && !active;
  let bell = tab.querySelector<HTMLElement>('.th-tab__bell');
  if (showBell) {
    if (!bell && main) {
      bell = document.createElement('span');
      bell.className = 'th-tab__bell';
      bell.setAttribute('aria-label', translate('card.bell'));
      bell.textContent = '🔔';
      main.append(bell);
    }
  } else {
    bell?.remove();
  }
}

export interface SessionTabsOpts {
  transport: Transport;
  /** Имя текущей сессии: её таб существует с первого кадра и не удаляется,
   *  даже когда сессия пропала из списка (конец показывает оверлей терминала). */
  current: string;
  onSwitch(name: string): void;
  /** Завершение сессии по крестику (подтверждение — на вызывающей стороне). */
  onKill(name: string): void;
  onCreate(): void;
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
  let latest: TabInfo[] = [{ name: opts.current, bell: false, title: '' }];
  let panelOpen = false;

  const panel = document.createElement('div');
  panel.className = 'th-spanel';
  const sheet = document.createElement('div');
  sheet.className = 'th-spanel__sheet';
  const list = document.createElement('div');
  list.className = 'th-spanel__list';
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'th-btn th-btn--primary th-spanel__create';
  createBtn.append(svgIcon('plus'), document.createTextNode(t('dashboard.newSession')));
  createBtn.addEventListener('click', () => {
    closePanel();
    opts.onCreate();
  });
  sheet.append(list, createBtn);
  panel.append(sheet);
  panel.inert = true; // стартовое состояние — закрыта
  panel.addEventListener('click', (e) => {
    if (e.target === panel) closePanel(); // тап по затемнённому фону закрывает
  });
  // Escape закрывает панель (ожидаемое поведение оверлея).
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && panelOpen) {
      e.preventDefault();
      closePanel();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  const expandBtn = iconButton('down', t('term.sessionsPanel'), () => (panelOpen ? closePanel() : openPanel()));
  expandBtn.classList.add('th-tabs-expand');
  expandBtn.setAttribute('aria-haspopup', 'true');
  expandBtn.setAttribute('aria-expanded', 'false');

  // Строит строки панели из последнего известного списка (снимок на момент открытия).
  const buildPanelRows = (): void => {
    list.replaceChildren();
    // Текущая сессия присутствует всегда (как и в полосе), даже если её нет в списке.
    const rows = latest.some((s) => s.name === opts.current)
      ? latest
      : [{ name: opts.current, bell: false, title: '' } as TabInfo, ...latest];
    for (const s of rows) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'th-spanel__row';
      if (s.name === opts.current) row.classList.add('is-current');
      const hot = sessionWorking(s.title) || (!sessionManaged(s.title) && activity.isHot(s.name));
      if (hot) row.append(makeActivityDot('th-spanel__activity', t('card.activity')));
      const lbl = document.createElement('span');
      lbl.className = 'th-spanel__label';
      const title = sessionTitleText(s.title);
      const hasTitle = title !== '' && title !== s.name;
      const nm = document.createElement('span');
      nm.className = 'th-spanel__name';
      nm.textContent = hasTitle ? title : s.name;
      lbl.append(nm);
      if (hasTitle) {
        const sub = document.createElement('span');
        sub.className = 'th-spanel__sub';
        sub.textContent = s.name;
        lbl.append(sub);
      }
      row.append(lbl);
      if (bellUnseen(s.name) && s.name !== opts.current) {
        const bell = document.createElement('span');
        bell.className = 'th-spanel__bell';
        bell.setAttribute('aria-label', t('card.bell'));
        bell.textContent = '🔔';
        row.append(bell);
      }
      row.addEventListener('click', () => {
        closePanel();
        opts.onSwitch(s.name);
      });
      list.append(row);
    }
  };
  function closePanel(): void {
    panelOpen = false;
    panel.classList.remove('is-open');
    panel.inert = true; // закрытая панель — вне порядка табуляции и недоступна скринридеру
    expandBtn.classList.remove('is-open');
    expandBtn.setAttribute('aria-expanded', 'false');
  }
  function openPanel(): void {
    panelOpen = true;
    buildPanelRows();
    panel.inert = false;
    panel.classList.add('is-open');
    expandBtn.classList.add('is-open');
    expandBtn.setAttribute('aria-expanded', 'true');
  }

  wrap.append(strip, expandBtn, panel);

  const tabs = new Map<string, HTMLElement>();
  const currentTab = renderSessionTab(
    { name: opts.current, bell: false, title: '' },
    true,
    t,
    opts.onSwitch,
    opts.onKill,
  );
  tabs.set(opts.current, currentTab);
  strip.append(currentTab);

  // Точечное обновление, как в дашборде: не пересоздаём узлы, чтобы не сбрасывать
  // горизонтальный скролл полосы и фокус.
  const render = (sessions: TabInfo[]): void => {
    latest = sessions; // снимок для панели быстрого переключения
    if (panelOpen) buildPanelRows(); // панель открыта во время поллинга — держим свежей
    const wanted = new Set(sessions.map((s) => s.name));
    wanted.add(opts.current);
    for (const [name, el] of [...tabs]) {
      if (!wanted.has(name)) {
        el.remove();
        tabs.delete(name);
      }
    }
    markBellSeen(opts.current); // текущую сессию смотрим — её звонок прочитан
    for (const s of sessions) {
      const existing = tabs.get(s.name);
      const isCurrent = s.name === opts.current;
      // Работает: Claude-спиннер в заголовке; не-Claude сессии — fallback по
      // session_activity (потока к ним нет, судим по опросу).
      const show = sessionWorking(s.title) || (!sessionManaged(s.title) && activity.isHot(s.name));
      // 🔔 — только пока звонок «не прочитан» (не открывали сессию).
      const info = { ...s, bell: bellUnseen(s.name) };
      if (existing) updateSessionTab(existing, info, isCurrent, t, show);
      else {
        const el = renderSessionTab(info, isCurrent, t, opts.onSwitch, opts.onKill, show);
        tabs.set(s.name, el);
        strip.append(el);
      }
    }
    // Порядок — как в списке агента; перестановка сбросила бы фокус, поэтому
    // пропускаем, пока фокус внутри полосы. Узлы вне списка (текущая пропавшая
    // сессия) дрейфуют в конец.
    const focusInside = document.activeElement instanceof Node && strip.contains(document.activeElement);
    if (!focusInside) {
      let anchor: ChildNode | null = strip.firstChild;
      for (const s of sessions) {
        const el = tabs.get(s.name);
        if (!el) continue;
        if (el === anchor) anchor = anchor.nextSibling;
        else strip.insertBefore(el, anchor);
      }
    }
  };

  let stopped = false;
  let scrolledOnce = false;
  const refresh = async (): Promise<void> => {
    try {
      const sessions = await opts.transport.list();
      if (stopped) return;
      activity.observe(sessions);
      observeBells(sessions);
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
  void refresh();

  return {
    el: wrap,
    teardown(): void {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('keydown', onKeyDown);
    },
    refresh,
  };
}
