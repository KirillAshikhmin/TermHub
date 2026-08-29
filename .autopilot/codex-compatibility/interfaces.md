# Интерфейсы: совместимость TermHub с Codex

## Границы, решённые в спецификации

| Модуль | Владеет | Выставляет | Прячет |
|---|---|---|---|
| `terminal-copy` | snapshot выделения и решение copy/pass | обработчики selection, gesture end и keyboard copy | исчезновение xterm-selection при redraw, clipboard fallback |
| `session-title` | разбор Claude/Codex pane title и статуса | `titleIndicator`, `sessionManaged`, `sessionWorking`, `sessionWaiting`, `sessionTitleText` | конкретные prefix regex |
| `session-tabs` | актуальная подпись tmux-сессии | обновление DOM и callback текущего display title | poll/cache списка сессий |
| `document-title` | заголовок браузера для текущего route/workspace | установить session title или базовый `TermHub` | нормализацию пустых/повторяющихся значений |
| `session-preset` | безопасная argv-команда каждого whitelist-пресета | argv для `tmux new-session` | Codex process-local overrides |

Швы тестирования: чистое решение `terminal-copy`, общий `session-title`, argv
`session-preset` и callback `session-tabs`; browser title проверяется через workspace/
router harness. Новых сетевых или серверных контрактов нет.

## Правила проекта

- Node ≥ 22, npm workspaces, TypeScript strict/ESM, 2 пробела.
- UI-строки — только i18n, ru/en с одинаковыми ключами.
- Сначала узкие тесты, затем `npx tsc -p packages/web/tsconfig.json --noEmit`,
  `npm run build` и `npx vitest run`.
- Не читать и не менять `~/.codex/config.toml`; overrides только в argv процесса.
- Не менять сетевые контракты и форму `SessionInfo`, если задачу можно решить
  существующим `pane_title`.
- Не трогать пользовательское изменение `.claude/settings.json`.
- Не коммитить: корневой `CLAUDE.md` запрещает commit/push без явной просьбы.
- Недостающая зависимость возвращается как `BLOCKED`, не устанавливается.

## Проверенные внешние контракты

- Локальный Codex CLI: 0.151.0.
- Валидные process overrides: `tui.animations=false` и
  `tui.terminal_title=["activity","thread-title"]` (проверено `codex --strict-config … doctor`).
- Codex default terminal title: `activity + project-name`; официальный waiting prefix:
  `[ ! ] Action Required`, скрытая анимационная фаза `[ . ] Action Required`.

## Из таска 01 — Codex title и preset

- Публичные функции `titleIndicator`, `sessionManaged`, `sessionWorking`,
  `sessionWaiting`, `sessionTitleText` сохраняют сигнатуры; теперь понимают Claude
  indicators и Codex `[ ! ]`/`[ . ] Action Required`.
- Codex preset argv: `codex -c tui.animations=false -c
  'tui.terminal_title=["activity","thread-title"]'`; shell не используется.

## Из таска 02 — web copy и видимые title

- `createTerminalCopyController({ getSelection, copy })` возвращает контроллер
  snapshot/gesture/keyboard-copy, общий для локального и relay terminal flow.
- `SessionTabsOpts.onCurrentTitle?(title: string): void` сообщает актуальный display
  title только для текущей сессии.
- `setSessionDocumentTitle(displayTitle, session)` устанавливает `<display> · TermHub`
  с fallback на tmux-id; `resetDocumentTitle()` возвращает базовый `TermHub`.
- Новых сетевых контрактов и полей `SessionInfo` не добавлено.
