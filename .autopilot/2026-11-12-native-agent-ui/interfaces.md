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

### Таск 01 — протокол, профили, распознавание (расхождения с таблицами выше — верно то, что здесь)

- `@termhub/protocol/chat`: типы из раздела «Пакет протокола» плюс `LiveResult`, `ChatFailure`; `questionStamp(title, options)` — принимает заголовок и варианты; отметки, указатель и подпись свободного варианта в отпечаток не входят.
- `FrameType.Live … CommandsResult = 48 … 53`; `CAP_CHAT` в `AGENT_CAPS` и `CLIENT_CAPS` (агент объявляет её уже сейчас, маршруты строит таск 02).
- `profileOf(agent): AgentProfile`, `isTested(agent, version?)`; `readScreen(lines, profile): ScreenState`, `readPopup(lines, profile): ChatCommand[]`.
- Строки для `readScreen` — **с оформлением** (`capture-pane -p -e`); `capturePane` обязан снимать с `-e`.
- Добавлены поля: `ScreenOption.free` (свободный вариант лежит в `options`, его клавиша — его `key`), `ScreenState.menu` (id известного меню), `ScreenState.model` (называет только Codex; у Claude модель — из транскрипта).
- `ChatCommand.name` — без ведущего «/». `profile.commands` — `{model, compact}` именами команд.
- `profile.keys.clearInput: string[]` (Claude — два Esc, Codex — Ctrl+C) — **только при непустой строке**: на пустой Claude открывает меню отката, Codex закрывается.
- Режимы: Claude `manual|accept|plan|auto` (порядок цикла Shift+Tab), Codex `default|plan`.
- Многошаговые ответы Claude: несколько отметок — цифры, стрелка вправо, экран подтверждения (распознаётся как вопрос «Ready to submit your answers?»), «1»; свой ответ — цифра свободного варианта, текст, Enter.
- Вставка: `send-keys -H` с `ESC[200~…ESC[201~` либо `paste-buffer -p`; перенос строки — `ESC`+`CR` только одной посылкой.
- Модель меняется только через меню агента (`/model` без имени); `/model <имя>` не использовать — пишет настройки агента.
- Claude не рисует число очереди (считаются строки очереди) и не даёт предела контекста.
- Список по «/» у Claude — окно в 4–5 строк, полный список требует прокрутки.
- Подвал Codex настраивается пользователем (`/statusline`): нестандартный подвал — экран `unknown`; это допустимый исход.
- Снимки: `packages/agent/test/fixtures/screens/{claude,codex}/*.txt` + `.json`. Разбор замеров — `docs/native-agent-ui.ru.md`.
- Не измерено (осторожно): `/compact` с отправкой, запрос разрешения Claude на команду оболочки, правки Codex патчем, ширина панели меньше 50.

## Команды и окружение

- Node ≥ 22. `npm install` при зависании реестра: `NODE_OPTIONS=--tls-max-v1.2`. Новых зависимостей сборка не требует.
- Все тесты: `npx vitest run` (на чистом дереве: `rm -rf packages/{agent,relay}/static` перед прогоном). Один файл: `npx vitest run <путь>`.
- Типы веба: `npx tsc -p packages/web/tsconfig.json --noEmit` (предсуществующая придирка в `relay-transport.ts` про Uint8Array/BlobPart — не блокер).
- Сборка: `npm run build`; протокол отдельно: `npm run build -w @termhub/protocol`.
- pty/tmux не спавнится в песочнице — перезапустить тесты без песочницы.
- Красное не от своих правок: `gradle.tmux.test.ts`, два теста `vcs.git.test.ts` по таймауту, один тест `server.test.ts` на 429 при параллельном прогоне.
- Не трогать: `.worktrees/`, рабочий сокет tmux `termhub`, `~/.termhub/`, `~/.claude/`, `~/.codex/` (только чтение).
- **Ремонт по ревью (сделан):** `questionStamp(title, options, body?)` — в отпечаток входят заголовок, клавиши с подписями вариантов и тело запроса; пробелы и переносы выброшены. Сверка в `sessionAct`: сравнивать `stamp` из действия со `screen.question.stamp` свежего `readScreen`; своей копии отпечатка не заводить. Тело читается с видимого экрана: запрос, не поместившийся в панель, при другой высоте даст другой отпечаток — исход безопасный (отказ `stale`).

