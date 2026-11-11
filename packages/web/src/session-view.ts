// Общий вид сессии для трёх мест: вкладка (полоса сверху и боковая панель), карточка
// панели быстрого переключения и карточка главной. Механизм один — «шапка сессии»:
// метка агента, точка активности, подпись (заголовок терминала крупно, tmux-имя второй
// строкой) и звонок. Вкладка показывает только шапку (компактно), карточка добавляет под
// ней подробности — но сама шапка у всех строится и обновляется здесь.
//
// Классы элементов идут парой: общий `th-sess__*` (на него смотрят общие стили) и свой
// `<prefix>__*` места (`th-tab`, `th-card`, `th-tabs-current`) — им место правит размеры.

import { makeActivityDot } from './activity-dot';
import type { TFn } from './i18n';
import { sessionAgent, sessionTitleText, type SessionAgent } from './session-status';

/** Что нужно шапке от сессии (SessionInfo подходит структурно). */
export interface SessionHeadInfo {
  name: string;
  title: string;
  bell: boolean;
  /** Команда панели — по ней узнаётся агент. */
  command?: string;
}

/** Буква и полное имя агента для метки. */
export const AGENT_MARK: Record<SessionAgent, { letter: string; name: string }> = {
  claude: { letter: 'C', name: 'Claude Code' },
  codex: { letter: 'X', name: 'Codex' },
  opencode: { letter: 'O', name: 'opencode' },
};

function child(host: HTMLElement, cls: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`:scope > .${cls}`);
}

/** Строит шапку сессии в host и обновляет её на месте: вызывать можно сколько угодно раз,
 *  узлы не пересоздаются (не сбивается фокус и прокрутка). Порядок внутри host: метка
 *  агента, точка активности, подпись, звонок. Возвращает узнанного агента. */
export function syncSessionHead(
  host: HTMLElement,
  prefix: string,
  info: SessionHeadInfo,
  translate: TFn,
  showActivity: boolean,
): SessionAgent | null {
  // Подпись: заголовок терминала (его меняет агент), tmux-имя — второй строкой, если отличается.
  let label = child(host, 'th-sess__label');
  if (!label) {
    label = document.createElement('span');
    label.className = `th-sess__label ${prefix}__label`;
    const nameEl = document.createElement('span');
    nameEl.className = `th-sess__name ${prefix}__name`;
    label.append(nameEl);
    host.prepend(label);
  }
  const nameEl = child(label, 'th-sess__name')!;
  const title = sessionTitleText(info.title);
  const hasTitle = title !== '' && title !== info.name;
  nameEl.textContent = hasTitle ? title : info.name;
  let sub = child(label, 'th-sess__sub');
  if (hasTitle) {
    if (!sub) {
      sub = document.createElement('span');
      sub.className = `th-sess__sub ${prefix}__sub`;
      label.append(sub);
    }
    sub.textContent = info.name;
  } else {
    sub?.remove();
  }

  // Точка активности — перед подписью.
  const dot = child(host, 'th-sess__activity');
  if (showActivity) {
    if (!dot) {
      const made = makeActivityDot(`th-sess__activity ${prefix}__activity`, translate('card.activity'));
      host.insertBefore(made, label);
    }
  } else {
    dot?.remove();
  }

  // Метка агента — буква с подсказкой, самой первой.
  const agent = sessionAgent(info.command ?? '');
  let mark = child(host, 'th-sess__agent');
  if (agent) {
    if (!mark) {
      mark = document.createElement('span');
      mark.className = 'th-sess__agent th-tab__agent';
      host.prepend(mark);
    }
    mark.dataset.agent = agent;
    mark.textContent = AGENT_MARK[agent].letter;
    mark.title = AGENT_MARK[agent].name;
    mark.setAttribute('aria-label', AGENT_MARK[agent].name);
  } else {
    mark?.remove();
  }

  // Звонок — последним.
  let bell = child(host, 'th-sess__bell');
  if (info.bell) {
    if (!bell) {
      bell = document.createElement('span');
      bell.className = `th-sess__bell ${prefix}__bell`;
      bell.setAttribute('aria-label', translate('card.bell'));
      bell.textContent = '🔔';
      host.append(bell);
    }
  } else {
    bell?.remove();
  }
  return agent;
}

/** Проект сессии: имя без хвостового номера (`sprut_app2` → `sprut_app`). */
export function sessionGroup(name: string): string {
  return name.replace(/[\s._-]*\d+$/, '') || name;
}

/** Сессии, собранные по проектам: группы идут в порядке первого появления, внутри
 *  группы порядок прежний — выбранная сортировка не ломается, а лишь кучкуется. */
export function groupSessions<T extends { name: string }>(sessions: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const s of sessions) {
    const key = sessionGroup(s.name);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.values()].flat();
}

/** Снимает заголовки групп: они не элементы сессий и мешают перестановке. */
export function clearGroupHeaders(container: HTMLElement): void {
  for (const head of container.querySelectorAll(':scope > .th-group')) head.remove();
}

/** Ставит заголовок проекта перед первым элементом каждой группы. names — уже в порядке
 *  показа (сгруппированном). Одна группа на весь список — заголовок не нужен. */
export function syncGroupHeaders(
  container: HTMLElement,
  names: string[],
  elementOf: (name: string) => Element | undefined,
): void {
  clearGroupHeaders(container);
  if (new Set(names.map(sessionGroup)).size < 2) return;
  let prev: string | undefined;
  for (const name of names) {
    const group = sessionGroup(name);
    const el = elementOf(name);
    if (!el || el.parentElement !== container || group === prev) continue;
    prev = group;
    const head = document.createElement('div');
    head.className = 'th-group';
    head.textContent = group;
    container.insertBefore(head, el);
  }
}
