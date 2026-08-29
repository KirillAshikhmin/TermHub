const APP_TITLE = 'TermHub';

/** Заголовок session-scoped экрана: содержательный pane title, затем tmux-id. */
export function setSessionDocumentTitle(displayTitle: string, session: string): void {
  const display = displayTitle.trim() || session.trim();
  document.title = display ? `${display} · ${APP_TITLE}` : APP_TITLE;
}

/** Базовый заголовок для дашборда, login, pairing и прочих общих экранов. */
export function resetDocumentTitle(): void {
  document.title = APP_TITLE;
}
