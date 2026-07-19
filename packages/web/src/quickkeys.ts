// Панель быстрых клавиш терминала: крупные тач-кнопки, которые шлют управляющие
// последовательности в pty (Esc, Tab, стрелки, Ctrl+C, y/n) плюс регулировка
// размера шрифта. Карта кнопка→байты вынесена чистой структурой (SEND_KEYS) —
// её и покрывает тест; DOM-монтаж отделён и от него не зависит.

import type { TFn } from './i18n';

/** Описание кнопки: id (для теста), видимая подпись, отправляемая строка байт. */
export interface QuickKey {
  id: string;
  /** Моноширинная подпись на кнопке. */
  glyph: string;
  /** Строка байт для pty (все символы ≤ 0x7F). */
  send: string;
  /** Ключ i18n для aria-label (стрелки-глифы без текста); иначе подпись = glyph. */
  ariaKey?: string;
}

// Порядок = порядок в панели (см. бриф Task 8).
export const SEND_KEYS: readonly QuickKey[] = [
  { id: 'esc', glyph: 'Esc', send: '\x1b' },
  { id: 'tab', glyph: 'Tab', send: '\t' },
  { id: 'shiftTab', glyph: '⇧Tab', send: '\x1b[Z' },
  { id: 'left', glyph: '←', send: '\x1b[D', ariaKey: 'quickkeys.left' },
  { id: 'up', glyph: '↑', send: '\x1b[A', ariaKey: 'quickkeys.up' },
  { id: 'down', glyph: '↓', send: '\x1b[B', ariaKey: 'quickkeys.down' },
  { id: 'right', glyph: '→', send: '\x1b[C', ariaKey: 'quickkeys.right' },
  { id: 'enter', glyph: 'Enter', send: '\r' },
  { id: 'ctrlC', glyph: '^C', send: '\x03' },
];

const encoder = new TextEncoder();

/** Байты кнопки. Все подписи в диапазоне ASCII, поэтому UTF-8 == однобайтовый код. */
export function keyBytes(key: Pick<QuickKey, 'send'>): Uint8Array {
  return encoder.encode(key.send);
}

/** Колбэки панели: отправка байт в pty, шаг размера шрифта (±1) и переключатель
 *  экранной клавиатуры (term.ts переводит textarea xterm в inputmode). */
export interface QuickKeysHandlers {
  onKey: (bytes: Uint8Array) => void;
  onFontStep: (delta: number) => void;
  onKeyboardToggle: (enabled: boolean) => void;
  /** Начальное состояние переключателя клавиатуры. */
  keyboardEnabled: boolean;
  /** Тумблер режима выделения текста (тач-драг выделяет вместо скролла). */
  onSelectToggle: (enabled: boolean) => void;
  /** Открыть панель поиска по терминалу. */
  onSearch: () => void;
  /** Начальное состояние тумблера выделения. */
  selectEnabled: boolean;
  /** Тумблер «Отправлять по Enter» (выкл — Enter переносит строку). */
  onEnterSendsToggle: (enabled: boolean) => void;
  /** Начальное состояние тумблера «Отправлять по Enter». */
  enterSendsEnabled: boolean;
  /** Тумблер строки ввода (compose bar): нативное поле для свайпа/подсказок. */
  onComposeToggle: (enabled: boolean) => void;
  /** Начальное состояние строки ввода. */
  composeEnabled: boolean;
  t: TFn;
}

/** Собирает одну кнопку панели. mousedown-preventDefault не даёт кнопке забрать
 *  фокус у скрытого textarea xterm — иначе экранная клавиатура закрывается. */
function quickKeyButton(glyph: string, ariaLabel: string, onActivate: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'th-qk__key';
  btn.textContent = glyph;
  btn.setAttribute('aria-label', ariaLabel);
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', onActivate);
  return btn;
}

/** Кнопка-переключатель (чекбокс) с состоянием aria-pressed. Тот же
 *  mousedown-preventDefault, чтобы не сбить фокус textarea xterm. */
function toggleButton(
  glyph: string,
  ariaLabel: string,
  pressed: boolean,
  onToggle: (pressed: boolean) => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'th-qk__key th-qk__toggle';
  btn.textContent = glyph;
  btn.setAttribute('aria-label', ariaLabel);
  const sync = (): void => {
    btn.setAttribute('aria-pressed', String(pressed));
    btn.classList.toggle('is-off', !pressed);
  };
  sync();
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    pressed = !pressed;
    sync();
    onToggle(pressed);
  });
  return btn;
}

/** Строит DOM-панель быстрых клавиш. Позиционирование к низу/над клавиатурой —
 *  на стороне term.ts (visualViewport). */
export function mountQuickKeys(h: QuickKeysHandlers): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'th-qk';
  panel.setAttribute('role', 'toolbar');
  panel.setAttribute('aria-label', h.t('quickkeys.title'));

  for (const key of SEND_KEYS) {
    const aria = key.ariaKey ? h.t(key.ariaKey) : key.glyph;
    panel.append(quickKeyButton(key.glyph, aria, () => h.onKey(keyBytes(key))));
  }

  // Порядок после ^C: размер шрифта → выделение/копирование → Enter → клавиатура.
  const fontGroup = document.createElement('div');
  fontGroup.className = 'th-qk__group';
  fontGroup.append(
    quickKeyButton('A−', h.t('term.fontDecrease'), () => h.onFontStep(-1)),
    quickKeyButton('A+', h.t('term.fontIncrease'), () => h.onFontStep(1)),
  );
  panel.append(fontGroup);

  // Режим выделения (тач-драг → выделение) + копирование выделенного.
  const selectGroup = document.createElement('div');
  selectGroup.className = 'th-qk__group';
  const selectToggle = toggleButton('⬚', h.t('quickkeys.select'), h.selectEnabled, h.onSelectToggle);
  selectToggle.classList.add('th-qk__select');
  selectGroup.append(
    selectToggle,
    quickKeyButton('⌕', h.t('quickkeys.search'), () => h.onSearch()),
  );
  panel.append(selectGroup);

  // Тумблер «Отправлять по Enter» (выкл — Enter переносит строку).
  const enterToggle = toggleButton('⏎', h.t('quickkeys.enterSends'), h.enterSendsEnabled, h.onEnterSendsToggle);
  enterToggle.classList.add('th-qk__enter');
  panel.append(enterToggle);

  // Экранная клавиатура.
  panel.append(toggleButton('⌨', h.t('quickkeys.keyboard'), h.keyboardEnabled, h.onKeyboardToggle));

  // Строка ввода (compose bar) — справа, после клавиатуры. Нативное поле для
  // свайпа/подсказок (терминальная textarea их не поддерживает).
  const composeToggle = toggleButton('✎', h.t('quickkeys.compose'), h.composeEnabled, h.onComposeToggle);
  composeToggle.classList.add('th-qk__compose');
  panel.append(composeToggle);

  return panel;
}
