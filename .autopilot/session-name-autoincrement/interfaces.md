# Интерфейсы

Файл читает каждый субагент до первой правки. Сверху — правила проекта, которые из
кода не вывести; ниже — границы, решённые в спецификации (копия), и то, что
построили завершённые таски (дописывается по мере сдачи).

## Правила проекта

- Монорепо npm workspaces, Node ≥ 22, TypeScript strict, ESM везде, отступы 2 пробела.
  Комментарии — по-русски и только там, где код не самоочевиден. Прочитай `CLAUDE.md`
  в корне — там критические знания (tmux, сокеты, крипто-роли, вкладка Gradle).
- Команды: `npx vitest run` (вся сюита, ~40 с; базовый прогон — 606 зелёных),
  `npx vitest run <файл|подстрока>` — один файл. `npm run build` — tsc всех пакетов +
  vite-сборка web. **Web не типизируется сборкой**: после правок web обязательно
  `npx tsc -p packages/web/tsconfig.json --noEmit` (известная предсуществующая придирка
  в `relay-transport.ts` Uint8Array/BlobPart — не блокер).
- Если pty/tmux не спавнится в песочнице (posix_spawn/EPERM) — перезапусти тесты вне
  песочницы (`dangerouslyDisableSandbox: true`); так делает и оркестратор.
- tmux в тестах — только изолированный сокет `-L termhub-test-<uniq>` + `kill-server`
  в teardown. Дефолтный сервер tmux и сокет `termhub` не трогать никогда.
- Все вызовы tmux — через `execFile` без shell; имена валидируются регуляркой, командные
  строки константны. Ничего не экранируем — отвергаем.
- UI-строки web — только через `i18n.ts`, оба словаря (ru+en) с одинаковым набором
  ключей (есть тест). В этой сборке новых ключей не планируется.
- libsodium не должен попасть в LAN-бандл web (крипта — только ленивый `import('./remote')`).
- README и CONTRIBUTING двуязычные: `*.md` (en) + `*.ru.md` — правишь одну, правь другую.
- Роли/хендшейк remote (`e2e.full.test.ts`) — при правке `relay-link.ts` прогнать его.
- Не трогать: `packages/{agent,relay}/static` (артефакты сборки), `.autopilot/` (пишет
  только оркестратор), `CLAUDE.md`, git (коммитит оркестратор).
- Отсутствующая зависимость = ответ `BLOCKED` оркестратору, а не `npm install`.
- Секреты не запрашивать, не печатать, не коммитить.

## Границы, решённые в спецификации

| Модуль | Владеет | Выставляет | Прячет |
|---|---|---|---|
| `agent/sessions` (`SessionService`) | правило уникального имени, вызовы tmux | `create({name, root, dir, preset, autoName?}) -> Promise<{name: string}>`; `pickFreeName(base: string, taken: ReadonlySet<string>) -> string` | чтение списка занятых имён, распознавание «duplicate session», число попыток |
| `agent/server` | HTTP-обёртка | `POST /api/sessions` → `{ok: true, session}` | — |
| `agent/relay-link` | кадровая обёртка | `Create{…, autoName?}` → `CreateOk{session}` | — |
| `web/transport` (обе реализации) | доставка запроса по транспорту | `Transport.create(req: CreateSessionInput & {autoName?}) -> Promise<string>` | откуда взято имя (ответ или запрос) |
| `agent/setup` (шелл-блок) | текст функций `tm`/`tml`, дописывание и обновление rc-файла | `tmFunction(socket?) -> string`, `TM_FUNCTION`, `zshAliasBlock()`, `upgradeTmFunction(existing: string) -> string \| null` | регулярку распознавания старого `tm`, диалог с пользователем |
| `web/ui` (`openModal`) | history-запись модалки и её снятие | `close(next?: string)` — без аргумента `history.back()`, с аргументом `location.replace(next)` | `cleanup`, `popstate`, оверлей |
| `web/routes` | формат hash-маршрутов | `termHash(name: string) -> string` (новый) | — |
| `web/dashboard` (модалка создания) | признак «имя не вводили», переход на созданную сессию | `openCreateModal(transport)` — без колбэка | сбор формы, `close(termHash(created))` |
| `web/term` (экран терминала) | фокус, очередь ввода до подключения, Enter | хэндл терминала получает `focus(): void`; `sendData` копит до `connected` | очередь, `sendResize` |
| `web/term-keys` (новый, чистый) | правило Enter | `enterAction(e: {type, key, shiftKey}, enterSends: boolean) -> 'send' \| 'newline' \| 'suppress' \| 'pass'` | — |
| `web/tabs` | полоса вкладок | без изменений сигнатур; `mousedown` кнопки таба гасится | — |
| `web/workspace` | показ вкладок пространства | `show('term')` фокусирует терминал | — |

