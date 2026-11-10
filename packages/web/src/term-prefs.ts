// Вид терминала: размер шрифта, межстрочный интервал и фон. Выбор живёт в localStorage
// на устройстве; открытый терминал подписывается и перестраивается на месте.

export type TermBg = 'soft' | 'dark';

export interface TermPrefs {
  fontSize: number;
  lineHeight: number;
  bg: TermBg;
}

export const FONT_MIN = 10;
export const FONT_MAX = 22;
/** Ступени межстрочного интервала: плотно, обычно, свободно. */
export const LINE_HEIGHTS = [1, 1.15, 1.3] as const;

// На десктопе плотнее (как системный терминал), на тач-экране — крупнее под палец и глаз.
const FONT_DEFAULT_TOUCH = 14;
const FONT_DEFAULT_DESKTOP = 12;
const FONT_LS_KEY = 'termhub.fontSize';
const LINE_LS_KEY = 'termhub.lineHeight';
const BG_LS_KEY = 'termhub.termBg';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // localStorage недоступен — значения по умолчанию.
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Персист вида необязателен.
  }
}

function clampFont(size: number): number {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(size)));
}

function defaultFontSize(): number {
  try {
    if (window.matchMedia('(pointer: coarse)').matches) return FONT_DEFAULT_TOUCH;
  } catch {
    // matchMedia недоступен — считаем десктопом.
  }
  return FONT_DEFAULT_DESKTOP;
}

export function readTermPrefs(): TermPrefs {
  const rawFont = Number(read(FONT_LS_KEY));
  const rawLine = Number(read(LINE_LS_KEY));
  return {
    fontSize: Number.isFinite(rawFont) && rawFont > 0 ? clampFont(rawFont) : defaultFontSize(),
    // Чужое значение (ручная правка, старая версия) не принимаем: только известные ступени.
    lineHeight: LINE_HEIGHTS.find((v) => v === rawLine) ?? 1,
    bg: read(BG_LS_KEY) === 'dark' ? 'dark' : 'soft',
  };
}

const listeners = new Set<(prefs: TermPrefs) => void>();

/** Подписка открытого терминала на смену вида. Возвращает отписку. */
export function onTermPrefsChange(fn: (prefs: TermPrefs) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Фон задаётся атрибутом на корне: саму краску держит theme.css (`--term-bg`). */
function applyBg(bg: TermBg): void {
  if (bg === 'dark') document.documentElement.dataset.termBg = 'dark';
  else delete document.documentElement.dataset.termBg;
}

/** Проставляет сохранённый фон терминала при старте приложения. */
export function initTermPrefs(): void {
  applyBg(readTermPrefs().bg);
}

export function setTermPrefs(patch: Partial<TermPrefs>): TermPrefs {
  if (patch.fontSize !== undefined) write(FONT_LS_KEY, String(clampFont(patch.fontSize)));
  if (patch.lineHeight !== undefined) write(LINE_LS_KEY, String(patch.lineHeight));
  if (patch.bg !== undefined) {
    write(BG_LS_KEY, patch.bg);
    applyBg(patch.bg);
  }
  // Поверх прочитанного кладём patch: при недоступном localStorage вид всё равно
  // должен смениться хотя бы на этот сеанс.
  const prefs = { ...readTermPrefs(), ...patch };
  if (patch.fontSize !== undefined) prefs.fontSize = clampFont(patch.fontSize);
  for (const fn of listeners) fn(prefs);
  return prefs;
}
