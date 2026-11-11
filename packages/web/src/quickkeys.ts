// Панель быстрых клавиш терминала: крупные тач-кнопки, которые шлют управляющие
// последовательности в pty. Два ряда: первый — клавиши (Esc, Tab, стрелки, Enter; на
// телефоне он обязан помещаться в одну строку), второй — сочетания с Shift (⇧Tab, ⇧←)
// слева, за ними вставка из буфера и инструменты (выделение, поиск, тумблеры). Ctrl+C — удержание Esc: отдельной кнопки у него нет, и случайным
// тапом команду не оборвать; Shift+Enter (перенос строки) — удержание Enter. Размер
// шрифта и выбор «Enter отправляет / переносит» — в окне настроек.
// Карта кнопка→байты вынесена чистой структурой (SEND_KEYS) — её и покрывает тест;
// DOM-монтаж отделён и от него не зависит.

import type { TFn } from './i18n';
import { svgIcon } from './ui';

/** Описание кнопки: id (для теста), видимая подпись, отправляемая строка байт. */
export interface QuickKey {
  id: string;
  /** Моноширинная подпись на кнопке. */
  glyph: string;
  /** Строка байт для pty (все символы ≤ 0x7F). */
  send: string;
  /** Ключ i18n для aria-label (стрелки-глифы без текста); иначе подпись = glyph. */
  ariaKey?: string;
  /** Подпись для aria-label словом, когда глиф — значок (Tab, Enter). */
  aria?: string;
  /** Не кнопка, а действие по удержанию названной кнопки (Ctrl+C — удержание Esc,
   *  Shift+Enter — удержание Enter). */
  holdOf?: string;
  /** Мелкая пометка на кнопке-хозяине: что даёт удержание. */
  holdMark?: string;
  /** Клавиша второго ряда (слева, перед инструментами): сочетания с Shift нужны реже, а
   *  первый ряд на телефоне обязан помещаться в одну строку. */
  second?: true;
}

/** Сколько держать кнопку, чтобы сработало действие удержания. */
export const HOLD_MS = 450;