Швы для тестов:
- **`SessionService.create` с подменённым `execFile`** (существующий шов
  `sessions.unit.test.ts`): стаб `list-sessions` отдаёт занятые имена, стаб
  `new-session` умеет ответить «duplicate session» — проверяются нумерация, гонка,
  «no server», прежнее поведение без `autoName`.
- **`pickFreeName`** — чистая функция: суффиксы, дыры, обрезка до 40, цифра на конце.
- **Живой tmux на изолированном сокете** (существующий `sessions.tmux.test.ts`):
  трижды `create` с `autoName` → `main`, `main1`, `main2`.
- **`POST /api/sessions`** через `stubSessions` (существующий `server.test.ts`):
  тело ответа несёт `session`.
- **`Create` → `CreateOk`** (существующий `relay-link.test.ts`): второй CREATE с
  `autoName` на занятое имя → `CreateOk.session` = имя с суффиксом.
- **`RelayTransport.create`** (существующий `relay-transport.test.ts`): резолвится
  именем из `CreateOk`, без поля — запрошенным.
- **Модалка** через `FakeTransport` (по образцу `dashboard-relay.test.ts`): пустое
  поле → `autoName: true`; введённое имя → `autoName: false`; навигация — на имя из
  ответа транспорта.
- **Шелл-функция `tm`** (существующий `setup.test.ts` + новый живой прогон `sh`):
  `sh -c` с подложным `tmux` в `PATH` — занято `MyProject` → `new -s MyProject1`;
  заняты `MyProject` и `MyProject1` → `MyProject2`; свободно → `MyProject`; с аргументом →
  `new -As <имя>`. `upgradeTmFunction`: старая строка заменяется, остальное байт в байт;
  без старой строки → `null`; уже новое определение → без изменений.
- **`openCreateModal` в happy-dom** (новый тест рядом с `dashboard.test.ts`, транспорт-
  заглушка из `dashboard-relay.test.ts`): на пути создания `history.back` **не**
  вызывается (spy), итоговый `location.hash` = `termHash(созданное имя)`,
  `history.length` не вырос относительно момента до открытия модалки; путь «Отмена» —
  по-прежнему `history.back()`. Гонку саму по себе happy-dom не покажет — проверяется
  механизм, живой Chrome — в приёмке.
- **`enterAction`** — таблица истинности: `{keydown, Enter, shift}` × `enterSends` →
  `send`/`newline`; `keypress Enter` → `suppress`; `keyup Enter`, `keydown a` → `pass`.
  Плюс проверка обвязки: обработчик для `newline` даёт `defaultPrevented === true` и
  ровно один вызов `sendData` с `\x1b\r`; последующий `keypress` — ни одного `\r`.
- **Полоса вкладок** (существующий `tabs.test.ts`): `mousedown` по `.th-tab__btn` →
  `defaultPrevented`.
- **Очередь ввода** (`term.ts` через `vi.mock('@xterm/xterm')` либо вынесенный чистый
  буфер): `sendData` до `connected` не пишет в транспорт; на `connected` порядок кадров —
  RESIZE, затем накопленные данные; лимит 8 КБ; `onEnd` очищает.
- **`workspace.show('term')`** (новый тест с `vi.mock('../src/term')`): после
  `show('files')` → `show('term')` вызывается `focus()` хэндла — независимо от тумблера ⌨.

## Что построили завершённые таски

_(пока пусто — дописывается по сдаче каждого таска)_

## Из таска 01 — агент: свободное имя сессии

- `SessionService.create({name, root, dir, preset, autoName?: boolean}) -> Promise<{name: string}>` —
  с `autoName: true` (строго булев `true`) при занятом `name` подбирает `<name><n>`; без него —
  прежнее поведение (ошибка tmux наружу). Возвращает фактическое имя.
- `pickFreeName(base: string, taken: ReadonlySet<string>): string` — экспорт из `sessions.ts`;
  суффикс без разделителя, база обрезается под 40; потолок 10 000 → `Error` с базой в тексте.
- `POST /api/sessions` тело `{name, root, dir, preset, autoName?}` → `200 {ok: true, session: <фактическое имя>}`.
- Кадр `Create{name, root, dir, preset, autoName?}` → `CreateOk{session: <фактическое имя>}`.
- Ошибка исчерпания попыток: `Could not create session for «<base>»: name kept colliding after 5 attempts`.
- Тесты агента в `tsc`-сборку не входят (`include: ["src"]`) — стабы в `server.test.ts` типами не проверяются.

## Из таска 04 — `tm` в шелле и обновление rc-блока

