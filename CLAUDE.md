# CLAUDE.md

Инструкции для работы с кодом **TermHub**. Прочитай перед любыми правками.
Общение — на русском.

## Что это

TermHub даёт доступ к терминальным (tmux) сессиям Mac с телефона/браузера.
Два режима: **LAN** (PWA + пароль, прямое WS-подключение к агенту) и **remote**
(тонкий zero-knowledge relay + E2E-крипта, пейринг по одноразовому коду) плюс
CLI-клиент «ssh через relay».

Полный обзор — `README.md`; безопасность — `docs/security.md`; удалённый доступ —
`docs/remote.md`. Статус — `0.1.0` alpha.

## Монорепо (npm workspaces, `packages/*`)

| Пакет            | Что внутри |
|------------------|------------|
| `@termhub/protocol` | Фундамент: фрейм-кодек (`frames.ts`), E2E-крипта на libsodium (`crypto.ts`), base64 (`b64.ts`). Зависимость всех остальных. |
| `@termhub/agent` | Node-процесс на хосте (macOS/Linux) + CLI `termhub`. HTTP/WS-сервер (`server.ts`+`auth.ts`), обёртка tmux (`sessions.ts`), мост pty↔tmux↔WS (`bridge.ts`), web-push (`push.ts`), автозапуск LaunchAgent/systemd (`service.ts`), конфиг/setup (`config.ts`/`setup.ts`/`paths.ts`), remote-сторона (`relay-link.ts`/`share.ts`), CLI-клиент (`connect-cmd.ts`/`pair-cmd.ts`/`client-store.ts`/`devices-cmd.ts`), роутер команд (`cli.ts`). |
| `@termhub/relay` | Zero-knowledge коммутатор (VPS, Docker): `index.ts`+`rooms.ts`, раздача статики `static.ts`, точка входа `main.ts`. |
| `@termhub/web`   | PWA (vite + vanilla TS, xterm.js). Транспорт-абстракция `transport.ts`/`relay-transport.ts`, экраны `dashboard.ts`/`term.ts`/`pairing.ts`, SW `sw.ts`, крипта-в-браузере `keys.ts`/`remote.ts`. Собирается в `packages/agent/static` (раздаётся агентом). |

Технологии: Node ≥ 22, TypeScript strict (ESM везде), `ws`, `node-pty`,
`libsodium-wrappers-sumo`, `web-push`, vite, `@xterm/*`, vitest.

## Команды

```bash
npm install            # + postinstall: chmod +x на spawn-helper node-pty (иначе pty не спавнится)
npm run build          # tsc по всем пакетам + vite-сборка web → packages/agent/static
npx vitest run         # все тесты (401 шт.)
npx vitest run packages/agent/test/sessions.unit.test.ts   # один файл
npm run build -w @termhub/web        # только web-бандл
node packages/agent/bin/termhub.js <команда>   # запуск CLI из исходников после build

# CLI пользователя (после npm run build):
npx termhub setup      # интерактивно: пароль, порт, корни сессий, relay, VAPID, tmux/zsh
npx termhub start      # поднять агента (LAN + relay, если задан relayUrl)
npx termhub share      # одноразовый код пейринга (+ QR) для нового устройства
npx termhub connect|pair|devices|revoke|service   # см. cli.ts
```

## Критические знания (иначе не вывести из кода)

1. **tmux — обязательный фундамент.** К обычной сессии терминала IDE снаружи
   не подключиться (pty принадлежит IDE). Рабочие сессии запускаются внутри
   tmux (`setup` заводит алиас `tm`), агент делает `tmux attach`. Без tmux
   продукт не работает.

2. **`packages/{agent,relay}/static` — сборочный артефакт (в `.gitignore`).**
   Тесты гоняются по `src` без сборки. Порядок `npm run build && npx vitest run`
   раньше ломал тест-заглушку — теперь тест изолирован (передаёт пустой
   `staticDir`), но **держи дерево чистым перед прогоном**: если сомневаешься,
   `rm -rf packages/{agent,relay}/static` перед `npx vitest run`.

