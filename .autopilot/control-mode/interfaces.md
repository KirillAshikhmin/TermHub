# Границы и правила прогона

Этот файл читает каждый исполнитель перед тем, как что-либо написать.

## Что строит этот прогон

Этап 1 дорожной карты: подключение к сессии через `tmux -CC attach` (control mode) вместо
`tmux attach`, с обязательным откатом на прежний способ. Архитектурные решения приняты
раньше и здесь не переоткрываются: `docs/adr/0013`–`0018`, обзор — `docs/terminal-and-agents.ru.md`.

## Правила проекта, которые нельзя вывести из кода

- TypeScript strict, ESM везде, отступы 2 пробела. Комментарии по-русски и только там, где
  код не самоочевиден.
- Вызовы tmux — **только через `execFile` без shell** (анти-RCE). Имена сессий и каталоги
  валидируются существующими правилами в `sessions.ts`.
- Тесты tmux — **только на изолированном сокете** `-L termhub-test-<uniq>` с `kill-server`
  в teardown. Дефолтный tmux-сервер не трогать никогда.
- Прод-сессии живут на сокете `-L termhub` (`config.TMUX_SOCKET`); имя сокета прокидывается
  из `cli.ts` в `SessionService`, `wireTerminalWs` и `RelayLink` — менять согласованно.
- Крипто-роли и хендшейк relay не трогать. При правках `relay-link.ts` гонять
  `packages/agent/test/e2e.full.test.ts`.
- libsodium не должен попадать в LAN-бандл: из веба тянуть `@termhub/protocol/frames`, а не
  корневой экспорт.
- UI-строки веба — только через `i18n.ts`, оба словаря ru+en с одинаковым набором ключей
  (это проверяется тестом).
- `packages/{agent,relay}/static` — сборочный артефакт в `.gitignore`. Тесты гоняются по
  `src` без сборки; перед прогоном держи дерево чистым.
- Web не типизируется сборкой: после правок `packages/web/src/` обязательно
  `npx tsc -p packages/web/tsconfig.json --noEmit`.
- Не хватает зависимости или решения — возвращай `BLOCKED`, не ставь пакеты сам.
- Не коммить: коммит делает оркестратор.

## Команды

```bash
npx vitest run                                   # весь прогон, сейчас 715 тестов
npx vitest run packages/agent/test/bridge.unit.test.ts   # один файл
npm run build                                    # tsc по пакетам + vite-сборка веба
npx tsc -p packages/web/tsconfig.json --noEmit   # типы веба
```

Если pty не спавнится в песочнице (posix_spawn/EPERM) — перезапусти тесты с
`dangerouslyDisableSandbox: true`.

## Измерено на живом tmux 3.7b — опираться на это, не перепроверять

| Что | Результат |
|---|---|
| `tmux attach` | первым байтом `ESC[?1049h`, alt-screen до detach |
| `tmux -CC attach` | alt-screen не шлёт, статусную строку не отдаёт; подключение — десятки байт |
| Поток control mode | строчный: `%begin <ts> <id> <flags>` … `%end <ts> <id> <flags>`, `%output %<pane> <байты в октальном экранировании>`, `%session-changed`, `%layout-change`, `%window-add`, `%window-renamed`, `%session-window-changed` |
| **Начало потока `-CC`** | первая строка приходит с DCS-обёрткой iTerm2, склеенной с первым `%begin`: `\x1bP1000p%begin <ts> <id> <flags>`. У одиночного `-C` обёртки нет. Проверено на живом tmux 3.7b 12.09.2026; пропущено в первой редакции этих замеров, из-за чего control mode не поднимался ни разу |
| Команда через stdin control-клиента | ответ приходит блоком `%begin`/`%end` с тем же `<id>`; по нему сопоставляются ответы |
| `display-message -p "#{pane_id} #{window_id} #{alternate_on}"` | отвечает `%0 @0 0` — активная панель, окно и признак alt-screen одной командой |
| `capture-pane -p -e -S -N` через control-клиента | работает, содержимое внутри блока; отдельный процесс tmux не нужен |
| Ввод байтов | `send-keys -t <target> -H <hex…>` — работает |
| Размер окна | `refresh-client -C 90x28` и `-C 90,28` — оба принимаются |
| История панели | `capture-pane -p -e -S -` до `history-limit`; проект ставит 50 000 |
| Второй alt-screen | `vim` → `alternate_on=1`; Claude Code 2.1.269 и Codex 0.153.4 → `0` |
| Флаг Codex | `--no-alt-screen` существует: «Runs the TUI in inline mode, preserving terminal scrollback history» |
| Версии | tmux 3.7b, Node 22, xterm.js 6.0.0, vitest 3 |

