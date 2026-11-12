// Параметры вида TermHub на чате: размер и семейство шрифта и межстрочный интервал из
// настроек терминала (`term-prefs.ts`) становятся переменными области чата, а краски и
// размеры по ним держит theme.css. Фон едет отдельно — атрибутом `data-term-bg` на корне.
import { TERM_FONTS, onTermPrefsChange, readTermPrefs, type TermPrefs } from './term-prefs';

/** Ниже этого размера поля ввода iOS приближает страницу при фокусе. */
const INPUT_MIN_TOUCH = 16;

type ViewPrefs = Pick<TermPrefs, 'fontSize' | 'lineHeight' | 'font'>;

/** Переменные области чата. `coarse` — тач-экран: поле ввода не мельче 16 px. */
export function chatViewVars(prefs: ViewPrefs, coarse: boolean): Record<string, string> {
  const family = TERM_FONTS[prefs.font].family;
  return {
    '--chat-fs': `${prefs.fontSize}px`,
    '--chat-input-fs': `${coarse ? Math.max(INPUT_MIN_TOUCH, prefs.fontSize) : prefs.fontSize}px`,
    '--chat-lh': String(prefs.lineHeight),
    // «Системный» — текст шрифтом приложения, код моноширинным стеком темы; выбранный
    // шрифт идёт и на текст, и на код.
    '--chat-font': family ? `${family}, var(--font-ui)` : 'var(--font-ui)',
    '--chat-mono': family ? `${family}, var(--font-mono)` : 'var(--font-mono)',
  };
}

function coarsePointer(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** Ставит вид на область чата и держит его за настройками. Возвращает отписку. */
export function bindChatView(area: HTMLElement): () => void {
  const apply = (prefs: ViewPrefs): void => {
    for (const [name, value] of Object.entries(chatViewVars(prefs, coarsePointer()))) area.style.setProperty(name, value);
  };
  apply(readTermPrefs());
  return onTermPrefsChange(apply);
}
