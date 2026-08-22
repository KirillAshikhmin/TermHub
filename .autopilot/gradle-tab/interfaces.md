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