## Границы, решённые в спецификации

| Модуль | Владеет | Выставляет | Прячет |
|---|---|---|---|
| `control-protocol` | разбором строк control mode и кодированием ввода | `parse(chunk) -> Event[]` (события `output`, `block`, `notification`, `error`), `escapeInput(bytes) -> string` | октальное экранирование, склейку кусков потока, состояние блоков |
| `session-link` | жизненным циклом control-клиента, выбором режима, активной панелью, очередью команд | `open(session, opts) -> Link`; `Link.write(bytes)`, `Link.resize(cols, rows)`, `Link.snapshot(lines)`, `Link.pause()`, `Link.resume()`, `Link.dispose()`, `Link.mode` | спавн процесса, откат на attach, сопоставление ответов по номеру |
| `bridge` | обвязкой WebSocket поверх `TerminalHandle` | нынешние `attachTerminal` и `wireTerminalWs`, контракт `TerminalHandle` + `snapshot` и сигнал смены alt-screen | какой дорогой добыты байты |

**Швы для тестов — два:** `control-protocol` целиком (чистые функции, без tmux и без DOM) и
`session-link` на поддельном процессе. Образец стиля моков — `packages/agent/test/bridge.unit.test.ts`
(там `vi.mock('node-pty')` и управляемый фейк pty).

## Что существует сегодня и не должно сломаться

- `attachTerminal` в `packages/agent/src/bridge.ts` — единственное место спавна `tmux attach`.
  Её используют оба пути: LAN (`wireTerminalWs` из `cli.ts`) и relay (`relay-link.ts`), а CLI
  `termhub connect` ходит через relay-кадры к тому же коду.
- Контракт `TerminalHandle`: `write`, `resize`, `pause`, `resume`, `dispose`. `pause`/`resume` —
  обратное давление при переполнении буфера WebSocket (пороги 1 МиБ и 256 КиБ).
- Скан BEL — стейт-машина, отличающая звонок от терминатора OSC. Работает по байтам вывода.
- Первый кадр от клиента обязан быть RESIZE: только на нём агент спавнит pty.
- `PtyPool` — общий лимит живых терминалов на LAN и relay, 64 штуки.
- Read-only гость relay: ввод запрещён и на клиенте, и на агенте.
- Тач-скролл веба выбирает путь по активному буферу xterm (`normal` или `alternate`).
- Заголовки сессий Claude и Codex, пресеты запуска, индикатор активности и звонок.

## Что решено и не подлежит пересмотру

1. Ядро xterm.js остаётся, меняется способ подключения (ADR 0013, 0014).
2. Откат на `tmux attach` обязателен, решение принимается один раз при подключении и пишет
   причину в лог (ADR 0014).
3. Управление режимом: настройка в конфиге агента плюс переключатель в интерфейсе плюс
   автоматический откат (ответ пользователя на вопрос 1 этого прогона).
4. Новый кадр состояния терминала совместим по правилу объявления возможностей (ADR 0018);
   клиент, не знающий кадр, обязан его пропустить.

## Что построили завершённые таски

_(пусто — заполняется по мере сдачи)_

## Из таска 01 — разбор протокола

- `packages/agent/src/control-protocol.ts`:
  - `class ControlParser { parse(chunk: Uint8Array): ControlEvent[] }` — **экземпляр один на
    соединение**: держит между вызовами хвост незавершённой строки и открытый блок.
  - `escapeInput(bytes: Uint8Array): string` — готовые аргументы `send-keys -H` вида
    `6c 73 20 0d`; пустой ввод даёт пустую строку.
  - `type ControlEvent` = `{type:'output', pane: string /* '%0' */, data: Uint8Array}` —
    данные уже разэкранированы; `{type:'block', id: number, lines: string[]}`;
    `{type:'error', id: number, lines: string[]}`;
    `{type:'notification', name: string /* без ведущего % */, args: string[]}`.