3. **Крипто-роли фиксированы:** агент = `server`, клиенты (web/CLI) = `client`
   в `sessionKeys`. Хендшейк: plaintext `hello{edPub}` → проверка fingerprint ∈
   authorized → `hello-ok{header, nonce}` → `hello-fin{header, sig}` → secretstream.
   `sig` — подпись транскрипта (`handshakeTranscript` в protocol/crypto.ts) свежего
   челленджа обоими header'ами: без неё агент в streaming НЕ пускает, и это
   единственное, что защищает от переигрывания записанной сессии недоверенным relay.
   Роли и подпись web/CLI/agent должны оставаться зеркальными — при правке хендшейка
   меняй все три стороны согласованно и гоняй `e2e.full.test.ts`.

4. **tmux в тестах — только изолированный сокет** `-L termhub-test-<uniq>` +
   `kill-server` в teardown. Никогда не трогай дефолтный tmux-сервер. Все вызовы
   tmux — через `execFile` без shell (анти-RCE); имена/каталоги валидируются
   (`^[\w.-]{1,40}$`, whitelist корней, пресеты команд).

4a. **В проде рабочие сессии живут на выделенном сокете** `-L termhub`
   (`config.TMUX_SOCKET`) — чтобы случайный `tmux kill-server` (без `-L`) не
   сносил рабочие сессии. Имя сокета — единый источник: `cli.ts` прокидывает
   `TMUX_SOCKET` в `SessionService`/`wireTerminalWs`/`RelayLink`, а `setup`
   печёт его в `tm`/`tml` (`-L termhub …`). Меняешь имя — согласуй обе стороны.

5. **Если pty/tmux не спавнится в песочнице** (posix_spawn/EPERM) — перезапусти
   команду тестов с `dangerouslyDisableSandbox: true` (для локального дев-окружения).

6. **libsodium не должен попадать в LAN-бандл.** Крипта грузится ленивым
   `import('./remote')` только в relay-режиме. Проверка: в собранном
   `packages/agent/static/assets/main-*.js` не должно быть `libsodium`/`crypto_kx`
   (грепом). Фрейм-кодек тяни из `@termhub/protocol/frames` (без крипты).

## Стиль и правила

- TypeScript strict, ESM, отступы 2 пробела. Комментарии — по-русски и только
  там, где код не самоочевиден.
- UI-строки веба — только через i18n (`i18n.ts`), оба словаря ru+en с
  идентичным набором ключей (проверяется тестом).
- Секретные файлы (`~/.termhub/*.json`) — mode `0600`, каталог `0700`.
- README и `CONTRIBUTING` — двуязычные: `*.md` (английский, основной) + `*.ru.md`
  (русский); при правке держи обе версии синхронными. Доки в `docs/` — на русском.
- **Не коммитить/пушить без явной просьбы пользователя.** Ветка одна (`main`),
  remote не настроен.

## Прежде чем сказать «готово»

`npx vitest run` зелёный на чистом дереве, при правке remote — прогнать
`packages/agent/test/e2e.full.test.ts` (живой E2E агент↔relay↔клиент).

**Деплой обязателен при любом изменении.** Цикл: изменил → проверил (тесты/сборка)
→ **задеплоил relay**. Процедура (см. [[relay-vps-deploy]]): `npm run build` →
`rsync … root@203.0.113.10:/root/termhub-src/` → на сервере
`docker build -t termhub-relay:latest -f packages/relay/Dockerfile .` →
`docker compose up -d` → проверить `curl --resolve relay.example.com:9443:203.0.113.10`.
Правка агента (`packages/agent/src`) — ещё и рестарт локального LaunchAgent
(`launchctl kickstart -k gui/$(id -u)/dev.termhub.agent`); web-only — только пересборка
(агент раздаёт static с диска). **web НЕ типизируется сборкой** (`vite build` без tsc) —
после правок web гоняй `npx tsc -p packages/web/tsconfig.json --noEmit`, иначе висячие
ссылки (типа удалённой переменной) проскочат в рантайм.

Примечание: `packages/web/src/relay-transport.ts` даёт предсуществующую tsc-придирку
(Uint8Array/BlobPart) — не блокер, рантайму безразлично.

<!-- autopilot:start -->
## Как здесь работает Autopilot

Часть работы ведётся навыком `/autopilot`. Требования, спецификация и таски —
в `.autopilot/<фича>/`. Прогресс — `.autopilot/dashboard.html`. Правило:
требование из `manifest.md` может снять только пользователь.