### Таск 02 — агент: экран и действия

- LAN: `GET /api/live?session=` → 200 `LiveResult`; `POST /api/act {session, action}` → 200 `ActResult`. Отказ всегда телом `{ok:false, reason, detail}`, код HTTP 200; битое тело → `{ok:false, reason:'unsupported', detail:'not a chat action'}`.
- relay: `Live {id, session}` → `LiveResult {id, ...тело}`; `Act {id, session, action}` → `ActResult {id, ...тело}` — `id` рядом с телом, не `{id, result}`. Гость: чужая или сборочная сессия → `forbidden`; `Act` без `write` → `forbidden`.
- `pane-io.ts`: `capturePane(session, socketName) → {lines, alt, cols, rows, pane, command}` (снимает с `-e`, бросает на несуществующей сессии); `sendKeys(session, socketName, bytes, pane?)`; `pasteText(session, socketName, text, pane?)` — bracketed paste, LF→CR, предел 64 КиБ.
- `agent-live.ts`: `sessionLive(session, sources?)`, `sessionAct(session, action, sources?)`, `agentInfo(agent, file, command) → {version?, model?}`; шов `LiveSources {home, socketName?, capture, send, paste, resolve, version, sleep}`. Действия одной сессии идут по очереди.
- `chat-request.ts`: `LiveReader`, `ActRunner`, `chatSession(raw)`, `livePage`, `actPage`, `parseAction`; **`commandsPage` — за таском 03**. `AgentServer`/`RelayLink` принимают `{live?, act?}`. Фикстура `packages/agent/test/chat-fixture.ts`: `LIVE_STATE(_JSON)`, `ACT_*`, `withId(id, json)`.
- Поведение: `interrupt` на `idle` клавиш не шлёт; `prompt … over` стирает строку агента и отправляет новое; `model` игнорирует `to`, открывает меню агента, ждёт до 5 с и отдаёт `ok:true` с фактическим экраном (как и `mode`); `compact`/`model`/`take-input`/`over` при работающем агенте → `busy`; `take-input` на пустой строке → `taken:''`; свой текст ответа — только Claude (Codex → `unsupported`); несколько отметок — `options` = полный желаемый набор клавиш, только Claude.
- Сессия с Claude без транскрипта отвечает `ok:true` (первый запрос).
- Причины отказа действий: `stale`, `busy`, `unsupported`, `forbidden` + слова ленты.

### Таск 04 — веб: оболочка чата

- `Transport`: `live(session)`, `act(session, action)`, `commands(session)`, `feedDetail(session, cursor): Promise<DetailResult>` (`({ok:true} & ToolDetail) | FeedFailure`), `pasteFile(blob, name): Promise<string>`. Типы чата реэкспортированы из `transport.ts`. `FeedOptions.detail?: string`; `FeedEntry.detail?: true`.
- **Чего веб ждёт от таска 03:** `GET /api/feed?session=&detail=<cursor>` и кадр `Feed {session, detail}` (в той же очереди «один в полёте», что страница, ответ кадром `FeedResult`) → `{ok:true, ...ToolDetail}`; `POST /api/paste-image?type=<mime>&name=<имя>`; `paste-chunk` с полем `name` на каждом куске; `Commands {id, session}` → `CommandsResult {id, ...тело}`, `GET /api/commands?session=`.
- `mountChat(host, session, transport) → ChatHandle` = `FeedHandle` (`el, searchSlot, entries, loadOlder, jumpTo, teardown`) + `feed` + `slots {status, question, terminal, composer}` + `offline()`. Слоты — пустые `div[data-slot=…].th-chat__slot--<имя>` (пустые скрыты CSS); порядок: status, переписка, question, terminal, composer; плашка `.th-chat__offline` над ними. Локальной записи «отправляется / в очереди» в переписке пока нет — её добавляет таск 06.
- `mountFeed(host, session, transport, chat?: FeedChatOptions {linker, onConnection, emptyState})` — режим чата без своего каркаса.
- `view-pref.ts`: `sessionViewPref`, `setSessionViewPref` (`localStorage['termhub.sessionView']`), `chatCapable(info, caps)`, `defaultView`, `effectiveView(session, info, caps)`, `wantsChat`, `sessionInfo(transport, session)` (кэш списка 4 с).
- `chat-render.ts`: `renderChatMarkdown`, `linkifyPaths`, `createPathLinker`, `copyButtonFor`. `chat-tool.ts`: `mountToolDetail(row, entry, load)`, `renderDiff(detail)`.
- Вход в сессию: первый показ терминала асинхронный (ждёт `whenCap('chat')` и список, до 1,5 с, иначе терминал); в чат-сессии терминал не монтируется, пока не выбран; вход в чат — `location.replace('#/sfeed/<s>')`. Переключатель вида — внутри плашки «Терминал» в `renderHoloBar`.

