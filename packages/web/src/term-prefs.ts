// Вид терминала: размер шрифта, межстрочный интервал и фон. Выбор живёт в localStorage
// на устройстве; открытый терминал подписывается и перестраивается на месте.

import { currentTheme } from './theme';

export type TermBg = 'soft' | 'dark';
/** Цветовая схема терминала: `auto` идёт за темой приложения. Перечень — данные:
 *  новая схема добавляется сюда и блоком `[data-term-scheme]` в theme.css. */
export type TermScheme = 'auto' | 'dark' | 'light';
export const TERM_SCHEMES: readonly TermScheme[] = ['auto', 'dark', 'light'];

/** Шрифты терминала. Веб-шрифтов приложение не несёт: берётся установленный в системе,
 *  а если его нет — браузер молча идёт дальше по стеку. */
export const TERM_FONTS = {
  system: { label: '', family: '' },
  sfmono: { label: 'SF Mono', family: "'SF Mono'" },
  jetbrains: { label: 'JetBrains Mono', family: "'JetBrains Mono'" },
  menlo: { label: 'Menlo', family: 'Menlo' },
  fira: { label: 'Fira Code', family: "'Fira Code'" },
  cascadia: { label: 'Cascadia Code', family: "'Cascadia Code'" },
} as const;
export type TermFont = keyof typeof TERM_FONTS;

export interface TermPrefs {
  fontSize: number;
  lineHeight: number;
  bg: TermBg;
  scheme: TermScheme;
  font: TermFont;
  /** Полоса разделов сессии (Терминал / Файлы / …) на десктопе видна только по наведению. */
  holoAuto: boolean;
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
const SCHEME_LS_KEY = 'termhub.termScheme';
const FONT_FAMILY_LS_KEY = 'termhub.termFont';
const HOLO_AUTO_LS_KEY = 'termhub.holoAuto';

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
    scheme: TERM_SCHEMES.find((v) => v === read(SCHEME_LS_KEY)) ?? 'auto',
    font: (Object.keys(TERM_FONTS) as TermFont[]).find((v) => v === read(FONT_FAMILY_LS_KEY)) ?? 'system',
    holoAuto: read(HOLO_AUTO_LS_KEY) === '1',
  };
}

/** Светлая ли схема терминала сейчас (с учётом `auto` → тема приложения). */
export function termIsLight(): boolean {
  const { scheme } = readTermPrefs();
  return scheme === 'auto' ? currentTheme() === 'light' : scheme === 'light';
}

/** Стек шрифтов терминала: выбранный впереди общего моноширинного стека темы. */
export function termFontFamily(font: TermFont, base: string): string {
  const family = TERM_FONTS[font].family;
  return family ? `${family}, ${base}` : base;
}

const listeners = new Set<(prefs: TermPrefs) => void>();

/** Подписка открытого терминала на смену вида. Возвращает отписку. */
export function onTermPrefsChange(fn: (prefs: TermPrefs) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Вид задаётся атрибутами на корне: сами краски и раскладку держит theme.css. */
function applyAttrs(prefs: TermPrefs): void {
  const data = document.documentElement.dataset;
  if (prefs.bg === 'dark') data.termBg = 'dark';
  else delete data.termBg;
  if (prefs.scheme === 'auto') delete data.termScheme;
  else data.termScheme = prefs.scheme;
  if (prefs.holoAuto) data.holoAuto = '';
  else delete data.holoAuto;
}

/** Проставляет сохранённый вид терминала при старте приложения. */
export function initTermPrefs(): void {
  applyAttrs(readTermPrefs());
}

export function setTermPrefs(patch: Partial<TermPrefs>): TermPrefs {
  if (patch.fontSize !== undefined) write(FONT_LS_KEY, String(clampFont(patch.fontSize)));
  if (patch.lineHeight !== undefined) write(LINE_LS_KEY, String(patch.lineHeight));
  if (patch.bg !== undefined) write(BG_LS_KEY, patch.bg);
  if (patch.scheme !== undefined) write(SCHEME_LS_KEY, patch.scheme);
  if (patch.font !== undefined) write(FONT_FAMILY_LS_KEY, patch.font);
  if (patch.holoAuto !== undefined) write(HOLO_AUTO_LS_KEY, patch.holoAuto ? '1' : '0');
  // Поверх прочитанного кладём patch: при недоступном localStorage вид всё равно
  // должен смениться хотя бы на этот сеанс.
  const prefs = { ...readTermPrefs(), ...patch };
  if (patch.fontSize !== undefined) prefs.fontSize = clampFont(patch.fontSize);
  applyAttrs(prefs);
  for (const fn of listeners) fn(prefs);
  return prefs;
}
