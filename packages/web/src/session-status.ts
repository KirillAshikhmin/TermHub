// Состояние сессии из заголовка активной панели (tmux pane_title). Claude Code
// кодирует его в заголовок: брайлевый спиннер (⠂/⠐/…) = работает, ✳ = ждёт
// реакции пользователя. Чистые функции — тестируются отдельно.

/** Брайлевый спиннер в начале заголовка = Claude работает (думает/делает). */
const WORKING_RE = /^\s*[⠀-⣿]/u;
/** Брайль или ✳ в начале = сессией управляет Claude Code (есть title-сигнал);
 *  для таких сессий индикатор берём из заголовка, а не из session_activity. */
const MANAGED_RE = /^\s*[⠀-⣿✳]/u;

/** Claude в сессии сейчас работает (брайлевый спиннер в заголовке). */
export function sessionWorking(title: string): boolean {
  return WORKING_RE.test(title);
}

/** Сессией управляет Claude Code (заголовок несёт статус ⠂/✳). Для не-managed
 *  сессий «работает ли» определяется fallback'ом по session_activity. */
export function sessionManaged(title: string): boolean {
  return MANAGED_RE.test(title);
}