### Таск 05 — веб: живое состояние

- `mountLive(host: {status, question, terminal, composer}, session, transport, onState?) → LiveHandle {state(): LiveState|null; act(action): Promise<ActResult>; refresh(): Promise<void>; subscribe(fn(state|null, changed)): unsubscribe; teardown()}`.
- `act` сам применяет экран из ответа; `stale` перечитывает экран, `unsupported` пишет сбой. Отказ агента — значение `{ok:false}`, обрыв сети — исключение. Тосты на отказ ставит UI полосы, а не `act` — поле ввода показывает свои.
- `ChatHandle.live: LiveHandle` — поле ввода берёт состояние (`screen.kind`, `screen.input`, `queued`) и шлёт `prompt`/`take-input` отсюда.
- `FeedHandle.refresh(): void` — просит приращение переписки сразу.
- Ряд управления (режим, модель, контекст и расход, «Сжать», «Показать терминал») вставлен **перед** слотом `composer` как `.th-live__controls`; слот `composer` пуст и ждёт таск 06.
- `mountChatTerm(host, session, transport) → {el, show, hide, visible, teardown}`; `mountTerminal(…, {embedded, passive})`.
- `chat-health.ts`: `noteFailure(session, kind: 'unknown'|'mode'|'model'|'unsupported', agent, version?)`, `noteUnknown`, `healthRows`, `resetHealth`, `versionNoticeDue`.
- `UsagePage.context?: {used, limit?}` в типе `usage.ts`.

### Таск 03 — агент: команды, подробности, контекст, файлы

- `GET /api/commands?session=` и кадр `Commands {id, session}` → `CommandsResult {id, ...}`: `{ok:true, commands: ChatCommand[], verified}`; порядок — встроенные профиля, проектные, пользовательские, навыки, затем `screen`. Гость без `write` → `forbidden`. У Codex — только `~/.codex/prompts` как `prompts:<имя>`.
- Подробности: `GET /api/feed?session=&detail=<cursor>` и поле `detail` кадра `Feed` → `{ok:true, input?, output?, diff?, pending?, truncated?}` либо отказ ленты. Есть diff — `input`/`output` опущены. Запись `tool` Claude и Codex несёт `detail: true`. Несколько инструментов в одной строке Claude делят курсор — `detail` отдаёт первый.
- Расход: `context?: {used, limit?}`; у Claude предела нет, у Codex — из транскрипта или профиля.
- Загрузка: `POST /api/paste-image?type=<mime>&name=<имя>` → `{path}`; `paste-chunk` несёт `name` (решает первый кусок). С `name` — любой тип до 50 МиБ; без — прежняя картинка до 20 МиБ. Ошибки: «File is too large», «Empty file».
- Сверка списка команд: один раз на агента и версию, не чаще раза в 10 минут при неудаче; на живом Claude может не уложиться в 5 с → `verified: false`.

### Таск 06 — веб: поле ввода

