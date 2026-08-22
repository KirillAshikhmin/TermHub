// Чистые части вкладки Gradle: группировка тасок в дерево «проект → группа →
// таска», фильтр поиска, рендеры строк и список недавних запусков. Ни транспорта,
// ни состояния экрана здесь нет — всё проверяется без монтирования вкладки.

import type { GradleRunConfig, GradleTask, GradleTasks } from '@termhub/protocol/frames';

/** Группа тасок внутри проекта («Build tasks», «Verification tasks», …). */
export interface TaskGroupNode {
  group: string;
  tasks: GradleTask[];
}

/** Узел проекта: корневой ':' или подпроект ':app'. */
export interface TaskProjectNode {
  project: string;
  groups: TaskGroupNode[];
}

export type TaskGroupTree = TaskProjectNode[];

function compare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Дерево как в панели Gradle у IDEA (история 6): корневой проект первым,
 * подпроекты по алфавиту; группы — в порядке печати `gradle tasks --all`
 * (`groupOrder`, «Other tasks» там уже последняя); таски внутри группы по алфавиту.
 */
export function groupTasks(data: GradleTasks): TaskGroupTree {
  const rank = new Map(data.groupOrder.map((group, i) => [group, i]));
  const byProject = new Map<string, Map<string, GradleTask[]>>();
  for (const task of data.tasks) {
    let groups = byProject.get(task.project);
    if (!groups) {
      groups = new Map();
      byProject.set(task.project, groups);
    }
    const bucket = groups.get(task.group);
    if (bucket) bucket.push(task);
    else groups.set(task.group, [task]);
  }

  // Корневой проект оказывается первым сам: ':' — префикс любого ':<модуль>',
  // а префикс сортируется раньше. Отдельной ветки под него не нужно.
  const projects = [...byProject.keys()].sort(compare);

  return projects.map((project) => {
    const groups = [...byProject.get(project)!.entries()]
      // Группы, которых нет в groupOrder, уходят в конец — порядок Gradle важнее алфавита.
      .sort((a, b) => (rank.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b[0]) ?? Number.MAX_SAFE_INTEGER))
      .map(([group, tasks]) => ({ group, tasks: [...tasks].sort((x, y) => compare(x.name, y.name)) }));
    return { project, groups };
  });
}

/** Совпадение по имени или описанию, регистр не важен (история 9). */
export function filterTasks(tree: TaskGroupTree, query: string): TaskGroupTree {
  const needle = query.trim().toLowerCase();
  if (!needle) return tree;
  const out: TaskGroupTree = [];
  for (const project of tree) {
    const groups: TaskGroupNode[] = [];
    for (const group of project.groups) {
      const tasks = group.tasks.filter(
        (task) => task.name.toLowerCase().includes(needle) || task.description.toLowerCase().includes(needle),
      );
      if (tasks.length > 0) groups.push({ group: group.group, tasks });
    }
    if (groups.length > 0) out.push({ project: project.project, groups });
  }
  return out;
}

/** Текст с подсветкой совпадений: пустой запрос — просто текст. */
function fillHighlighted(host: HTMLElement, text: string, query: string): void {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    host.textContent = text;
    return;
  }
  const hay = text.toLowerCase();
  const parts: Node[] = [];
  let from = 0;
  for (let at = hay.indexOf(needle, from); at !== -1; at = hay.indexOf(needle, from)) {
    if (at > from) parts.push(document.createTextNode(text.slice(from, at)));
    const mark = document.createElement('mark');
    mark.className = 'th-gmark';
    mark.textContent = text.slice(at, at + needle.length);
    parts.push(mark);
    from = at + needle.length;
  }
  if (from < text.length) parts.push(document.createTextNode(text.slice(from)));
  host.replaceChildren(...parts);
}

function row(kind: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `th-grow th-grow--${kind}`;
  return el;
}

function nameEl(): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'th-grow__name';
  return el;
}

function descEl(text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'th-grow__desc';
  el.textContent = text;
  return el;
}

/** Строка таски: имя + описание подписью. Запуск вешается делегированием по `data-task`. */
export function renderTaskRow(task: GradleTask, query = ''): HTMLButtonElement {
  const el = row('task');
  el.dataset.task = task.name;
  const name = nameEl();
  fillHighlighted(name, task.name, query);
  el.append(name);
  if (task.description) {
    const desc = descEl('');
    fillHighlighted(desc, task.description, query);
    el.append(desc);
  }
  return el;
}

/** Строка конфигурации запуска: имя + таски в порядке из XML и её аргументы. */
export function renderConfigRow(cfg: GradleRunConfig): HTMLButtonElement {
  const el = row('config');
  el.dataset.config = cfg.name;
  const name = nameEl();
  name.textContent = cfg.name;
  el.append(name, descEl([...cfg.tasks, cfg.args].filter(Boolean).join(' ')));
  return el;
}

/** Запуск в списке недавних (история 27). */
export interface RecentRun {
  tasks: string[];
  args: string[];
  subdir: string;
}

export const RECENT_LIMIT = 10;

/** Ключ повтора: тот же набор тасок с теми же аргументами из той же папки.
 *  Он же — ручка из разметки в модель: позиция в списке не годится, потому что
 *  `pushRecent` переупорядочивает массив под уже нарисованными строками. */
export function recentKey(entry: RecentRun): string {
  return JSON.stringify([entry.tasks, entry.args, entry.subdir]);
}

/** Новый запуск — первым; повтор всплывает наверх, а не заводит второй такой же. */
export function pushRecent(list: RecentRun[], entry: RecentRun): RecentRun[] {
  const key = recentKey(entry);
  return [entry, ...list.filter((old) => recentKey(old) !== key)].slice(0, RECENT_LIMIT);
}

/** Строка недавнего запуска: таски и аргументы одной строкой, повтор — одним нажатием. */
export function renderRecentRow(entry: RecentRun): HTMLButtonElement {
  const el = row('recent');
  el.dataset.recent = recentKey(entry);
  const name = nameEl();
  name.textContent = entry.tasks.join(' ');
  el.append(name);
  if (entry.args.length > 0) el.append(descEl(entry.args.join(' ')));
  return el;
}
