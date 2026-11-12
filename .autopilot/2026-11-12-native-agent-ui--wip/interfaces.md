# Границы и правила

Читается каждым исполнителем первым. Карта существующего кода — `notes.md`.

## Правила проекта

- Общение и комментарии — по-русски; комментарии только там, где код не самоочевиден. TypeScript strict, ESM, 2 пробела.
- Логи агента — английские: `session <имя>: <что случилось>`.
- UI-строки веба — только через `i18n.ts`, ru и en с идентичным набором ключей.
- Все вызовы tmux — через `runTmux` (`tmux-run.ts`), `execFile` без shell. В тестах — только изолированный сокет `-L termhub-test-<uniq>` + `kill-server`. Дефолтный сервер tmux и рабочий сокет `termhub` тесты не трогают.
- Имя сокета не подставляется по умолчанию — передавать `config.TMUX_SOCKET`.
- Каждая функция — на LAN и на relay; тела ответов близнецов совпадают побайтово (общая фикстура).
- libsodium не попадает в LAN-бандл: из протокола веб тянет только подпути (`@termhub/protocol/frames` и т. п.).
- Номера кадров только растут. Имя возможности — внешний контракт.
- После правки `packages/protocol/src/frames.ts` — `npm run build -w @termhub/protocol`.
- После правок веба — `npx tsc -p packages/web/tsconfig.json --noEmit`.
- Не распознали — молчим: клавиши по догадке в сессию с агентом не шлём.
- Коммиты: короткие, английские, без Co-Authored-By; пуш — только по просьбе пользователя.
- Проверки не гонять в Chrome и не запускать приватных агентов на общем сокете.
- Деплой после каждого таска (G09) делает оркестратор, не исполнитель.

## Границы, решённые в спецификации

### Провод

| Что | LAN | relay | Права |
|---|---|---|---|
| Экран панели | `GET /api/live?session=` | `FrameType.Live = 48` → `LiveResult = 49` | своя сессия; гостю можно |
| Действие | `POST /api/act` | `Act = 50` → `ActResult = 51` | `write` |
| Команды для подсказок | `GET /api/commands?session=` | `Commands = 52` → `CommandsResult = 53` | `write` |
| Подробности действия | `GET /api/feed?…&detail=<cursor>` | поле `detail` кадра `Feed` | как лента |
| Вложение | прежние `POST /api/paste-image` и `paste-chunk`, расширенные на любой тип | — | `write` |

- Кадры 48–53 несут `id`; ответ возвращает тот же `id` (как `FileOp`), очереди «один в полёте» нет.
- Гейт relay неизвестный кадр пропускает — права проверяет сам обработчик (`ownsSession`, `scope.write`).
- Возможность `CAP_CHAT = 'chat'` в `AGENT_CAPS` и `CLIENT_CAPS`. Без неё веб ничего из этой таблицы не шлёт.
- Отказы — тем же телом `{ok:false, reason, detail}`. Причины: слова ленты (`no-agent`, `unknown-format`, `no-transcript`, `lookup-failed`, `forbidden`) плюс новые только для действий: `stale` (экран уже другой), `busy` (сверка команд невозможна сейчас), `unsupported` (профиль такого не умеет).

### Пакет протокола

`packages/protocol/src/chat.ts` (подпуть `@termhub/protocol/chat`, без крипты) — формы провода, одни на агент и веб:

