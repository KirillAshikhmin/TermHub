# Интерфейсы и правила проекта

Читается ИСПОЛНИТЕЛЕМ каждого таска до первой строчки кода. Границы взяты из
`spec.md` (раздел «Границы и швы») — они уже решены, придумывать заново нечего.

## Правила проекта (иначе не вывести)

- Монорепо npm workspaces: `packages/protocol`, `packages/agent`, `packages/relay`,
  `packages/web`. Node ≥ 22, TypeScript **strict**, ESM везде, отступы 2 пробела.
- Комментарии — по-русски и только там, где код не самоочевиден.
- **UI-строки веба — только через i18n** (`packages/web/src/i18n.ts`), оба словаря
  `ru` и `en` с идентичным набором ключей (это проверяется тестом).
- Тесты: `npx vitest run` из корня (полный прогон), один файл —
  `npx vitest run packages/agent/test/<файл>`. Сборка: `npm run build`.
- Типизация веба сборкой НЕ проверяется (`vite build` без tsc). После правок веба
  обязателен `npx tsc -p packages/web/tsconfig.json --noEmit`.
  Известная предсуществующая придирка в `relay-transport.ts` (Uint8Array/BlobPart) —
  не блокер, её чинить не надо.
- **tmux в тестах — только изолированный сокет** `-L termhub-test-<uniq>` + `kill-server`
  в teardown. Дефолтный tmux-сервер не трогать никогда.
- Все вызовы tmux и внешних команд — через `execFile` **без shell** (анти-RCE).
  Имена/пути/аргументы валидируются регулярками, пути проверяются realpath на
  вхождение в whitelist корней (образец — `packages/agent/src/files.ts`, `vcs.ts`).
- В проде рабочие сессии живут на сокете `-L termhub` (`config.TMUX_SOCKET`);
  имя сокета прокидывается снаружи, хардкодить нельзя.
- **libsodium не должен попасть в LAN-бандл веба.** Крипта грузится ленивым
  `import('./remote')`. Фрейм-кодек тянуть из `@termhub/protocol/frames`.
- Не коммитить и не пушить сверх того, что просит таск.
- Нет зависимости — вернуть `BLOCKED`, а не ставить пакет. Новых npm-зависимостей
  в этой функции не предполагается вовсе.

## Границы, решённые в спецификации

| Модуль | Владеет | Выставляет | Прячет |
|---|---|---|---|
| `packages/agent/src/gradle.ts` | всё знание про Gradle на стороне Mac | `detectProject`, `listTasks`, `listRunConfigs`, `startRun`, `stopRun`, `runStatus`, `buildSessionName`, `isBuildSessionName` | парсинг вывода `tasks --all`, парсинг XML, кэш, вызовы tmux, выбор wrapper/gradle |
| `packages/agent/src/sessions.ts` | список сессий | без изменений | фильтрацию сборочных сессий из `list()` |
| `packages/agent/src/server.ts` | HTTP-роуты | `POST /api/gradle` | — |
| `packages/agent/src/relay-link.ts` | E2E-мост | обработку `Gradle`/`GradleResult` | проверку прав гостя |
| `packages/protocol/src/frames.ts` | контракт | типы Gradle + `FrameType.Gradle`/`GradleResult` | — |
| `packages/web/src/gradle.ts` | экран вкладки | `mountGradle(el, transport, session) => () => void` | раскладку, недавние, терминал вывода |
| `packages/web/src/gradle-view.ts` | чистые рендеры вкладки | `groupTasks`, `filterTasks`, `renderTaskRow`, `renderConfigRow` | — |
| `packages/web/src/transport.ts` | транспорт | `gradle<T>(action, params): Promise<T>` в обеих реализациях | различие LAN/relay |
| `packages/web/src/ui.ts` | Holo-бар | `renderHoloBar({active: … \| 'gradle', …})` | асинхронное появление 4-го таба и кэш детекта |

### Контракт (задаётся таском 01, дальше — не менять без D-строки)

