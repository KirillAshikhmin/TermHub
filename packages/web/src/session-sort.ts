// Порядок сессий — общий для всех мест, где они показаны: сетка дашборда, панель
// быстрого переключения (стрелка вниз) и полоса вкладок. Иначе одна и та же сессия
// оказывалась бы в разных местах на разных позициях, и «третья сверху» переставало
// быть надёжной приметой.
//
// Модуль чистый: выбор режима читается/пишется здесь, но сравнение ничего не знает
// про DOM и про звонки — признак непрочитанного звонка передаётся предикатом, чтобы
// не тянуть сюда состояние bell-seen (и чтобы сортировку можно было тестировать).

/** Режим сортировки. `activity` — свежие сверху, `name` — по алфавиту,
 *  `bell` — сначала звонящие (ждут ответа), внутри группы по активности,
 *  `manual` — порядок, который пользователь расставил сам. */
export type SortMode = 'activity' | 'name' | 'bell' | 'manual';

export const SORT_MODES: readonly SortMode[] = ['activity', 'name', 'bell', 'manual'];

const LS_KEY = 'termhub.sessionSort';
const ORDER_KEY = 'termhub.sessionOrder';
const DEFAULT_MODE: SortMode = 'activity';

function isSortMode(value: unknown): value is SortMode {
  return typeof value === 'string' && (SORT_MODES as readonly string[]).includes(value);
}

/** Текущий режим (localStorage). Недоступное/битое хранилище → режим по умолчанию. */
export function readSortMode(): SortMode {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return isSortMode(raw) ? raw : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function writeSortMode(mode: SortMode): void {
  try {
    localStorage.setItem(LS_KEY, mode);
  } catch {
    // Персист выбора необязателен — режим просто не переживёт перезагрузку.
  }
}

/** Ручной порядок — список имён. Сессии вне списка (новые) идут после него.
 *  Список не чистим от исчезнувших имён: сессия может вернуться (tmux пережил
 *  перезапуск агента), и её место сохранится. */
export function readManualOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeManualOrder(order: readonly string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // Персист необязателен — порядок просто не переживёт перезагрузку.
  }
}

/**
 * Новый порядок с `name`, сдвинутым на одну позицию (delta -1 вверх, +1 вниз).
 * Вход не мутируем. `visible` — имена, которые сейчас на экране: двигаем ОТНОСИТЕЛЬНО
 * них, иначе один шаг мог бы «перепрыгнуть» через давно исчезнувшую сессию, всё ещё
 * записанную в порядке, и выглядеть как ничего не произошло.
 */
export function moveInOrder(order: readonly string[], visible: readonly string[], name: string, delta: -1 | 1): string[] {
  const seq = [...visible];
  const from = seq.indexOf(name);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= seq.length) return [...order];
  seq.splice(to, 0, ...seq.splice(from, 1));
  // Имена вне текущего экрана сохраняем в хвосте, чтобы их место не потерялось.
  const rest = order.filter((n) => !visible.includes(n));
  return [...seq, ...rest];
}

/** Минимум, по которому сортируем (SessionInfo подходит структурно). */
export interface SortableSession {
  name: string;
  activityTs: number;
}

/**
 * Возвращает НОВЫЙ отсортированный массив (вход не мутируем: он приходит из кэша
 * и из снимков, которые переиспользуются).
 *
 * Имя — тай-брейкер во всех режимах: без него сессии с одинаковой меткой времени
 * (типично сразу после создания) переставлялись бы местами на каждом полле.
 */
export function sortSessions<T extends SortableSession>(
  sessions: readonly T[],
  mode: SortMode,
  hasUnseenBell: (name: string) => boolean = () => false,
  manualOrder: readonly string[] = [],
): T[] {
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name);
  const byActivity = (a: T, b: T): number => b.activityTs - a.activityTs || byName(a, b);
  // Ручной режим: позиция из сохранённого списка; чего в нём нет (новая сессия) —
  // в конец, между собой по активности.
  const manualRank = (n: string): number => {
    const i = manualOrder.indexOf(n);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const compare =
    mode === 'name'
      ? byName
      : mode === 'manual'
        ? (a: T, b: T): number => manualRank(a.name) - manualRank(b.name) || byActivity(a, b)
        : mode === 'bell'
          ? (a: T, b: T): number => {
              const ab = hasUnseenBell(a.name) ? 1 : 0;
              const bb = hasUnseenBell(b.name) ? 1 : 0;
              return bb - ab || byActivity(a, b);
            }
          : byActivity;
  return [...sessions].sort(compare);
}
