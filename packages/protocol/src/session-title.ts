// Разбор заголовка панели tmux (`pane_title`), в который Claude Code и Codex
// кодируют состояние сессии: ведущий индикатор, затем текст задачи.
//
// Живёт в protocol, потому что одно и то же нужно и агенту (решает, работает ли
// сессия, и что слать в пуше), и вебу (точка активности, имя карточки, вкладки).
// Раньше правило было переписано в обоих местах, и когда Claude Code сменил
// брайлевый спиннер на половинки круга, сломались оба — независимо друг от друга.
//
// Модуль намеренно без зависимостей: web тянет его отдельным подпутём
// (`@termhub/protocol/session-title`), чтобы в LAN-бандл не уехал libsodium,
// который тянет корневой index.

/** Символ ожидания ввода: Claude Code показывает его, когда ждёт ответа. */
const WAITING = '\u2733'; // ✳

/** Codex показывает оба этих служебных префикса, когда ждёт действия
 * пользователя: `!` — основная фаза, `.` — скрытая фаза анимации.
 * После префикса Codex добавляет thread-title через ` | `. */
const CODEX_WAITING_RE = /^\s*(\[\s[!.]\s\])\s*Action Required(?:\s*\|\s*)?/u;

/**
 * Ведущий индикатор: подряд идущие символы-знаки (категории So и Sm) до пробела.
 *
 * Конкретные глифы намеренно НЕ перечисляем: Claude Code уже менял их (брайлевый
 * спиннер ⠂⠐ → половинки круга ◐◑), и список пришлось бы догонять каждый раз.
 * Категория покрывает и брайль, и геометрические фигуры, и звёздочки — то есть
 * любой следующий спиннер тоже.
 *
 * Из категорий исключены две группы. Эмодзи (`Emoji_Presentation`): заголовок вида
 * «🚀 Deploy» пишет человек, и съедать его первый символ как статус неправильно.
 * ASCII: `+`, `=`, `<`, `$` тоже формально знаки, но спиннеров из них не делают,
 * а вот в обычном заголовке они встречаются.
 * Селекторы начертания (FE0E/FE0F) допускаем внутри серии — они не отдельный знак.
 */
const INDICATOR_RE =
  /^\s*((?:(?!\p{ASCII})(?!\p{Emoji_Presentation})[\p{So}\p{Sm}]|[\uFE0E\uFE0F])+)\s*/u;

/** Ведущий индикатор заголовка или '' — если его нет. */
export function titleIndicator(title: string): string {
  const codex = CODEX_WAITING_RE.exec(title);
  if (codex) return codex[1]!;
  const m = INDICATOR_RE.exec(title);
  return m ? m[1]!.replace(/[\uFE0E\uFE0F]/gu, '') : '';
}

/** Сессией управляет Claude Code или Codex: в заголовке есть индикатор статуса. Для прочих
 *  сессий «работает ли» определяется fallback'ом по session_activity. */
export function sessionManaged(title: string): boolean {
  return titleIndicator(title) !== '';
}

/** Управляемая сессия сейчас работает: индикатор есть, но это не статус ожидания. */
export function sessionWorking(title: string): boolean {
  const ind = titleIndicator(title);
  return ind !== '' && !sessionWaiting(title);
}

/** Claude (✳) или Codex (`[ ! ]` / `[ . ]`) ждут действия пользователя. */
export function sessionWaiting(title: string): boolean {
  return CODEX_WAITING_RE.test(title) || titleIndicator(title) === WAITING;
}

/** Текст заголовка без ведущего индикатора: сам индикатор показывается отдельно
 *  (точкой активности), дублировать его в имени незачем. Пустая строка, если
 *  заголовок состоял из одного индикатора либо отсутствует. */
export function sessionTitleText(title: string): string {
  return title.replace(CODEX_WAITING_RE, '').replace(INDICATOR_RE, '').trim();
}
