// Порядок сессий — общий для всех мест, где они показаны: сетка дашборда, панель
// быстрого переключения (стрелка вниз) и полоса вкладок. Иначе одна и та же сессия
// оказывалась бы в разных местах на разных позициях, и «третья сверху» переставало
// быть надёжной приметой.
//
// Модуль чистый: выбор режима читается/пишется здесь, но сравнение ничего не знает
// про DOM и про звонки — признак непрочитанного звонка передаётся предикатом, чтобы
// не тянуть сюда состояние bell-seen (и чтобы сортировку можно было тестировать).

/** Режим сортировки. `activity` — свежие сверху, `name` — по алфавиту,
 *  `bell` — сначала звонящие (ждут ответа), внутри группы по активности. */
export type SortMode = 'activity' | 'name' | 'bell';

export const SORT_MODES: readonly SortMode[] = ['activity', 'name', 'bell'];

const LS_KEY = 'termhub.sessionSort';
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
): T[] {
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name);
  const byActivity = (a: T, b: T): number => b.activityTs - a.activityTs || byName(a, b);
  const compare =
    mode === 'name'
      ? byName
      : mode === 'bell'
        ? (a: T, b: T): number => {
            const ab = hasUnseenBell(a.name) ? 1 : 0;
            const bb = hasUnseenBell(b.name) ? 1 : 0;
            return bb - ab || byActivity(a, b);
          }
        : byActivity;
  return [...sessions].sort(compare);
}
