// Тема оформления: тёмная по умолчанию, светлая — по prefers-color-scheme или
// ручному переключателю. Активная тема пишется в data-theme на :root и в
// localStorage; CSS-переменные (theme.css) реагируют на атрибут.

export type Theme = 'dark' | 'light';

const LS_KEY = 'termhub-theme';
const THEME_COLOR: Record<Theme, string> = { dark: '#0d1117', light: '#f6f8fa' };

/** Явно выбранная тема, иначе системная (prefers-color-scheme), иначе тёмная. */
export function currentTheme(): Theme {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // localStorage недоступен — идём к системной.
  }
  try {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  } catch {
    // matchMedia недоступен — тёмная.
  }
  return 'dark';
}

function apply(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
}

/** Проставляет актуальную тему при старте приложения. */
export function initTheme(): void {
  apply(currentTheme());
}

/** Переключает тему, персистит выбор и возвращает новую тему. */
export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(LS_KEY, next);
  } catch {
    // Персист необязателен.
  }
  apply(next);
  return next;
}