```ts
// packages/protocol/src/frames.ts
export interface GradleProject {
  /** Корень проекта (= корень сессии). */ dir: string;
  /** Есть ли ./gradlew (исполняемый). */ wrapper: boolean;
  /** Найденные маркеры: settings.gradle[.kts] / build.gradle[.kts] / gradlew. */ markers: string[];
}

export interface GradleTask {
  /** Полное имя: `:app:assembleDebug` или `assemble` для корневого проекта. */ name: string;
  /** Проект-владелец: ':' для корневого, ':app' и т.п. для подпроекта. */ project: string;
  /** Группа из вывода `tasks --all`; '' → «Other tasks». */ group: string;
  description: string;
}

export interface GradleTasks {
  tasks: GradleTask[];
  /** Порядок групп в том виде, в каком их напечатал Gradle. */ groupOrder: string[];
  /** Когда список получен (мс epoch) — для «Обновить». */ fetchedAt: number;
}

export interface GradleRunConfig {
  name: string;
  /** Таски в порядке из XML. */ tasks: string[];
  /** scriptParameters как одна строка (может быть пустой). */ args: string;
  /** Рабочая папка запуска (абсолютная, внутри корня сессии). */ dir: string;
  /** Откуда прочитана: '.run' | 'runConfigurations' | 'workspace'. */ source: string;
}

export type GradleRunPhase = 'idle' | 'running' | 'finished';

export interface GradleRunState {
  phase: GradleRunPhase;
  /** Имя сборочной tmux-сессии (для openTerm); null — её нет. */ session: string | null;
  /** Что запущено сейчас/последним. */ command: string | null;
  startedAt: number | null;
}

export interface GradleRunRequest {
  session: string;
  tasks: string[];
  args: string[];
  /** Подпапка запуска относительно корня сессии; '' — корень. */ subdir: string;
}
```

Экшены `POST /api/gradle` и фрейма `Gradle` (один и тот же контракт):
`{ action: 'detect' | 'tasks' | 'configs' | 'run' | 'stop' | 'status', session, ...params }`
→ `GradleProject | null` · `GradleTasks` · `GradleRunConfig[]` · `GradleRunState`.

## Швы для тестов (их три, других не заводить)

1. **`packages/agent/test/gradle.unit.test.ts`** — чистые функции `gradle.ts`:
   `parseTasksOutput`, `parseRunConfigXml`, `detectProject` (на временном каталоге),
   `buildSessionName`, валидация имён тасок и аргументов. Основной объём проверок.
2. **`packages/agent/test/gradle.tmux.test.ts`** — изолированный сокет
   `-L termhub-test-<uniq>`: `startRun`/`stopRun`/`runStatus` на команде-пустышке
   (не на настоящем Gradle) и фильтрация сборочных сессий из `SessionService.list()`.
3. **`packages/web/test/gradle-view.test.ts`** — чистые рендеры и группировка,
   без монтирования экрана.

Поведение проверяется ЧЕРЕЗ эти швы. Новых швов не создавать.

## Что дописывают исполнители

Каждый таск, закончив, добавляет сюда 3–8 строк: что реально выставил наружу
(имя + сигнатура), если это отличается от заявленного выше, и одну строку почему.

### Дописано таском 01 (`packages/agent/src/gradle.ts`)

- `parseTasksOutput(out: string, fetchedAt?: number): GradleTasks` — второй параметр
  добавлен, чтобы шов 1 проверял `fetchedAt` детерминированно (по умолчанию `Date.now()`).
- `parseRunConfigXml(xml: string, opts: { projectDir: string; source: string }): GradleRunConfig[]`
  — `$PROJECT_DIR$` подставляется здесь, realpath-проверка вхождения в корень остаётся
  в асинхронном `listRunConfigs`.
