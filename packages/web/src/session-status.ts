// Состояние сессии из заголовка панели (tmux pane_title).
//
// Само правило живёт в @termhub/protocol/session-title — общее с агентом, иначе
// смена спиннера в Claude Code ломает обе стороны по отдельности (уже случалось).
// Импорт идёт подпутём, а не из корня пакета: корневой index тянет libsodium,
// которому нельзя попадать в LAN-бандл.

export {
  sessionManaged,
  sessionTitleText,
  sessionWaiting,
  sessionWorking,
  titleIndicator,
} from '@termhub/protocol/session-title';