Если сборка прервалась — скажи «продолжи автопилот»: состояние поднимется
из `.autopilot/state.js`, переспрашивать ничего не нужно.

## Вкладка Gradle (4-й таб сессии)

Кто чем владеет:

- `packages/agent/src/gradle.ts` — детект проекта, `tasks --all` с кэшем, разбор
  XML-конфигураций запуска IDEA, запуск/стоп/статус сборки, выбор JDK проекта.
- `packages/agent/src/gradle-action.ts` — единственный обработчик экшенов
  (`detect|tasks|configs|run|stop|status`) на оба транспорта: здесь резолв корня
  сессии через `realpath` + whitelist `config.sessionRoots` и права гостя
  (`scope.files` на чтение, `scope.write` на `run`/`stop`).
  **`gradle.ts` папку НЕ проверяет — принимает на веру**, вся защита пути тут.
- Транспорты: `server.ts` → `POST /api/gradle`; `relay-link.ts` → кадры
  `FrameType.Gradle`/`GradleResult`; веб → `Transport.gradle(action, params)`
  (`transport.ts` + `relay-transport.ts`, обе реализации).
- Веб: `packages/web/src/gradle.ts` — экран (`mountGradle` для роутера,
  `mountGradleTab` — тот же монтаж с хэндлом `{listPanel, run, recheck, teardown}` для тестов),
  `gradle-view.ts` — чистые рендеры, группировка и «недавние».
- Четвёртый таб рисует `renderHoloBar` (`web/src/ui.ts`) асинхронно, после
  `detectGradle` (кэш детекта на сессию — там же, плюс синхронный `knownGradle`,
  которым `workspace.ts` уводит с не-Gradle сессии).

Подводные камни (из кода не выводятся):

- Сборка идёт в **отдельной** tmux-сессии `_gradle_<имя>_<6 hex>` на том же сокете;
  `SessionService.list()` прячет их по префиксу (`isBuildSessionName`). Забытые
  сборочные сессии видно только напрямую: `tmux -L termhub ls`.
- **Каждый запуск пересоздаёт эту сессию** (`kill-session` + `new-session`), чтобы на
  экране не остался прошлый вывод, — приаттаченный веб-терминал в этот момент
  отваливается, и `GradleTab.run` обязан переподключить `openTerm` ПОСЛЕ ответа.
- Код выхода наружу не отдаётся: признак конца — строка `[termhub] gradle exit=N`
  в выводе. Веб берёт ПОСЛЕДНЕЕ вхождение в 64 КБ хвоста (перерисовка экрана при
  attach иначе показала бы итог прошлой сборки).
- `runStatus` первые 5 с после старта (`START_GRACE_MS`) отдаёт `running` всегда:
  login-оболочка не мгновенно доходит до команды. Следствие — мгновенно упавшая
  сборка ~5 с числится идущей, и повторный запуск без `force` в это окно отказывает.
- Второй «Стоп» подряд убивает сборочную сессию (первый шлёт только `C-c`); счётчик
  живёт в памяти агента — после рестарта первый «Стоп» снова только `C-c`.
- Кэш списка тасок инвалидируется по mtime build-файлов **корня** (+ выбранный JDK):
  правка `app/build.gradle.kts` его не сбросит, актуализация — кнопкой «Обновить»
  (`refresh: true`). Автообновления списка нет и не обещай.
- JDK проекта ищется как в IDEA: `<проект>/gradle.properties` →
  `${GRADLE_USER_HOME:-~/.gradle}/gradle.properties` (`org.gradle.java.home`) →
  `<проект>/.gradle/config.properties` (`java.home`). **`.idea/gradle.xml` не парсится**
  — при именованном SDK из IDEA молча уходим на JDK login-оболочки; симптом
  «в IDEA собирается, а тут нет».
- Путь к JDK никогда не попадает в строку команды: он едет `env` у `execFile` и
  `-e JAVA_HOME=… -e TERMHUB_JAVA_HOME=…` у `tmux new-session`. Константный
  `export JAVA_HOME="$TERMHUB_JAVA_HOME"; ` перед командой — не лишний: `~/.zshrc`
  читается tmux уже после старта оболочки и иначе перебивает `-e` (проверено вживую).
  `tmux new-session -e` требует tmux ≥ 3.0; аргументы добавляются, только если JDK найден.
