// Объявление возможностей между агентом и PWA (ADR 0018): каждая сторона называет
// имена того, что понимает, дальше обе работают по пересечению. Списки — данные,
// а не тип: новое имя добавляется строкой, разбор кадров и маршрутов не меняется.

/** Лента сессии из транскрипта агента. */
export const CAP_FEED = 'feed';

/** Что умеет агент этой версии. */
export const AGENT_CAPS: readonly string[] = [CAP_FEED];

/** Что понимает клиент (PWA) этой версии. */
export const CLIENT_CAPS: readonly string[] = [CAP_FEED];

/** Список возможностей из чужого JSON: оставляет только строки и схлопывает дубли.
 *  Всё непонятное отбрасывается молча — незнакомое имя это не ошибка, а просто
 *  возможность, которой у нас нет. */
export function parseCaps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && !out.includes(item)) out.push(item);
  }
  return out;
}

/** Пересечение двух списков в порядке первого; дубли схлопываются. */
export function intersect(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  const out: string[] = [];
  for (const name of a) {
    if (other.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
