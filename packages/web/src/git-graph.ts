// Раскладка коммитов по «дорожкам» (lanes) для графа истории — то, чем git-клиенты
// рисуют линии слева от списка.
//
// Модуль чистый: на вход список коммитов с родителями (порядок — топологический, как
// отдаёт `git log --topo-order`), на выход — колонка каждого коммита и рёбра, которые
// проходят через его строку. Ничего не знает про DOM, поэтому раскладку можно
// проверить тестами, а рисование остаётся тривиальным.
//
// Алгоритм — классический «резервирование дорожек»: идём сверху вниз, у каждого
// коммита забираем дорожку, которую для него зарезервировал потомок (или берём
// свободную), затем резервируем дорожки под его родителей. Первый родитель наследует
// дорожку коммита, чтобы прямая линия ветки не прыгала вбок на каждом слиянии.

export interface GraphCommit {
  rev: string;
  parents?: string[];
}

/** Ребро, проходящее через строку: из колонки `from` вверху в `to` внизу. */
export interface GraphEdge {
  from: number;
  to: number;
}

export interface GraphRow {
  rev: string;
  /** Колонка точки коммита. */
  lane: number;
  /** Линии, которые пересекают эту строку (включая входящую в точку и исходящие). */
  edges: GraphEdge[];
  /** true, если у коммита больше одного родителя — точку рисуем крупнее. */
  merge: boolean;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Сколько колонок занял граф — по нему считается ширина отступа под список. */
  width: number;
}

/** Первая свободная дорожка (переиспользуем освободившиеся, чтобы граф не расползался). */
function firstFree(lanes: (string | null)[]): number {
  const idx = lanes.indexOf(null);
  if (idx >= 0) return idx;
  lanes.push(null);
  return lanes.length - 1;
}

/**
 * Раскладывает коммиты по дорожкам.
 *
 * Коммиты, чьи родители не попали в выборку (лог обрезан лимитом), просто закрывают
 * свою дорожку — иначе линия уходила бы в никуда и висела до конца списка.
 */
export function layoutGraph(commits: readonly GraphCommit[]): GraphLayout {
  const known = new Set(commits.map((c) => c.rev));
  // lanes[i] — ревизия, которую ожидаем увидеть в дорожке i (зарезервирована потомком).
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 0;

  for (const commit of commits) {
    // Дорожка коммита: та, что для него зарезервировали, иначе свободная.
    let lane = lanes.indexOf(commit.rev);
    if (lane < 0) lane = firstFree(lanes);

    // Состояние ДО перестановки родителей — из него берём «верх» каждой линии.
    const before = [...lanes];
    lanes[lane] = null;

    const parents = (commit.parents ?? []).filter((p) => known.has(p));
    parents.forEach((parent, i) => {
      if (i === 0) {
        // Первый родитель продолжает дорожку коммита — линия ветки идёт прямо вниз.
        lanes[lane] = parent;
        return;
      }
      // Прочие родители (слияние): если такой уже кем-то ожидается, ведём линию туда,
      // не заводя дубликат дорожки.
      const existing = lanes.indexOf(parent);
      if (existing < 0) lanes[firstFree(lanes)] = parent;
    });

    const edges: GraphEdge[] = [];
    // Транзитные линии: всё, что ожидалось и продолжает ожидаться, идёт насквозь.
    before.forEach((rev, col) => {
      if (rev === null || rev === commit.rev) return;
      const to = lanes.indexOf(rev);
      if (to >= 0) edges.push({ from: col, to });
    });
    // Исходящие из точки коммита — к каждому его родителю.
    for (const parent of parents) {
      const to = lanes.indexOf(parent);
      if (to >= 0) edges.push({ from: lane, to });
    }

    width = Math.max(width, lanes.length, lane + 1);
    rows.push({ rev: commit.rev, lane, edges, merge: (commit.parents?.length ?? 0) > 1 });
  }

  return { rows, width: Math.max(width, 1) };
}
