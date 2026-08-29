# Интерфейсы: открытие файла на хосте

## Границы, решённые в спецификации

| Модуль | Владеет | Выставляет | Прячет |
|---|---|---|---|
| `host-opener` | выбор OS-команды и жизненный цикл процесса | `openPathOnHost(path) -> Promise<void>` | `spawn`, платформенные имена команд и exit-коды |
| `file-service` | roots/realpath/type safety | `openOnHost(root, subpath) -> Promise<void>` через `runFileOp` action `open-host` | абсолютный путь хоста |
| `transport` | LAN/relay доставка action | существующий `fileOp('open-host', {root, path})` | REST/FrameType детали |
| `file-viewer` | видимость, pending и feedback кнопки | кнопка `files.openHost` в footer | тип preview и transport mode |

Швы тестирования: чистый/инъецируемый `host-opener`, `runFileOp`, relay permission,
LAN route и DOM-harness модалки файла. Новых frame types и полей протокола нет.

## Правила проекта

- Node ≥ 22, TypeScript strict/ESM, npm workspaces, 2 пробела.
- Host command запускается только argv без shell; путь проходит существующий realpath/roots seam.
- Relay read-only guest не может выполнять `open-host`; требуется `scope.write`.
- UI-строки добавляются синхронно в ru/en словари.
- Узкие тесты → `npx tsc -p packages/web/tsconfig.json --noEmit` → `npm run build` → `npm test`.
- Не трогать пользовательский `.claude/settings.json`.
- Коммиты разрешены пользователем; один коммит на законченный reviewed ticket.
- После всей фичи обязательны relay deploy и локальный LaunchAgent restart с проверкой tmux до/после.
- Недостающую зависимость не устанавливать; вернуть `BLOCKED`.

## Из таска 01 — host-side contract

- `openPathOnHost(filePath, deps?) -> Promise<void>` выбирает `open`/`xdg-open`,
  запускает argv без shell и отклоняет unsupported OS/spawn/non-zero exit.
- `FileService.openOnHost(root, subpath) -> Promise<void>` повторно применяет
  realpath/roots/type safety и не раскрывает абсолютный путь клиенту.
- `runFileOp(files, { action: 'open-host', root, path })` — единый LAN/relay action;
  relay требует `scope.write` и scoped path.

## Из таска 02 — file viewer contract

- `Transport.fileOp('open-host', { root, path }) -> Promise` используется без нового
  protocol frame; кнопка доступна LAN/owner/write-scope и скрыта у read-only guest.
- `files.openHost` и `files.openedOnHost` синхронно определены для ru/en.

## Из таска 03 — Codex mouse-selection contract

- `TerminalOptions.macOptionClickForcesSelection = true`: при active mouse tracking
  обычный drag остаётся у TUI, а macOS Option+drag создаёт xterm selection.
- Существующий copy-controller автоматически копирует selection на mouseup и хранит
  его для последующего Command+C после redraw.
