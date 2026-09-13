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
- **Не коммитить/пушить без явной просьбы пользователя.** Ветка одна (`main`), PR в этом
  проекте не заводим — работа сливается прямо в неё. Remote — GitHub (`origin`), но пуш
  только по явной просьбе.

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
## TermHub

Self-hosted PWA и CLI для доступа к tmux-сессиям Codex, Claude Code и обычных TUI через LAN или E2E relay.

## Проверенные команды

```bash
npm install
npm run dev -w @termhub/web -- --host 127.0.0.1
npm test
npm run build
npx tsc -p packages/web/tsconfig.json --noEmit
```

715 тестов — замер до прогона control mode, который добавил свои файлы; актуальное число печатает сам прогон. `.worktrees` исключён в `vitest.config.ts` (копия сюиты из worktree иначе удваивает счёт), а `gradle.tmux.test.ts` идёт отдельной группой после всех. Vite стартует на loopback; если `5173` занят, фактический порт печатается в stdout.

## Структура

- `packages/protocol/src/` — кадры, E2E-крипта и общий разбор `pane_title`.
- `packages/agent/src/` — CLI/агент, HTTP/WS, tmux, relay-link и серверные операции.
- `packages/relay/src/` — zero-knowledge WS-коммутатор и раздача remote web.
- `packages/web/src/` — PWA, xterm, LAN/relay transports и session workspace.
- `packages/protocol/test/`, `packages/agent/test/`, `packages/relay/test/`, `packages/web/test/` — Vitest по пакетам.
- `docs/` — эксплуатация, безопасность и ADR; `README.md` — пользовательский обзор.

## Терминал: control mode

К сессии подключаемся через `tmux -CC attach` (control mode) с обязательным откатом на прежний `tmux attach` — этап 1 дорожной карты, решение ADR 0014.

- `packages/agent/src/control-protocol.ts` — чистый разбор строчного протокола (`ControlParser.parse`, экземпляр один на соединение: держит хвост строки и открытый блок) и кодирование ввода для `send-keys -H` (`escapeInput`); ни процессов, ни сети — на этом шве протокол проверяется без живого tmux.
- `packages/agent/src/session-link.ts` — жизненный цикл control-клиента: выбор режима, активная панель, очередь команд и ввода, снимок `capture-pane` и откат; единственное место, где поднимается и гасится pty-клиент tmux, и один слот `PtyPool` на Link (откат второй слот не тратит).
- `packages/agent/src/pty-common.ts` — границы размера терминала (20–500 × 5–300) одним экземпляром на все мосты; `bridge.ts` и `relay-link.ts` своих копий не держат и pty не спавнят, `bridge.ts` остался обвязкой WS поверх `TerminalHandle`.
- `packages/web/src/term-mode.ts` — просьба клиента (`termhub.terminalMode`) и последний названный агентом режим (`termhub.terminalModeLast`); чип `.th-termbar__mode` показывает режим из кадра, а не просьбу, и страница диагностики берёт его оттуда же — в `/api/diag` агент режим не отдаёт.
- Порядок решения: `terminalMode` в конфиге агента (`readTerminalMode`, по умолчанию `control`, значение `attach` запрещает control на всей машине) старше просьбы клиента, обе — старше живой проверки; не поднялся control — откат на `tmux attach` с причиной в логе.
- Просьба едет первым кадром открытия: в LAN это поле `mode` в первом RESIZE, через relay — `mode` в OPEN (терминал relay создаётся на OPEN, к RESIZE решение уже принято). Снимается один раз на открытие: реконнект живого канала повторяет тот же снимок, новая просьба ждёт нового открытия.
- `FrameType.TerminalState = 43`, payload `{mode?, altScreen?}` — от агента клиенту на каждое изменение; поля независимы и отбрасываются поштучно, а клиент, который кадра не знает, обязан его пропустить (ADR 0018).

## Лента агента: определитель панели

Первый из трёх этапов пути «история при полноэкранном режиме»: лента берётся не с экрана, а из транскрипта, который агент и так пишет на диск (этапы 2 и 3 — чтение обоих форматов в единую ленту и экран ленты — ещё не сделаны).

