// Состояние сессии из заголовка панели (tmux pane_title).
//
// Само правило живёт в @termhub/protocol/session-title — общее с агентом, иначе
// смена спиннера в Claude Code ломает обе стороны по отдельности (уже случалось).
// Импорт идёт подпутём, а не из корня пакета: корневой index тянет libsodium,
// которому нельзя попадать в LAN-бандл.

export {
  sessionByOutput,
  sessionManaged,
  sessionTitleText,
  sessionWaiting,
  sessionWorking,
  titleIndicator,
} from '@termhub/protocol/session-title';

export type SessionAgent = 'claude' | 'codex' | 'opencode';

/** Какой агент работает в сессии — по команде панели tmux. Claude Code называет свой
 *  процесс номером версии («2.1.317»), поэтому голая версия — тоже он. */
export function sessionAgent(command: string): SessionAgent | null {
  const cmd = command.trim().toLowerCase();
  if (cmd.startsWith('claude') || /^\d+\.\d+\.\d+$/.test(cmd)) return 'claude';
  if (cmd.startsWith('codex')) return 'codex';
  if (cmd.startsWith('opencode')) return 'opencode';
  return null;
}