- `listTasks(dir, opts?: { refresh?: boolean })` — `ListTasksOpts` экспортирован.
- Валидация вынесена в две функции вместо одной: `checkTaskName(name): void` и
  `checkArgs(args): void` (обе бросают), плюс `export const MAX_ARGS = 32`. Так их
  зовёт таск 02 отдельно для тасок и для аргументов.
- `GradleTask.group` — заголовок секции из вывода Gradle дословно («Build tasks»,
  «Other tasks»); `''` остаётся зарезервированным для таски без секции и рисуется
  как «Other tasks». `groupOrder` — порядок печати, «Other tasks» принудительно последней.
- `listRunConfigs` пропускает конфигурацию, чей `externalProjectPath` не существует
  (realpath бросает) — иначе проверку «внутри корня» не сделать; конфигурация без
  единой таски (`taskNames` пуст) наружу не отдаётся вовсе.
- Имя конфигурации занимает ПЕРВЫЙ источник по приоритету, даже если его папка не
  прошла проверку на вхождение в корень: отвергнутое имя не воскресает из младшего
  источника. Бюджет `MAX_CONFIG_FILES = 100` тратится только на реально прочитанные
  файлы (пропущенные по размеру его не расходуют).

### Ограничения таска 01, которые обязаны знать следующие (из ревью)

- **Проверку `dir` делает ВЫЗЫВАЮЩИЙ.** `detectProject`/`listTasks`/`listRunConfigs`
  принимают папку на веру. Резолв корня сессии через realpath и проверку вхождения
  в whitelist корней обязан сделать таск 03 (`server.ts` / `relay-link.ts`) ДО вызова.
- **Сигнатура кэша списка тасок — только build-файлы КОРНЯ проекта.** Правка
  `app/build.gradle.kts` кэш не инвалидирует. Значит, таск 05 НЕ обещает в UI
  автообновление списка: актуализация — кнопкой «Обновить» (`refresh: true`).
- **`GradleTask.group` всегда непустой** — таску вне секции парсер пропускает.
  Ветку под `group === ''` в `gradle-view.ts` не писать, она мёртвая.

### Дописано таском 02 (`packages/agent/src/gradle.ts`, `sessions.ts`)

- `runStatus(opts: RunTargetOpts)`, `stopRun(opts: RunTargetOpts)`,
  `startRun(opts: StartRunOpts)` — все возвращают `Promise<GradleRunState>`.
  `RunTargetOpts = { session: string; socketName?: string }`,
  `StartRunOpts = RunTargetOpts & { dir: string; root?: string; tasks: string[]; args?: string[]; force?: boolean }`.
- `force` добавлен сверх заявленного контракта: без него запуск поверх идущей сборки
  НЕ происходит — возвращается её состояние (`phase: 'running'`), и это тот ответ,
  на котором таск 05 рисует «Остановить и запустить» / «Отмена» (история 16).
- `dir` — готовая папка запуска: подстановку `subdir` из `GradleRunRequest` и realpath-проверку
  вхождения в корень сессии делает вызывающий (таск 03), как и в `detectProject`/`listTasks`.
- `root` — корень проекта, где ищется wrapper (§6). Таск 03 обязан передавать корень сессии:
  многомодульная сборка держит `gradlew` только в корне, а запуск идёт в подпапке. Из подпапки
  wrapper адресуется относительным путём (`../gradlew`), `cwd` при этом — папка запуска.
  По умолчанию `root = dir` (запуск из корня). Папка запуска вне корня — ошибка.
- Что запущено, когда и как зовут оболочку сессии, хранится в user-опциях самой tmux-сессии
  (`@termhub_gradle_cmd/_started/_shell`) — статус идущей сборки переживает рестарт агента.
  Счётчик «вторая Стоп подряд» — в памяти агента: после рестарта первый «Стоп» снова шлёт C-c.
- Exit-код наружу не отдаётся (в `GradleRunState` его нет): он только строкой
  `[termhub] gradle exit=N` в терминале — таск 05 читает её из потока вывода.

### Ограничения таска 02, которые обязаны знать следующие

