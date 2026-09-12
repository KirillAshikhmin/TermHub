// Модуль существует ровно затем, чтобы эти числа жили в одном месте:
// разъехавшись по файлам, они разъедутся и по смыслу.

/** Границы размера терминала: мусор с клиента не должен ронять pty. */
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 300;

/** Приводит размер к целому в [min, max]; нечисловое/NaN → min. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function clampCols(value: number): number {
  return clamp(value, MIN_COLS, MAX_COLS);
}

export function clampRows(value: number): number {
  return clamp(value, MIN_ROWS, MAX_ROWS);
}
