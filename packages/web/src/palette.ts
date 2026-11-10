// Командная палитра: нечёткий поиск по сессиям, разделам и действиям. Сам перечень
// пунктов собирает вызывающий (он знает транспорт и текущую сессию) — здесь только
// окно, сопоставление и клавиатура.
import { t } from './i18n';
import { openModal } from './ui';

export interface PaletteItem {
  label: string;
  /** Тусклая подпись справа: имя сессии, раздел. Участвует в поиске. */
  hint?: string;
  /** Переход по маршруту — либо действие (например, открыть другое окно). */
  hash?: string;
  run?: () => void;
}

/** Оценка нечёткого совпадения: все буквы запроса по порядку. Чем меньше, тем лучше;
 *  null — не совпало. Подряд идущие буквы и начало слова ценятся выше разбросанных. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const s = text.toLowerCase();
  const whole = s.indexOf(q);
  if (whole >= 0) return whole === 0 || /[\s._/-]/.test(s[whole - 1]!) ? whole : 50 + whole;
  let score = 100;
  let at = -1;
  for (const ch of q) {
    if (ch === ' ') continue;
    const next = s.indexOf(ch, at + 1);
    if (next < 0) return null;
    score += next - at - 1; // разрыв между соседними буквами запроса
    at = next;
  }
  return score;
}

/** Пункты, подходящие запросу, лучшие первыми; при равной оценке — исходный порядок. */
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const scored: Array<{ item: PaletteItem; score: number; at: number }> = [];
  items.forEach((item, at) => {
    const score = fuzzyScore(query, item.hint ? `${item.label} ${item.hint}` : item.label);
    if (score !== null) scored.push({ item, score, at });
  });
  return scored.sort((a, b) => a.score - b.score || a.at - b.at).map((x) => x.item);
}

const MAX_SHOWN = 30;

export function openPalette(items: PaletteItem[]): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-palette';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'th-input th-palette__input';
    input.placeholder = t('palette.placeholder');
    input.setAttribute('aria-label', t('palette.placeholder'));
    input.autocomplete = 'off';
    input.spellcheck = false;
    const list = document.createElement('div');
    list.className = 'th-palette__list';
    list.setAttribute('role', 'listbox');

    let shown: PaletteItem[] = [];
    let active = 0;
    const pick = (item: PaletteItem | undefined): void => {
      if (!item) return;
      if (item.hash !== undefined) {
        close(item.hash);
        return;
      }
      // Действие часто открывает своё окно, а закрытие палитры снимает запись history
      // асинхронно: запускаем его после этой траверсы, иначе новое окно закроет она же.
      window.addEventListener('popstate', () => item.run?.(), { once: true });
      close();
    };
    const mark = (): void => {
      [...list.children].forEach((row, i) => {
        row.classList.toggle('is-active', i === active);
        row.setAttribute('aria-selected', String(i === active));
        if (i === active) (row as HTMLElement).scrollIntoView?.({ block: 'nearest' });
      });
    };
    const render = (): void => {
      shown = filterPalette(items, input.value).slice(0, MAX_SHOWN);
      active = 0;
      list.replaceChildren();
      if (shown.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'th-palette__empty';
        empty.textContent = t('palette.empty');
        list.append(empty);
        return;
      }
      for (const item of shown) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'th-palette__row';
        row.setAttribute('role', 'option');
        const label = document.createElement('span');
        label.className = 'th-palette__label';
        label.textContent = item.label;
        row.append(label);
        if (item.hint) {
          const hint = document.createElement('span');
          hint.className = 'th-palette__hint';
          hint.textContent = item.hint;
          row.append(hint);
        }
        row.addEventListener('click', () => pick(item));
        list.append(row);
      }
      mark();
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (shown.length === 0) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        mark();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pick(shown[active]);
      }
    });
    box.append(input, list);
    render();
    return box;
  });
}