- Поведение, которое таск 02 обязан учитывать:
  - `%end`/`%error` закрывают блок только при совпадении номера команды: тело `capture-pane`
    само может начинаться с `%`.
  - Парсер срезает CR перед LF: node-pty отдаёт поток через драйвер терминала с ONLCR.
  - Тело блока декодируется в строки UTF-8; байтами остаётся только `%output`.
  - Битая восьмеричная последовательность проходит как есть, строка не отбрасывается:
    в чистом модуле некуда писать лог, а терять вывод хуже.
  - Событие `error` приходит не только от tmux: разборщик сам бракует блок (нет `%end` за
    100 000 строк либо строка тела длиннее 1 МиБ) и отдаёт `error` с номером этого блока и
    единственной строкой `control block discarded: …`. Ждущая команда обязана быть
    отвергнута, а номер — засчитан как занятый.
  - После отката на `tmux attach` служебные команды слать НЕКУДА: у attach-клиента stdin —
    это клавиатура пользователя, и `refresh-client -C …` уйдёт в его сессию текстом.

## Состояние тестов на момент таска 01 — важно для всех

- В репозитории зарегистрирован git-worktree `.worktrees/pty-lifecycle-fix` (ветка
  `fix/pty-lifecycle`). Его копия сюиты попадает в прогон, поэтому `npx vitest run` считает
  ~1465 тестов вместо 715. Таск 00 исключает этот каталог из прогона.
- `packages/agent/test/bridge.unit.test.ts` приехал красным из main (коммит 77a1535): тест
  «закрытие WS освобождает слот PTY» зовёт `second.isKilled()`, а фейк отдаёт `isDestroyed()`.
  Чинит таск 00.

## Из таска 02 — жизненный цикл control-клиента

`packages/agent/src/session-link.ts`:

- `open(session: string, opts: SessionLinkOptions): Link` — спавн синхронный, поэтому
  «нет слота пула» и «нет tmux» вылетают исключением прямо из `open`, как сегодня у
  `attachTerminal`.
- `SessionLinkOptions { socketName?, cols, rows, configMode?: 'control'|'attach',
  requestedMode?: string, onData(b: Uint8Array), onExit(), onAltScreen?(active: boolean),
  ptyPool?: PtyPool, log?(m: string) }`.
- `Link { mode: TerminalMode | undefined; ready: Promise<TerminalMode>; write(b);
  resize(c, r); snapshot(lines = 200): Promise<Uint8Array>; pause(); resume(); dispose() }`.
- Что обязан знать таск 03:
  - `mode` до решения равен `undefined`; окончательный ответ даёт `ready`.
  - `ready` и `snapshot` никогда не отвергаются: отказ превращается в пустой снимок и
    строку в лог.
  - Вывод глушится только на время `capture-pane`, поэтому снимок берут сразу после `ready`.
  - Вышедший pty повторно не уничтожается — этого требует существующий тест `bridge.unit`.
  - Один слот `PtyPool` на `Link`; откат не тратит второй слот.
  - Пометка альтернативного экрана узнаёт ровно `ESC[?1049h` и `ESC[?1049l` — форму,
    которая измерена; вариант с параметрами не распознаётся.

## Предсуществующая краснота в репозитории — не трогать, не приписывать себе

Проверено прогоном на дереве, где из изменений только новые файлы этого прогона:

- `packages/agent/test/gradle.tmux.test.ts` — 8 из 13 падают и в одиночном прогоне.
  Тест гоняет настоящие Gradle и tmux, занимает около трёх минут.
- `packages/agent/test/vcs.git.test.ts` — 2 теста плавают по таймауту 5 с.
- `packages/agent/test/server.test.ts` — 1 тест упирается в лимит 429 при параллельном прогоне.