// Порядок = порядок в панели (см. бриф Task 8).
export const SEND_KEYS: readonly QuickKey[] = [
  { id: 'esc', glyph: 'Esc', send: '\x1b' },
  // ↹ — значок с клавиши Tab: две встречные стрелки с упорами. Shift+Tab — он же с ⇧.
  { id: 'tab', glyph: '↹', send: '\t', aria: 'Tab' },
  { id: 'shiftTab', glyph: '⇧↹', send: '\x1b[Z', aria: 'Shift + Tab', second: true },
  // Shift+← — «назад» в вопросах Codex (xterm-форма стрелки с модификатором Shift).
  { id: 'shiftLeft', glyph: '⇧←', send: '\x1b[1;2D', ariaKey: 'quickkeys.shiftLeft', second: true },
  { id: 'left', glyph: '←', send: '\x1b[D', ariaKey: 'quickkeys.left' },
  { id: 'up', glyph: '↑', send: '\x1b[A', ariaKey: 'quickkeys.up' },
  { id: 'down', glyph: '↓', send: '\x1b[B', ariaKey: 'quickkeys.down' },
  { id: 'right', glyph: '→', send: '\x1b[C', ariaKey: 'quickkeys.right' },
  { id: 'enter', glyph: '↵', send: '\r', aria: 'Enter' },
  { id: 'ctrlC', glyph: '^C', send: '\x03', holdOf: 'esc', holdMark: '^C', aria: 'Ctrl+C' },
  // Перенос строки: ESC+CR — голый \n агенты принимают за отправку.
  { id: 'shiftEnter', glyph: '⇧↵', send: '\x1b\r', holdOf: 'enter', holdMark: '⇧', aria: 'Shift+Enter' },
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
  onKeyboardToggle: (enabled: boolean) => void;
  /** Начальное состояние переключателя клавиатуры. */
  keyboardEnabled: boolean;
  /** Тумблер режима выделения текста (тач-драг выделяет вместо скролла). */
  onSelectToggle: (enabled: boolean) => void;
  /** Вставить из буфера обмена: текст или картинку (term-paste.ts). */
  onPaste: () => void;
  /** Открыть панель поиска по терминалу. */
  onSearch: () => void;
  /** Начальное состояние тумблера выделения. */
  selectEnabled: boolean;
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

/** Удержание кнопки шлёт другую последовательность (Esc → Ctrl+C). Короткий тап остаётся
 *  обычным нажатием; после сработавшего удержания клик гасится. На кнопке — мелкая
 *  пометка, что даёт удержание. */
function wireHold(btn: HTMLButtonElement, held: QuickKey, h: Pick<QuickKeysHandlers, 'onKey' | 't'>): void {
  const mark = document.createElement('span');
  mark.className = 'th-qk__hold';
  mark.textContent = held.holdMark ?? held.glyph;
  btn.append(mark);
  btn.classList.add('th-qk__key--hold');
  const label = h.t('quickkeys.hold', { key: btn.getAttribute('aria-label') ?? '', held: held.aria ?? held.glyph });
  btn.setAttribute('aria-label', label);
  btn.title = label;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    btn.classList.remove('is-holding');
  };
  btn.addEventListener('pointerdown', () => {
    fired = false;
    cancel();
    btn.classList.add('is-holding');
    timer = setTimeout(() => {
      timer = undefined;
      fired = true;
      btn.classList.remove('is-holding');
      btn.classList.add('is-held');
      setTimeout(() => btn.classList.remove('is-held'), 300);
      h.onKey(keyBytes(held));
    }, HOLD_MS);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(type, cancel);
  // Долгое нажатие на телефоне зовёт контекстное меню — оно здесь не нужно.
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // Клик после сработавшего удержания — не нажатие Esc.
  btn.addEventListener(
    'click',
    (e) => {
      if (!fired) return;
      fired = false;
      e.stopImmediatePropagation();
    },
    true,
  );
}

/** Строит DOM-панель быстрых клавиш. Позиционирование к низу/над клавиатурой —
 *  на стороне term.ts (visualViewport). */
export function mountQuickKeys(h: QuickKeysHandlers): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'th-qk';
  panel.setAttribute('role', 'toolbar');
  panel.setAttribute('aria-label', h.t('quickkeys.title'));

  // Первый ряд — клавиши: Esc, Tab, стрелки и Enter справа. Второй — сочетания с Shift
  // слева, за ними инструменты.
  const keys = document.createElement('div');
  keys.className = 'th-qk__row th-qk__row--keys';
  const tools = document.createElement('div');
  tools.className = 'th-qk__row th-qk__row--tools';
  for (const key of SEND_KEYS) {
    if (key.holdOf) continue; // действие удержания — не кнопка
    const held = SEND_KEYS.find((k) => k.holdOf === key.id);
    const name = key.ariaKey ? h.t(key.ariaKey) : (key.aria ?? key.glyph);
    const btn = quickKeyButton(key.glyph, name, () => h.onKey(keyBytes(key)));
    btn.classList.add(`th-qk__key--${key.id}`);
    btn.title = name;
    if (held) wireHold(btn, held, h);
    (key.second ? tools : keys).append(btn);
  }
  panel.append(keys);

  // Вставка из буфера — сразу за сочетаниями с Shift: на телефоне сочетания клавиш
  // «вставить» нет, а картинку иначе в агента не передать.
  const paste = quickKeyButton('', h.t('quickkeys.paste'), () => h.onPaste());
  paste.classList.add('th-qk__key--paste');
  paste.title = h.t('quickkeys.paste');
  paste.append(svgIcon('paste'));
  tools.append(paste);

  // Режим выделения (тач-драг → выделение) + копирование выделенного.
  const selectGroup = document.createElement('div');
  selectGroup.className = 'th-qk__group';
  const selectToggle = toggleButton('⬚', h.t('quickkeys.select'), h.selectEnabled, h.onSelectToggle);
  selectToggle.classList.add('th-qk__select');
  selectGroup.append(
    selectToggle,
    quickKeyButton('⌕', h.t('quickkeys.search'), () => h.onSearch()),
  );
  tools.append(selectGroup);

  // Экранная клавиатура.
  const keyboardToggle = toggleButton('⌨', h.t('quickkeys.keyboard'), h.keyboardEnabled, h.onKeyboardToggle);
  keyboardToggle.classList.add('th-qk__keyboard');
  tools.append(keyboardToggle);

  // Строка ввода (compose bar) — справа, после клавиатуры. Нативное поле для
  // свайпа/подсказок (терминальная textarea их не поддерживает).
  const composeToggle = toggleButton('✎', h.t('quickkeys.compose'), h.composeEnabled, h.onComposeToggle);
  composeToggle.classList.add('th-qk__compose');
  tools.append(composeToggle);
  panel.append(tools);

  return panel;
}