- `packages/agent/src/agent-transcript.ts` — `resolve(pane, sources?)` отвечает, какой агент работает в панели tmux и где лежит файл его беседы; интерфейса и чтения самих транскриптов здесь нет. Отказ всегда назван причиной: `no-agent`, `unknown-format`, `no-transcript` (агент есть, беседы на диске ещё нет), `lookup-failed` (посмотреть не удалось или панели уже нет).
- Три способа привязки: реестр Claude `~/.claude/sessions/<pid>.json` по полю `tmux`; открытые файлы процесса панели и потомков для Codex (`lsof`); клиент `claude attach <id>` в панели — единственное место, где читаются аргументы процесса, и берётся он, только если аргумент начало ровно одной сессии реестра.
- Порядок ответа: живой агент панели → корневой поток Codex → подключённый клиент → запись реестра, пережившая своего агента (только если панель не моложе записи, `live: false`). Порядок важен: адреса панелей переиспользуются новым сервером tmux, и мёртвая запись иначе отдала бы чужую беседу.
- `packages/agent/src/tmux-run.ts` — единственное место, где запускается tmux и распознаётся «сервера нет» (`runTmux`, `isNoServerError`, `TmuxError`); `sessions.ts` и определитель ходят через него. `doctor.ts` пока зовёт tmux своим `exec` — известное расхождение.
- Транскрипт Claude лежит в `~/.claude/projects/<cwd, где всё вне [A-Za-z0-9] заменено дефисом>/<sessionId>.jsonl`; у Codex — `~/.codex/sessions/<ГГГГ>/<ММ>/<ДД>/rollout-<ISO>-<threadId>.jsonl`, и корневой поток узнаётся по первой строке `session_meta` (нет `parent_thread_id` и `source.subagent`).
- Цепочки файлов нет намеренно (D01): продолжение и форк сессии Claude копируют прежнюю беседу в новый файл целиком, поэтому текущий файл и есть вся беседа.
- Проверено на живых данных 14.09.2026: все 12 панелей владельца разведены верно за 0,8 с вхолодную (7 Claude, 4 Codex, одна — «беседы ещё нет»).

## Решения и дорожная карта

- `docs/terminal-and-agents.ru.md` — разбор задачи «свой терминал и работа с агентами»: что измерено, шесть вердиктов и дорожная карта из девяти этапов (control mode → история → возобновление → эхо → одна полоса ввода → ответы кнопками → редактор промпта → дашборд → жесты).
- `docs/adr/0013`–`0020` — принятые решения и отвергнутые варианты: ядро xterm остаётся, `tmux -CC` вместо `attach`, mosh как транспорт отвергнут (взяты три идеи его протокола), история на устройстве с лимитом и без шифрования, рамка агента скрывается обратимо, совместимость агента и PWA — через объявление возможностей, запрет alt-screen на сокете агента принят (0019) и в тот же день отменён (0020).

## Подводные камни