- **JDK намеренно может лежать вне корней сессии** (живой случай — JBR внутри
  `/Applications/Android Studio.app/…`); проверку whitelist к пути JDK не добавлять.
- Имена тасок и аргументы **отвергаются** регуляркой, а не экранируются
  (`checkTaskName`/`checkArgs`, `MAX_ARGS`); строки команд в `gradle.ts` константны.
- `FrameType.Gradle` есть в `FRESH_AUTH_CHECK`, но сознательно НЕ в общем scope-фильтре
  `handleAppFrame`: гостю нужен внятный `GradleResult{error}`, а не молчаливый drop.
  `doOpen` дополнительно пускает гостя в `buildSessionName(scope.session)` — иначе
  вкладка не покажет ему вывод сборки.
- Тайм-аут gradle-запроса через relay — `GRADLE_TIMEOUT_MS = 190_000` (у `tasks` на
  агенте свой потолок 180 с): общий 10-секундный обрывал бы первое открытие вкладки.
- Раскладка и «недавние» — в localStorage: `termhub.gradleSplit`,
  `termhub.gradleExpanded`, `termhub.gradleRecent.<session>`.
- `grep` по `packages/agent/src/gradle.ts` без `-a` молча не находит ничего: в `stopKey` разделитель
  ключа — литеральный NUL (`${socketName}\0${name}`), и для grep/`file` файл бинарный.

Тесты только этой вкладки (4 файла: `gradle.unit`/`gradle.tmux` в agent,
`gradle-view`/`gradle-tab` в web):

```bash
npx vitest run gradle
```

`gradle.tmux.test.ts` поднимает настоящий tmux на изолированном сокете и идёт ~27 с —
это нормально, не таймаут.

## Имена сессий и экран сессии

Кто чем владеет:

- `packages/agent/src/sessions.ts` — `SessionService.create({name, root, dir, preset, autoName?})
  → {name}`: при `autoName: true` занятое имя нумерует `pickFreeName(base, taken)` — `MyProject` →
  `MyProject1` → `MyProject2` (`v2` → `v21`); занятые — сырой `list-sessions -F '#{session_name}'`
  («no server» = пусто); гонка «duplicate session» переигрывается 5 раз. Без `autoName` — отказ tmux наружу.
- Фактическое имя едет клиенту: `server.ts` `POST /api/sessions` → `{ok: true, session}`,
  `relay-link.ts` `doCreate` → `CreateOk{session}`. Веб: `api.ts` `CreateSessionInput.autoName?`/
  `CreateSessionResult.session?`; `Transport.create(req) → Promise<string>` (обе реализации)
  резолвится именем из ответа, без поля — запрошенным; `routes.termHash(name)` — единственный сборщик `#/term/<name>`.
- `ui.ts` `openModal(builder(close))`: `close()` → `history.back()`, `close(next: string)` →
  `cleanup()` + `location.replace(next)`, нестроковое (Event) — обычное закрытие. `dashboard.ts`
  `openCreateModal(transport)` без колбэка: пустое поле имени → `autoName: true` (имя из каталога,
  `sanitizeSessionName`: `my.app` → `my_app`), введённое — без признака; потом `close(termHash(created))`.
- `packages/agent/src/setup.ts` — `tmFunction(socket)`/`TM_FUNCTION`: `tm` без аргумента —
  `basename "$PWD"` + та же нумерация на POSIX sh (`grep -qxF` по снимку `list-sessions`) и
  `new -s`; `tm <имя>` — `new -As` (так зовёт и `tml`). `upgradeTmFunction(rc)` заменяет старую
  однострочную `tm() { tmux … }` только ПОСЛЕ маркера `# termhub`, иначе `null` и печать определения.
- `packages/web/src/term.ts` — `mountTerminal(root, session, transport) → TerminalHandle{focus, teardown}`
  (`openTerminal` — обёртка для `remote.ts`), фокус при монтаже, очередь ввода до `connected`
  (`INPUT_QUEUE_MAX` = 8 КБ), Enter через чистую `enterAction(e, enterSends) →
  'send'|'newline'|'suppress'|'pass'` из `term-keys.ts` (тумблер — localStorage `termhub.enterSends`,
  `'0'` = выкл); `workspace.ts` `show('term')` зовёт `focus()`; `tabs.ts` гасит `mousedown` на `.th-tab__btn`.