```ts
type AgentId = 'claude' | 'codex';
type ScreenKind = 'idle' | 'working' | 'question' | 'permission' | 'menu' | 'unknown';
interface ScreenOption { key: string; label: string; selected?: boolean; checked?: boolean }
interface ScreenQuestion { stamp: string; title: string; body?: string; options: ScreenOption[]; multi?: boolean; freeText?: boolean }
interface ScreenState {
  kind: ScreenKind;
  status?: string;          // строка работы, как её рисует агент
  elapsed?: number;         // секунды, если агент показывает
  question?: ScreenQuestion; // для question и permission
  mode?: string;            // id режима из профиля
  input?: string;           // текст в строке ввода агента
  queued?: number;          // сообщений в очереди агента
}
interface LiveState { ok: true; agent: AgentId; version?: string; tested: boolean; model?: string; screen: ScreenState;
  modes: {id: string; label: string}[]; models: {id: string; label: string}[] }
type ChatAction =
  | { kind: 'prompt'; text: string; over?: boolean }   // over: отправить поверх текста в строке агента
  | { kind: 'answer'; stamp: string; option?: string; options?: string[]; text?: string }
  | { kind: 'interrupt' }
  | { kind: 'mode'; to: string }
  | { kind: 'model'; to: string }
  | { kind: 'compact' }
  | { kind: 'take-input' };                             // забрать текст из строки агента: вернуть и стереть
type ActResult = { ok: true; screen: ScreenState; taken?: string } | { ok: false; reason: string; detail: string };
interface ChatCommand { name: string; hint?: string; source: 'builtin' | 'user' | 'project' | 'skill' | 'screen'; args?: string }
type CommandsResult = { ok: true; commands: ChatCommand[]; verified: boolean } | { ok: false; reason: string; detail: string };
interface ToolDetail { input?: string; output?: string; diff?: {path: string; lines: {t: '+' | '-' | ' '; s: string}[]}[]; pending?: boolean; truncated?: boolean }
```

`stamp` — отпечаток заголовка и вариантов вопроса; его считает одна функция `questionStamp` в этом же файле.

### Агент (`packages/agent/src`)

| Модуль | Владеет | Отдаёт | Прячет |
|---|---|---|---|
| `agent-profiles.ts` | профили Claude и Codex как данные: клавиши (`submit`, `interrupt`, `modeCycle`, `newline`), режимы, модели, встроенные команды, команды `model`/`compact`, признаки экранов, диапазон проверенных версий | `profileOf(agent): AgentProfile`, `isTested(agent, version): boolean` | — |
| `agent-screen.ts` | распознавание экрана — чистые функции | `readScreen(lines: string[], profile): ScreenState`, `readPopup(lines, profile): ChatCommand[]` | регулярки и геометрию рамок |
| `pane-io.ts` | одноразовые чтение экрана и ввод в активную панель сессии вне `Link` | `capturePane(session, socketName): Promise<{lines: string[]; alt: boolean; cols: number; rows: number}>`, `sendKeys(session, socketName, bytes: Uint8Array)`, `pasteText(session, socketName, text)` | адрес активной панели, `escapeInput`, bracketed paste |
| `agent-live.ts` | состояние и действия чата | `sessionLive(session, sources?): Promise<LiveState \| Failure>`, `sessionAct(session, action, sources?): Promise<ActResult>`; шов `LiveSources {socketName?, capture, send, paste, resolve, version}` | сверку отпечатка, цикл режима, ожидание экрана после клавиш |
| `agent-commands.ts` | список команд | `sessionCommands(session, sources?): Promise<CommandsResult>` | чтение каталогов команд и навыков, сверку с экраном и её кэш на хосте (`~/.termhub/commands-<agent>-<version>.json`, 0600) |
| `transcript-feed.ts` (расширение) | подробности действия | `readDetail(file, agent, cursor): Promise<ToolDetail \| FeedFailure>`; у записи `tool` появляется `detail: true`, если подробности есть | сопоставление вызова и результата по id |
| `transcript-usage.ts` (расширение) | занятость контекста | поле `context {used: number; limit?: number}` в `UsagePage` | — |
| `paste-image.ts` (расширение) | произвольные файлы | прежний `PasteStore`, принимает имя и любой тип; предел 50 МиБ | выбор имени и расширения |
| `chat-request.ts` | один разбор запросов чата на оба транспорта (образец — `feed-request.ts`) | `livePage(read, raw)`, `actPage(act, raw)`, `commandsPage(read, raw)` — не бросают | — |

`AgentServer` и `RelayLink` принимают `{live?, act?, commands?}` тем же приёмом, что `feed`/`usage`.

### Веб (`packages/web/src`)