- `chat-complete.ts`: `completionAt(text, caret)`, `rankCommands(commands, query)`, `applyCompletion(text, at, value, space = true) → {text, caret}`.
- `mountComposer(host, session, {transport, live, thread: Pick<FeedHandle, 'addLocal' | 'refresh'>}) → {el, focus(), setText(), teardown()}`; `ChatHandle.composer: ComposerHandle | null` (null у гостя без `write`).
- `FeedHandle.addLocal(text, state?: 'sending' | 'queued' | 'failed') → LocalMessage {set(state, {note?, actions?, delivered?}), remove()}`.
- Черновик: `localStorage['termhub.chatDraft.<session>']` `{text, files[{name, path, image}]}`. «@» вставляет `@путь`.

### Таски 07–18 — что добавилось после первой шестёрки

- **Окно терминала в чате** (07, 10): `mountChatTerm(host, session, transport, {onClose}) → {el, show, hide, visible, setReason, teardown}`; окно `position: absolute` внутри `.th-chat`, шапка с причиной и кнопкой закрытия. Окно подключается зрителем: `TermChannelOpts.passive` → LAN `passive: true` в каждом RESIZE, relay — в OPEN → `attachTerminal({passive})` → tmux `attach -f ignore-size`. Терминал с контейнером нулевой ширины размер не шлёт. Вид меняют два одинаковых опроса подряд (`SETTLE_FRAMES`).
- **Причина неузнанного экрана** (08): `ScreenState.why?: string` — `empty screen`, `no agent on screen`, `no input frame`, `input frame malformed`, `content below footer`, `footer not recognized`, `dialog not recognized`, `dialog cut off`. В вебе — в шапке окна и в `chat-health.ts` (`HealthRow.why`, `whyAt`).
- **Распознавание** (08, 09, 13, 14, 16, 18): список фоновых агентов под подвалом Claude (`screen.tray`), линейка рамки ввода с подписью, подвал Codex из нескольких строк (`footerLines`, `statusLine`), диалог MCP Codex (цифра подтверждает сама), `ScreenState.tokens`, `waiting`, `shells`, `agents: BackgroundAgent[]`, `agentCount`, `pending`; `ScreenOption.hint`; `ScreenQuestion.notes`, `steps: ScreenStep[]`, `step`. `readPending(lines, profile) → {key: 'showPending' | 'answerPending', count?}`; `ScreenSigns.pending: PendingSign[]`.
- **Действия** (16, 18): `ChatAction` + `{kind: 'show-question'}` (Ctrl+/ для побочной беседы, Shift+← для блока «Queued follow-up inputs» — решает экран) и `{kind: 'step', stamp, to}`. Ответ, после которого экран 2,4 с остался тем же вопросом или неузнанным, — `stale`.
- **Вид чата** (07, 11, 15, 17): `chat-view.ts` (`chatViewVars`, `bindChatView`) — параметры вида на чат; `chat-typed.ts` — строка «в терминале набрано»; шапка сессии общая (`sessionBarTools`, `mountSessionBar({tools})`); состояние, время, токены и «Стоп» — в шапке переписки (`FeedHandle.stateSlot`); три кнопки-иконки (поиск, рассуждения, действия); `chat-color.ts` (`highlightShell`, `createMark`, `ansiNodes`); `ToolResult {state, exit?}` у записи `tool` и в подробностях; слежение за низом по `ResizeObserver`.
- **Лента** (11): `FeedEntry.desc`, `from`, `elapsed`, `outcome`; `note` += `agent-start | agent-done | agent-message`. Приращение раз в секунду при `working`.
- **Картинки** (12): LAN `GET /api/files/image?session=&path=` , relay — действие `image` кадра `FileOp`; `FileService.readImage/imageChunk/sniffImage`, `agentTempDirs`; каталоги: корни сессий, `~/.termhub/paste`, `/tmp/claude-<uid>`; гостю — только каталог своей сессии и единый отказ `image unavailable`. Веб: `Transport.image`, `chat-images.ts`.
- **Фоновые агенты и команды** (14): ряд управления — `.th-live__bg--agents`, `.th-live__bg--shells`, `.th-live__bg-compact`, лист `.th-live__sheet`.