Ни один из них не импортирует модули этого прогона. Мерять себя по ним нельзя; мерять надо
своим файлом плюс отсутствием новых падений.

## Из таска 03 — встраивание в агента

- **Новый кадр.** `FrameType.TerminalState = 43`, payload `{ mode?: 'control'|'attach';
  altScreen?: boolean }`, типы `TerminalState` и `TerminalMode` в `@termhub/protocol`.
  Идёт от агента к клиенту при каждом изменении; поля независимы друг от друга.
- **Как клиент просит режим.** LAN — поле `mode` в первом кадре RESIZE:
  `{ cols, rows, mode?: 'attach'|'control' }`. Relay — поле `mode` в кадре OPEN:
  `{ session, mode? }`. Разница не прихоть: терминал relay создаётся на OPEN, и к RESIZE
  решение уже принято. **Вебу в таске 04 класть `mode` в OPEN для relay и в первый RESIZE
  для LAN.**
- **Контракт handle.** `TerminalHandle` += `readonly mode?: TerminalMode`,
  `snapshot?(lines?): Promise<Uint8Array>`. Опции `attachTerminal` += `configMode`,
  `requestedMode`, `onMode(mode)`, `onAltScreen(active)`.
- **Проводка.** `wireTerminalWs({ configMode })`, `new RelayLink({ configMode })`,
  ключ конфига `terminalMode: 'control'|'attach'` и `readTerminalMode(config, log?)`.
- **Снимок приходит сам**, первым вызовом `onData`; `TerminalHandle.snapshot` и `mode`
  вызывающими пока не используются — это точка для явного обновления экрана.
- **Прежние тесты `bridge.unit` сохранены дословно**, но объявлены режимом `attach`
  (хелперы добавляют `configMode: 'attach'`), иначе они проверяли бы не тот транспорт.
  Control mode покрыт отдельным набором из восьми тестов.
- **`bridge.ts` больше не спавнит pty сам**: копии границ, зажима и гашения удалены,
  единственный экземпляр живёт в `pty-common.ts` и используется через `session-link`.
- **После правки `frames.ts` обязателен `npm run build -w @termhub/protocol`**: тесты вне
  пакета протокола импортируют его собранным.
- **Предел придержания.** Живой вывод ждёт конца снимка, но отпускается по любому из двух
  поводов: накопился мегабайт либо снимок не пришёл за три секунды. Пришедший после этого
  снимок на экран уже не идёт — истории до подключения пользователь не увидит, экран
  дорисовывает живой поток (`D05`).
- **Диагностика режима.** `termhub doctor` режим уже называет. Вторая половина требования —
  страница диагностики в вебе — принадлежит таску 04.

## Из таска 04 — веб

- `packages/web/src/term-mode.ts` — просьба и последний известный режим:
  `terminalModeRequest()`, `setTerminalModeRequest(mode)`, `otherTerminalMode(mode)`,
  `lastTerminalMode()`, `noteTerminalMode(mode)`, `terminalModeName(mode)`.
  Хранилище: `termhub.terminalMode` (просьба) и `termhub.terminalModeLast` (режим, названный
  агентом).
- `TermChannelOpts` += `mode?: TerminalMode` и `onTerminalState?(state)`; `transport.ts`
  реэкспортирует `TerminalMode` и `TerminalState`.
- `ws-frames`: `resizeFrame(cols, rows, mode?)` и `parseTerminalState(frame)` — общий разбор
  для обеих дорог, чужое значение поля отбрасывается поштучно, битый JSON даёт пустой объект.
- Интерфейс: `.th-termbar__mode` — чип-переключатель, класс `is-pending`, пока просьба ждёт
  следующего открытия; `.th-termbar__alt` — пометка альтернативного экрана.
- **Просьба снимается один раз на открытие терминала.** Реконнект живого канала повторяет тот
  же снимок просьбы; новая просьба ждёт нового открытия. Чип показывает режим, названный
  агентом, а до ответа — прочерк.
- Диагностика называет режим не из ответа агента на `/api/diag` — агент его там не отдаёт, —
  а из последнего кадра состояния плюс строка «Просьба клиента».