| Модуль | Владеет | Отдаёт | Прячет |
|---|---|---|---|
| `transport.ts` / `api.ts` / `relay-transport.ts` | провод | `Transport.live(session)`, `.act(session, action)`, `.commands(session)`, `.feedDetail(session, cursor)`, `.pasteFile(blob, name)` | корреляцию по `id`, таймауты |
| `session-view.ts`-сосед `view-pref.ts` | выбор вида по сессии | `sessionViewPref(session): 'chat' \| 'term' \| null`, `setSessionViewPref(session, v)`, `defaultView(info, caps): 'chat' \| 'term'` | ключ `termhub.sessionView` |
| `chat.ts` | экран чата | `mountChat(host, session, transport) -> {el, teardown()}`; внутри — прежний `mountFeed` как переписка | компоновку, автопрокрутку, отправленные-но-не-подтверждённые сообщения |
| `chat-live.ts` | опрос экрана и всё, что из него рисуется | `mountLive(host, session, transport, onState) -> {state(), act(action), teardown()}` — полоса состояния, «Стоп», режим, модель, контекст, карточка вопроса | период опроса, условия опроса (вкладка активна, страница видима) |
| `chat-composer.ts` | поле ввода | `mountComposer(host, session, deps) -> {el, focus(), setText(), teardown()}` | черновик (`termhub.chatDraft.<session>`), вложения, окно подсказок |
| `chat-complete.ts` | подсказки — чистые функции | `completionAt(text, caret): {kind: 'slash' \| 'file'; query; from; to} \| null`, `rankCommands(commands, query)`, `applyCompletion(text, at, value)` | — |
| `chat-tool.ts` | раскрытие действия | `mountToolDetail(row, entry, load)`, `renderDiff(detail)` | — |
| `chat-term.ts` | окошко терминала | `mountChatTerm(host, session, transport) -> {show(), hide(), teardown()}` поверх `mountTerminal(…, {embedded: true, passive: true})` | ленивое создание, сворачивание |
| `chat-health.ts` | счётчик неузнанных экранов и плашка версии | `noteUnknown(session, agent, version)`, `healthRows()`, `resetHealth()`, `versionNoticeDue(agent, version)` | ключи `localStorage` |
| `feed.ts` (правка) | переписка | прежний интерфейс; markdown-рендер сообщений, кликабельные пути, слот раскрытия действия | — |
| `ui.ts` (правка) | переключатель вида в `renderHoloBar` | — | — |

`mountTerminal` получает опцию `passive` — окошко не заявляет и не просит размер (как гость-зритель).

### Швы тестов

| Шов | Чем проверяется |
|---|---|
| `readScreen` / `readPopup` | чистые функции на снимках `packages/agent/test/fixtures/screens/<agent>/<name>.txt` (+ `.json` с версией и размером) |
| `sessionLive` / `sessionAct` / `sessionCommands` | подменённые `LiveSources` — без tmux |
| `pane-io` | живой tmux на изолированном сокете (`pane-io.tmux.test.ts`), в панели — обычный shell-скрипт, не агент |
| `readDetail`, `context` | подложенные файлы транскриптов |
| маршруты LAN и кадры relay | `server.test.ts`, `relay-link.test.ts`, общая фикстура `chat-fixture.ts` |
| веб | мок транспорта и happy-dom; relay — `relay-harness.ts` |

## Что построили готовые таски

*(дописывается по мере сборки)*

## Команды и окружение

- Node ≥ 22. `npm install` при зависании реестра: `NODE_OPTIONS=--tls-max-v1.2`. Новых зависимостей сборка не требует.
- Все тесты: `npx vitest run` (на чистом дереве: `rm -rf packages/{agent,relay}/static` перед прогоном). Один файл: `npx vitest run <путь>`.
- Типы веба: `npx tsc -p packages/web/tsconfig.json --noEmit` (предсуществующая придирка в `relay-transport.ts` про Uint8Array/BlobPart — не блокер).
- Сборка: `npm run build`; протокол отдельно: `npm run build -w @termhub/protocol`.
- pty/tmux не спавнится в песочнице — перезапустить тесты без песочницы.
- Красное не от своих правок: `gradle.tmux.test.ts`, два теста `vcs.git.test.ts` по таймауту, один тест `server.test.ts` на 429 при параллельном прогоне.
- Не трогать: `.worktrees/`, рабочий сокет tmux `termhub`, `~/.termhub/`, `~/.claude/`, `~/.codex/` (только чтение).