- `tmFunction(socket: string = TMUX_SOCKET): string` — текст POSIX-функции `tm`; `export const TM_FUNCTION = tmFunction()`.
  Без аргумента: база `basename "$PWD"`; занятые имена — дословные строки `list-sessions -F '#{session_name}'`
  (`grep -qxF`, снимок один раз до цикла; нет сервера → пусто → свободно); кандидаты `<база><n>`, затем `new -s` (без `-A`);
  с аргументом — `new -As "$1"`. **D01:** `has-session -t "=<имя>"` в пробе НЕ используется — для tmux точка/двоеточие
  в цели `-t` разделяют «сессия:окно.панель», и `=foo.bar` ложно свободно (то же верно для `kill-session -t "=$1"` в `tml`/`tmc` — предсуществующий долг).
- `upgradeTmFunction(existing: string): string | null` — заменяет старую однострочную `tm() { tmux … }` новой, но только
  ПОСЛЕ первой строки маркера `# termhub`; текущая уже есть → тот же текст; нет маркера или старой строки после него → `null`.
  `zshAliasBlock()/ZSH_MARKER/hasZshMarker` без изменений.
- `maybePatchShellRc`: маркер есть, текущей `tm` нет → «Update tm? [Y/n]»; нераспознано/отказ → печать определения.
- Тест шелла: `packages/agent/test/tm-shell.test.ts` — подложный `tmux` в PATH (эмулирует `list-sessions`, лог по аргументу на строку), 7 случаев × sh/bash/zsh (если шелл есть).
- README en/ru: правило `MyProject → MyProject1 → MyProject2` для `tm` и кнопки «+»; возврат в существующую — `tml` / `tm <имя>`.

## Из таска 02 — веб: `autoName`, фактическое имя, закрытие модалки «в сторону» маршрута

- `CreateSessionInput.autoName?: boolean`; `CreateSessionResult {ok: true; session?: string}` (`api.ts`).
- `Transport.create(req): Promise<string>` — LAN: `session` из ответа, иначе `req.name`; relay: `CreateOk.session`,
  иначе запрошенное имя (`PendingCreate.name`).
- `routes.termHash(session): string` → `#/term/<encodeURIComponent>` — единый источник формата; в `workspace.ts`,
  `term.ts` (goTo), `gradle.ts`, `sw.ts` остались ручные `#/term/` — вне зоны таска 02.
- `ui.ModalClose = (next?: string | Event) => void`; `openModal(builder: (close: ModalClose) => HTMLElement)`.
  `close(next: string)` → `cleanup()` + `location.replace(next)` (запись модалки заменяется маршрутом);
  всё нестроковое (в т.ч. `Event` от прямых слушателей) → `history.back()` как раньше. Комментарий о гонке — у `close`.
- `openCreateModal(transport: Transport): void` — без колбэка, навигирует сам через `close(termHash(created))`.
  Если модалку закрыли (Esc/«Назад») до ответа агента — сессия создаётся, перехода нет (флаг `closed`).
- Тест модалки: `packages/web/test/create-modal.test.ts` (happy-dom; `location.replace` для hash там пушит запись,
  поэтому эмулирован через `history.replaceState`; дискриминатор бага — `history.back` не вызван, `replace` вызван).

## Из таска 03 — экран сессии: фокус, очередь ввода, Enter

- `web/term-keys.ts`: `enterAction(e: {type, key, shiftKey}, enterSends: boolean) -> 'send' | 'newline' | 'suppress' | 'pass'`;
  типы `EnterAction`, `EnterKeyEvent`. Обработчик в `term.ts` делегирует ей: `newline` → один `\x1b\r` + `preventDefault` + `false`;
  `suppress` (keypress Enter) → `preventDefault` + `false`; `send`/`pass` → `true`.
- `web/term.ts`: `interface TerminalHandle { focus(): void; teardown(): void }`; `mountTerminal(root, session, transport): TerminalHandle`;
  `openTerminal(root, session, transport): () => void` сохранён как обёртка (его использует `remote.ts`). Фокус — сразу после
  `term.open` + `applyKeyboardMode`, безусловно; очередь `sendData` при статусе ≠ `connected` (в т.ч. `reconnecting`), лимит 8 КБ
  (режется по байтам с конца), сброс после `sendResize()` на `connected`, очистка на `onEnd`/teardown.
- `web/workspace.ts`: сигнатуры без изменений; `show('term')` зовёт `focus()` хэндла после показа вида.
- `web/tabs.ts`: `mousedown` на `.th-tab__btn` → `preventDefault()`.
- Тестовый хелпер `packages/web/test/term-harness.ts`: `FakeTerminal` (`type()`, `key()`, `focusCalls`),
  `termTransport() -> {transport, frames, opened}`, `stubResizeObserver()` — общий для term-тестов, не тест.
