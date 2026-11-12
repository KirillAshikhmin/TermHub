// Сбои чата и плашка «версия не проверена» — на устройстве (localStorage): через relay
// диагностики агента нет, а счётчик должен работать везде одинаково.
//
// Сбой — экран не узнан, режим или модель не сменились после клавиш, действие отвергнуто
// как неподдерживаемое. «Вопрос уже не актуален», известное меню и обрыв связи — не сбои.
export type FailureKind = 'unknown' | 'mode' | 'model' | 'unsupported';

export interface HealthRow {
  session: string;
  agent: string;
  version?: string;
  counts: Partial<Record<FailureKind, number>>;
  /** Время последнего сбоя, мс. */
  last: number;
  /** Последняя названная агентом причина неузнанного экрана и её время, мс. */
  why?: string;
  whyAt?: number;
}

const HEALTH_KEY = 'termhub.chatHealth';
const VERSIONS_KEY = 'termhub.chatVersionsSeen';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Хранилище недоступно — счётчик на этом устройстве просто не копится.
  }
}

export function noteFailure(session: string, kind: FailureKind, agent: string, version?: string, why?: string): void {
  const all = read<Record<string, HealthRow>>(HEALTH_KEY, {});
  const row: HealthRow = all[session] ?? { session, agent, counts: {}, last: 0 };
  row.agent = agent;
  if (version !== undefined) row.version = version;
  row.counts[kind] = (row.counts[kind] ?? 0) + 1;
  row.last = Date.now();
  if (why) {
    row.why = why;
    row.whyAt = row.last;
  }
  all[session] = row;
  write(HEALTH_KEY, all);
}

/** Экран, которого чат не узнал; `why` — причина от распознавания, если агент её назвал. */
export function noteUnknown(session: string, agent: string, version?: string, why?: string): void {
  noteFailure(session, 'unknown', agent, version, why);
}

export function healthRows(): HealthRow[] {
  const all = read<Record<string, HealthRow>>(HEALTH_KEY, {});
  return Object.values(all)
    .filter((r) => r && typeof r.session === 'string' && r.counts && typeof r.counts === 'object')
    .sort((a, b) => b.last - a.last);
}

export function resetHealth(): void {
  try {
    localStorage.removeItem(HEALTH_KEY);
  } catch {
    // нечего сбрасывать
  }
}

/** Плашка «чат не проверен на этой версии»: true — показать, и ровно один раз на версию. */
export function versionNoticeDue(agent: string, version: string): boolean {
  const seen = read<string[]>(VERSIONS_KEY, []);
  const key = `${agent}@${version}`;
  if (Array.isArray(seen) && seen.includes(key)) return false;
  write(VERSIONS_KEY, [...(Array.isArray(seen) ? seen : []), key]);
  return true;
}