Подводные камни (из кода не выводятся):

- **`-t "=имя"` в tmux не защищает от точки/двоеточия:** для `=foo.bar` tmux ищет панель `bar`
  в сессии `foo` (живой tmux 3.7b) — `has-session -t =v1.1` отвечает «нет» на живую `v1.1`.
  Занятость проверяй только точным сравнением с `list-sessions -F '#{session_name}'` (так делают
  `tm` и `create` с `autoName`); `kill-session -t "=$1"` в `tml`/`tmc` (`_th_kill`) этим ещё страдает.
- Две регулярки имён: создать/убить/переименовать агент даёт только по `NAME_RE` (`/^[\w-]{1,40}$/`,
  без точки), ссылаться на существующую (WS-апгрейд, гостевой scope) — `isExistingSessionName`, шире.
  `tm` в папке `v1.1` такую сессию заведёт: дашборд покажет и откроет, «закрыть»/«переименовать» откажут.
- `tm` без аргумента больше НЕ присоединяется к сессии папки — всегда следующая по номеру;
  вернуться — `tml` или `tm <имя>`. Ручное имя в модалке не нумеруется: коллизия — ошибка.
- `history.back()` модалки — асинхронная траверса, синхронная смена `location.hash` её обгоняет:
  браузер пушит маршрут, потом исполняет back и возвращается на запись модалки со старым URL —
  роутер сносит свежесмонтированный экран (баг R11). Уход из модалки — только `close(termHash(…))`,
  никогда `close(); location.hash = …`. Закрыли модалку до ответа — сессия создастся, перехода не будет.
- Ветка `newline` обработчика Enter ОБЯЗАНА `preventDefault()` + `return false`: на голый `false`
  xterm выходит из `_keyDown` до своего cancel, браузер рождает `keypress`, и `_keyPress` шлёт
  второй `\r` — перенос и отправка за одно нажатие. `keypress Enter` гасится всегда (`suppress`).
- Очередь ввода: транспорт молча роняет байты до подключения (LAN — WS не OPEN, relay — до `OpenOk`),
  а фокус стоит с монтажа. Накопленное уходит строго ПОСЛЕ `sendResize()` («первый кадр — RESIZE», иначе
  агент не спавнит pty); не влезающий в 8 КБ чанк отбрасывается целиком (резать — рвать UTF-8); `reconnecting` копит заново.
- Фокус: `term.focus()` при монтаже на пути workspace попадает в скрытый элемент (без `is-active`) и
  игнорируется — рабочий даёт `show('term')` после показа и только при переходе (`wasActive`): повтор события
  маршрута не крадёт фокус у compose-бара. Тумблер ⌨ — режим поля (`inputmode=none`), не условие фокуса.
- `sw.ts` не может импортировать `routes` (классический воркер: rollup вынес бы общий чанк и оставил
  `import`, на котором SW падает) — формат `#/term/` там продублирован дословно; меняешь `termHash` — меняй и `sw.ts`.
- Тесты агента в `tsc`-сборку не входят (`packages/agent/tsconfig.json`: `include: ["src"]`), веб-тесты
  в `tsc -p packages/web/tsconfig.json` входят. `create-modal.test.ts`: в happy-dom `History.back()`
  синхронный — гонка R11 не воспроизводится, тест утверждает только механизм (`location.replace` вызван, back — нет).

Тесты этой области (фильтры — подстроки имён файлов):

```bash
npx vitest run sessions tm-shell setup create-modal term-keys term-input-queue workspace
```

Живые: `sessions.tmux` — tmux на изолированном сокете, `tm-shell` — `tm` под sh/bash/zsh с подложным
`tmux` в PATH; остальные — стаб `execFile` / happy-dom. Хелпер `packages/web/test/term-harness.ts`: поддельный
xterm (`FakeTerminal`: `type()`, `key()`, `focusCalls`) и транспорт с журналом кадров (`termTransport()`), `@xterm/xterm` — через `vi.mock`.

<!-- autopilot:end -->