- Web-сборка запускает Vite без `tsc`; после правок `packages/web/src/` обязательна отдельная команда typecheck выше.
- После правки `packages/protocol/src/frames.ts` обязателен `npm run build -w @termhub/protocol`: тесты вне пакета протокола импортируют его собранным.
- Codex preset передаёт `tui.animations=false` и `tui.terminal_title=["activity","thread-title"]` только argv нового процесса; `~/.codex/config.toml` не читается и не меняется.
- tmux-id остаётся стабильным адресом сессии; очищенный `pane_title` становится подписью таба и browser title, обновляется web-поллингом раз в 3 секунды и откатывается к tmux-id.
- Parser Claude/Codex title общий в `packages/protocol/src/session-title.ts`; web импортирует `@termhub/protocol/session-title`, чтобы корневой crypto-экспорт с libsodium не попал в LAN-бандл.
- `open-host` принимает только обычный файл внутри root после `realpath`, затем вызывает `open`/`xdg-open` отдельным argv с `shell: false`; побег, unsupported OS, spawn error и non-zero exit отклоняются.
- LAN `open-host` проходит cookie-auth и Origin-check; relay требует `scope.write` и shared-session path, а UI скрывает кнопку у read-only гостя и блокирует её на время запроса.
- При mouse tracking Codex обычный drag остаётся у TUI, а macOS Option+drag создаёт xterm selection и автокопирует его на mouseup; snapshot живёт до нового mousedown, `Ctrl+C` без selection уходит в TUI.
- Замер на живом tmux 3.7b 12.09.2026: `tmux attach` первым байтом шлёт `ESC[?1049h` и держит клиента в alt-screen до detach, поэтому локального scrollback в таком подключении нет.
- `tmux -CC` (control mode) alt-screen не шлёт и статусную строку клиенту не отдаёт; подключение стоит десятки байт без перерисовки экрана.
- Из control mode ввод идёт через `send-keys -H`, размер окна — `refresh-client -C` (держится после ухода клиента), история панели — `capture-pane -p -e -S -`, около 89 байт на строку.
- В `%output` экранированы только управляющие байты и слэш — тремя восьмеричными цифрами; битую последовательность парсер пропускает как есть: терять строку вывода хуже, а писать в лог из чистого модуля некуда.
- `%end`/`%error` закрывают блок только при совпадении номера команды — тело `capture-pane` само может начинаться с `%`; CR перед LF парсер срезает (его ставит терминальный драйвер pty).
- Пределы разборщика: строка тела свыше 1 МиБ и блок без `%end` за 100 000 строк бракуются событием `error` с номером этого блока — ждущая команда обязана быть отвергнута, а номер засчитан занятым, иначе сопоставление ответов сдвинется навсегда.
- Порядок «снимок, затем поток»: control mode экран не перерисовывает, поэтому живой вывод придерживается до конца `capture-pane`; придержание отпускают мегабайт вывода или 3 секунды, и опоздавший после этого снимок на экран уже не идёт — историю до подключения пользователь не увидит.
- Готовность control mode ждут 2 секунды, но срок заводится заново, пока протокол отвечает уведомлениями, — до общего предела 10 секунд от открытия: иначе откат сработал бы на живом control mode, где ещё просто нет номера первого блока.
- После отката служебные команды слать НЕКУДА: у attach-клиента stdin — это клавиатура пользователя, и `refresh-client -C …` уйдёт в сессию текстом.
- Альтернативный экран считается по потоку активной панели (отдельного уведомления tmux не шлёт) и узнаётся ровно по `ESC[?1049h`/`ESC[?1049l`; вариант с параметрами не распознаётся, начальное состояние даёт `alternate_on` в ответе `display-message`.
- Второй alt-screen приходит от приложения в панели, а не от tmux. Codex работает inline; **работающий Claude Code уходит в alt-screen** — прежний замер делался на свежем процессе и был неверен (проверено на живых сессиях: 7 панелей из 12, все Claude 2.1.259+). Значит в сессиях Claude истории нет и листать нечего: горит пометка «Полноэкранное приложение». Запрет `alternate-screen off` на сокете агента это чинил, но отменён в тот же день (ADR 0019 → ADR 0020) — без alt-screen рамка ввода Claude становится частью потока и уезжает при листании. Опцию агент НЕ трогает: механики в коде нет, возвращать её без этапа 5 (своя строка ввода) не на что.
- Реестр Claude описывает не только панели: у фоновой сессии (`kind: "bg"`) поля `tmux` нет вовсе, и найти её можно только по клиенту `claude attach <id>` в панели. Запись живёт дольше своего процесса, а `procStart` в ней записан в UTC, тогда как `ps` печатает локальное время.
- Обход открытых файлов (`lsof`) на дюжине панелей стоит 0,05–1,5 с на панель вхолодную и 0,05–0,18 с повторно (замер 14.09.2026 на нагруженной машине) — отсюда кэш на панель и срок 5 с.
- Красное не от своих правок: `packages/agent/test/gradle.tmux.test.ts` (8 из 13, гоняет живые Gradle и tmux, около трёх минут), два плавающих по таймауту теста в `packages/agent/test/vcs.git.test.ts`, один тест `packages/agent/test/server.test.ts` упирается в лимит 429 при параллельном прогоне.

## Как здесь работает Autopilot

Часть работы ведётся навыком `/autopilot`. Требования, спецификация и таски —
в `.autopilot/<фича>/`. Прогресс — `.autopilot/dashboard.html`. Правило:
требование из `manifest.md` может снять только пользователь.

Если сборка прервалась — скажи «продолжи автопилот»: состояние поднимется
из `.autopilot/state.js`, переспрашивать ничего не нужно.
<!-- autopilot:end -->