- **Каждый запуск ПЕРЕСОЗДАЁТ сборочную сессию** (`kill-session` + `new-session`), чтобы
  на экране не оставался вывод прошлой. Значит, приаттаченный веб-терминал в этот момент
  отваливается: таск 05 обязан переподключить `openTerm` ПОСЛЕ ответа на `run`.
- **`runStatus` первые 5 с после старта (`START_GRACE_MS`) отдаёт `running`,** даже если
  оболочка ещё не начала команду, — иначе только что запущенная сборка читалась бы как
  `finished`. Побочное следствие: мгновенно упавшая сборка ~5 с показывается как «идёт»,
  и повторный запуск без `force` в это окно блокируется.
- **Таск 05: пока `runStatus` первые 5 с держит `running`, признаком завершения считать
  уже напечатанную в выводе строку `[termhub] gradle exit=N`, а не только `phase`.**
- `stopRun` на завершившейся сборке ничего не делает и сессию не убирает — вывод ещё нужен;
  убирает её следующий запуск.

### Ограничения таска 02 для таска 03 (из ревью починки)

- **`startRun` обязан получать `root` — корень проекта — отдельно от `dir`.** `root`
  необязателен и по умолчанию равен `dir`: забыл передать → wrapper снова ищется в
  папке запуска, и тесты этого не заметят. Ревью таска 03 проверяет реальный вызов.
- **`root` и `dir` передаются уже прошедшими `realpath`.** `../gradlew` раскрывается
  ядром физически, поэтому симлинк в пути запуска увёл бы его мимо `<root>/gradlew`.
  Таск 03 и так делает realpath-проверку вхождения в whitelist — передавать надо
  результат этой проверки, а не исходную строку.

### Дописано таском 03 (`gradle-action.ts`, `server.ts`, `relay-link.ts`, web-транспорт)

- **Общий обработчик вынесен в НОВЫЙ модуль `packages/agent/src/gradle-action.ts`:**
  `runGradleAction(deps: GradleActionDeps, req: Record<string, unknown>): Promise<unknown>`,
  `GradleActionDeps = { sessions: SessionService; roots: string[]; socketName?: string; scope?: DeviceScope }`.
  Естественное место (по образцу `runRepoAction` в `vcs.ts`) — сам `gradle.ts`, но он
  зона тасков 01–02; отдельный модуль оставляет `gradle.ts` нетронутым и держит
  обработчик в единственном экземпляре на оба транспорта.
- Резолв корня и прав живёт ТОЛЬКО там: каталог сессии берётся из `sessions.list()`,
  прогоняется через `realpath` и проверяется на вхождение в whitelist `roots`
  (пустой `roots` → не разрешено ничего, fail-closed); `subdir` резолвится тем же
  способом относительно уже проверенного корня. В `startRun` уходят `root` (корень
  сессии) и `dir` (папка запуска) — оба после `realpath`.
- Права гостя: `detect|tasks|configs|status` — при `scope.files`, `run|stop` — при
  `scope.write`, чужая сессия — `session not shared`. `status` отнесён к чтению
  (в критериях он не назван).
- `AgentServer` получил опцию `socketName?: string`, `RelayLink` — `roots?: string[]`;
  обе прокинуты из `cli.ts` (`TMUX_SOCKET` / `config.sessionRoots`).
- `FrameType.Gradle` добавлен в `FRESH_AUTH_CHECK`, но НЕ в общий scope-фильтр кадров
  `handleAppFrame`: там гостю отвечают молчаливым drop, а вкладке нужен внятный
  `GradleResult{error}`. `doOpen` пускает гостя ещё и в `buildSessionName(scope.session)`.
- Веб: `Transport.gradle<T>(action, params)` в обеих реализациях + `api.gradle`.
  Тайм-аут relay-запроса — `GRADLE_TIMEOUT_MS = 190_000` (у `tasks` на агенте свой
  потолок 180 с; общий 10-секундный обрывал бы первое открытие вкладки).

### Дописано таском 04 (`web/gradle.ts`, `ui.ts`, `workspace.ts`, `routes.ts`, `main.ts`, `remote.ts`)

- `mountGradle(root, transport, session): () => void` — как заявлено (обёртка для роутера).
  Рядом — `mountGradleTab(root, transport, session): GradleTab`, где
  `GradleTab = { listPanel: HTMLElement; run(opts): Promise<GradleRunState | null>; teardown(): void }`:
  так поведение вкладки проверяется тестом, а таск 05 получает шов, не переписывая монтирование.
  `listPanel` — `section.th-gradle__list` (сейчас с `p.th-gradle__placeholder`, её и заменяет список);
  `run({tasks, args?, subdir?, force?})` сам переподключает `openTerm` после `run` (сессия
  пересоздаётся под ТЕМ ЖЕ именем — без явного detach окно осталось бы на мёртвом канале),
  чистит xterm и обновляет шапку; `phase: 'running'` без `force` — «сборка уже идёт»
  (диалог истории 16 за вызывающим); `null` — ошибка, тост уже показан.
- Кэш детекта живёт в `ui.ts`: `detectGradle(transport, session): Promise<GradleProject | null>`
  — сбой запроса ПРОБРАСЫВАЕТСЯ и не кэшируется (`null` = «обычная папка» → уход на терминал,
  ошибка → вкладка остаётся с сообщением и «Повторить») и синхронный
  `knownGradle(transport, session): GradleProject | null | undefined`. Второй нужен
  `workspace.show()`: вид смонтирован один раз, и без синхронной проверки повторный
  переход на `#/sgradle/<не-Gradle>` показал бы пустой вид вместо ухода на терминал.
- `routes.sgradleHash(session)` — без подпути (вкладка одна на сессию).
  `RemoteRoute` пополнен `{ name: 'sgradle'; session }`, `WsTab` — `'gradle'`.
- Раскладка: `localStorage['termhub.gradleSplit']` (проценты высоты списка, 15..85) и
  `['termhub.gradleExpanded']` ('1' — вывод на всю вкладку).
- Палитра ANSI в `web/gradle.ts` — копия из `term.ts`: общий вынос означал бы правку
  `term.ts`, которая этому таску запрещена.

### Для таска 05 (из ревью таска 04)

- **Таск 05 работает ВНУТРИ `packages/web/src/gradle.ts`.** Роутер по-прежнему зовёт
  `mountGradle` и получает только teardown — это менять не надо. Панель списка таск 05
  подключает к `listPanel` (`section.th-gradle__list`, сейчас с заглушкой) и к запуску
  `run({tasks, args?, subdir?, force?})`; обе точки отдаёт `mountGradleTab` — тот же
  монтаж, но с хэндлом (`GradleTab`), на котором стоят тесты вкладки.
- Маркера `void startBuild;` больше нет: шов перестал быть мёртвым кодом, когда стал
  полем хэндла (`GradleTab.run`). Снимать нечего.
- **Палитру ANSI в `gradle.ts` таск 05 не трогает.** Она продублирована из `term.ts`
  сознательно: тому таску `term.ts` был запрещён. Вынос в общий модуль — дело
  первого таска, которому `term.ts` разрешён (записано в отложенные).
- Окно вывода: тач-скролл (`enableTouchScroll`), индикатор состояния канала
  (`span.th-gradle__conn`, строки `term.reconnecting`/`term.statusClosed`), окно поиска
  строки `[termhub] gradle exit=N` — 64 КБ хвоста, берётся ПОСЛЕДНЕЕ вхождение
  (перерисовка экрана при attach иначе теряла бы итог).
- Шов тестов вкладки — `packages/web/test/gradle-tab.test.ts` (happy-dom, xterm подменён
  через `vi.mock`): attach при монтировании, переподключение после `run`, разбор строки exit,
  раскладка/персист, «Стоп», teardown, увод с не-Gradle сессии.
