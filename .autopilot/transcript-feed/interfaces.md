# Границы и правила прогона

Этот файл читает каждый исполнитель перед тем, как что-либо написать.

## Что поставляет этот прогон

Агентскую сторону ленты: чтение транскриптов Claude и Codex, приведение их к одной форме
записи, отдачу страницами по LAN и через relay, и объявление возможностей между агентом и
PWA. **Экрана ленты в этом прогоне нет** — он третий этап. Всё, что делает веб здесь, —
объявляет свои возможности и запоминает пересечение; ни одной новой кнопки.

## Правила проекта, которые нельзя вывести из кода

- Язык кода и комментариев — как в соседних файлах пакета: комментарии по-русски, имена
  и строки по-английски. Логи агента — английские.
- UI-строки веба — только через `i18n.ts`, оба словаря (ru+en) с одинаковым набором ключей;
  это проверяется тестом. В этом прогоне новых UI-строк быть не должно вовсе.
- После правки `packages/protocol/src/frames.ts` обязателен `npm run build -w @termhub/protocol`:
  тесты вне пакета протокола импортируют его собранным.
- Веб не типизируется сборкой: после правок `packages/web/src/` гонять
  `npx tsc -p packages/web/tsconfig.json --noEmit`.
- Никаких `@author`, копирайтов и подписей инструментов.
- Не хватает зависимости — возвращай `BLOCKED`, а не ставь её.
- Строки в markdown — до ~95 знаков.

## Проверки

```bash
npx vitest run packages/agent/test/<свой файл>.test.ts   # свой шов
npx vitest run packages/agent/test/                      # пакет агента
npm run build -w @termhub/agent                          # типы агента
npx tsc -p packages/web/tsconfig.json --noEmit           # типы веба
```

Предсуществующая краснота вне зоны: `gradle.tmux.test.ts` (живые Gradle и tmux, около трёх
минут), `vcs.git.test.ts` и `server.test.ts` — плавают по таймауту на нагруженной машине.
Мерить себя своим файлом.

`session-feed.tmux.test.ts` (заведён таском 06) без tmux падает намеренно, а не пропускается:
соседи используют `describe.skipIf`, и именно молча снятый шов позволил дойти до приёмки ленте,
которая не отдавалась ни по одной живой сессии.

## Границы, решённые в спецификации

Скопировано из `spec.md`, раздел «Границы и швы». Это контракт: исполнитель реализует
именно эти единицы, не изобретая своих.

| Модуль | Владеет | Выставляет | Прячет |
|---|---|---|---|
| `transcript-feed` (агент) | приведением обоих форматов к `FeedEntry` и окном чтения по курсору | `readFeed(file, agent, opts) -> FeedPage \| FeedFailure`, `parseLine(line, agent) -> FeedEntry \| null` | разбор форматов, устройство курсора, границы строк, пределы |
| `session-feed` (агент) | связкой «имя сессии → панель → файл → страница ленты» и цепочкой Codex | `sessionFeed(name, opts) -> FeedResult` | вызов `resolve`, tmux, поиск файла-родителя |
| `capabilities` (протокол) | списком имён возможностей и их пересечением | `AGENT_CAPS`, `CLIENT_CAPS`, `intersect(a, b) -> string[]` | ничего — это данные |

**Шов для тестов один: `readFeed` над подложенными файлами.** Чистый: на вход путь и курсор,
на выход страница. Живые агенты, tmux и сеть в нём не участвуют. Остальное проверяется
существующими швами проекта: `server.test.ts` для LAN-маршрута, моки транспорта в вебе — для
кадров relay.

## Форма записи ленты — общая для всех тасков

```ts
interface FeedEntry {
  id: string;      // uuid у Claude, payload.id/ordinal у Codex, иначе смещение строки
  at: number;      // epoch ms
  kind: 'human' | 'agent' | 'thinking' | 'tool' | 'note';
  text: string;
  tool?: string;   // только у kind:'tool'
  note?: 'compacted' | 'interrupted' | 'error' | 'chain';  // только у kind:'note'
  branch?: string; // ВСЕГДА ПУСТО на сегодняшних данных: 0 записей isSidechain из 83 175,
                   // беседы подагентов Claude лежат отдельными файлами …/subagents/agent-*.jsonl,
                   // которых лента не читает. Поле в контракте оставлено, но экран не должен
                   // рисовать по нему ветки — их не будет.
  truncated?: true;
  cursor?: string; // «<inode>:<offset>» этой записи — точка прыжка для экрана третьего этапа:
                   // нашёл запись поиском → показал её окрестность через around(entry.cursor).
                   // У записей страницы есть всегда; необязателен, потому что parseLine
                   // разбирает строку в отрыве от файла. Веха chain от session-feed его не несёт.
}
```

Ответ целиком — §6 спецификации. Причины отказа те же, что у определителя первого этапа,
плюс `cursor-stale`. Новых слов для старых причин не вводить.

## Что уже существует и на что опираться

- `packages/agent/src/agent-transcript.ts` — `resolve(pane, sources?)`: какой агент в панели,
  файл его беседы, `complete`, `live`, причина отказа. Не переписывать, не дублировать.
- `packages/agent/src/tmux-run.ts` — `runTmux`, `isNoServerError`: единственное место, где
  запускается tmux. Свой `execFile` для tmux не заводить.
- `packages/protocol/src/frames.ts` — номера кадров; последний занятый `TerminalState = 43`.
- `packages/agent/src/relay-link.ts` — разбор кадров и ограничения гостя (`scope`), около
  строки 690. Незнакомый кадр уже игнорируется (`default: return`).
- `packages/agent/src/server.ts` — маршруты `/api/*` под cookie-авторизацией и проверкой Origin.

## Измерено на живых данных 13–14.09.2026 — опираться, не перепроверять

| Что | Результат |
|---|---|
| Claude: типы записей | `user`, `assistant`, `system` + служебные (`attachment`, `file-history-*`, `queue-operation`, `last-prompt`, `ai-title`, `agent-name`, `mode`, `permission-mode`, `atis-latch`) |
| Claude: блоки сообщения | `text`, `thinking`, `tool_use`, `tool_result`, либо строка |
| Claude: `uuid` и `timestamp` | есть у всех 1834 записей `user`/`assistant`/`system` |
| Codex: типы записей | `session_meta`, `response_item`, `event_msg`, `token_usage_record`, `turn_context`, `world_state`, `compacted` |
| Codex: `payload.type` | `message` (role user/assistant/developer), `reasoning`, `function_call(_output)`, `custom_tool_call(_output)` |
| Codex: `timestamp` и `ordinal` | есть у каждой записи (15 500 в одном файле) |
| Codex: поля `session_meta` | `session_id`, `id`, `parent_thread_id`, `cwd`, `source`, `forked_from_id`, `subagent_history_start_ordinal` и др.; поля «продолжает вон ту беседу» нет ни в одном из 328 файлов |
| Codex: форки | `forked_from_id` у 51 вложенного потока из 248 и ни у одного из 80 корневых |
| Codex: поиск родителя | по `threadId` в имени файла `~/.codex/sessions/**` — 20 из 20 найдены |
| Размер живого транскрипта | 7,2 МБ у идущей сессии Claude — целиком не читать никогда |

## Что построили завершённые таски

### Из таска 01 — лента из двух форматов

- `packages/agent/src/transcript-feed.ts`:
  - `readFeed(file: string, agent: AgentKind, opts?: FeedOptions): Promise<FeedPage | FeedFailure>`
  - `parseLine(line: string, agent: AgentKind, offset?: number): FeedEntry | null`
  - `FeedOptions { limit?, before?, after?, around? }` — старшинство: `around`, `before`, `after`.
  - `FeedPage { ok: true; agent; entries; head; tail; bof; eof; skipped }`
  - `FeedFailure { ok: false; reason: FailureReason | 'cursor-stale'; detail }` — `FailureReason`
    импортирован из `agent-transcript.ts`, своей копии четырёх слов нет.
- Курсор — `<inode>:<offset>`. `FeedPage` — это `FeedResult` без `complete`/`live`: их приклеивает
  `sessionFeed`, беря из ответа `resolve`.
- `cursor-stale` здесь решается по inode **этого** файла. «Нет ни в цепочке» — проверка
  вызывающего: он ловит отказ и повторяет на файле-родителе.
- `note: 'chain'` в типе есть, но `readFeed` его не выдаёт: веха стыка файлов принадлежит
  `session-feed`.
- Предел текста записи — **64 КиБ** с `truncated` (D01: 8 КиБ резали 0,94 % реплик, 64 КиБ — 0,02 %).
- Замер на живых данных: хвост файла Claude 28,5 МБ — 200 записей за 37 мс; rollout Codex
  94 МБ — 9 мс. Читается окно от конца (≤ 4 МиБ), не файл целиком.
- Строку длиннее окна (4 МиБ; на живых данных такая есть — запись сжатия Codex 4,19 МБ) лента
  не показывает, но **перешагивает**: пустая страница двигает курсор за просмотренный кусок.
  Перешагивает в **обе** стороны, и её хвост не засчитывается в `skipped`: этот счётчик означает
  только битые строки файла. Проверено живьём — 12 страниц вперёд по беседе Claude 28,5 МБ и
  rollout Codex 93,9 МБ: 600 и 378 записей, `skipped: 0`, курсор не застрял ни разу.
- **Правило для потребителя:** признак конца ленты — `eof`/`bof`, а НЕ пустой список записей.
  Пустая страница со сдвинутым курсором означает шаг через строку, которая в окно не влезла;
  остановившись на ней, клиент потеряет всё, что за ней.
- Прочие оговорки: строка Claude с несколькими блоками даёт несколько записей (`uuid`, `uuid#1`, …)
  и между страницами не делится, поэтому страница бывает на пару записей шире `limit`;
  мышление Codex приезжает с пустым текстом (summary на живых данных зашифрован).

### Из таска 04 — лента по обоим транспортам

- `FrameType.Feed = 46`, `FrameType.FeedResult = 47`. Запрос `{session, limit?, before?, after?,
  around?}`, ответ — тело §6 как есть, без обёртки и без идентификатора, на канале запроса.
- `GET /api/feed?session=&limit=&before=&after=&around=` → 200 и то же тело; отказ едет полем
  `ok: false`, а не кодом HTTP.
- Гость со `scope`, спросивший чужую сессию, получает `Error {code:'forbidden'}`, и лента при
  этом не читается вовсе. Своя сессия открыта ему без права `write` и без права `files`.
- `AgentServer({feed?})` и `RelayLink({feed?})`: `(session, opts) => Promise<FeedResult>`; по
  умолчанию `sessionFeed(session, opts, {socketName: this.socketName})`.
- **Для третьего этапа:** типы тела (`FeedEntry`, `FeedPage`, `FeedResult`) лежат в пакете агента,
  не в протоколе. Вебу их оттуда не импортировать — либо переносить типы в `@termhub/protocol`,
  либо объявлять свои.
- Корреляции запрос↔ответ по идентификатору нет: клиент шлёт по одному запросу за раз, как с
  кадром возможностей.
- `packages/agent/src/feed-request.ts` — общий для обоих транспортов разбор запроса и вызов
  ленты: `FeedReader = (session, opts) => Promise<FeedResult>`, `feedSession(raw) -> string`,
  `feedPage(read, raw) -> Promise<FeedResult>` (не бросает). Пустое значение параметра
  равносильно отсутствующему на обоих транспортах; неожиданный сбой чтения даёт
  `{ok:false, reason:'lookup-failed'}` одинаково там и там.
- `RelayLink.ownsSession(s, session, withBuild)` — единственный предикат «чья это сессия»:
  `doList(false)`, `doOpen(true)`, `doFeed(false)`. Гостю сборочная сессия ленты не даёт.
- Ожидаемое тело ответа в тестах — одна типизированная константа `FEED_PAGE` плюс
  `FEED_PAGE_JSON` в `packages/agent/test/feed-fixture.ts`, импортируются обоими близнецами.

### Из таска 03 — лента сессии

- `packages/agent/src/session-feed.ts`:
  `sessionFeed(session: string, opts?: FeedOptions, sources?: Partial<SessionFeedSources>): Promise<FeedResult>`
  где `FeedResult = (FeedPage & { complete: boolean; live: boolean }) | FeedFailure`.
- Шов: `SessionFeedSources { home; socketName?; activePane(session); resolve(pane); sessionFiles(dir) }`.
- **Для таска 04:** `socketName` по умолчанию НЕ подставляется (как у `resolve` и `SessionService`) —
  передавать `config.TMUX_SOCKET`, иначе запрос уйдёт на сокет tmux по умолчанию.
- Пределы страницы общие с `transcript-feed`: оттуда экспортированы `limitOf`, `weigh` и
  `RESPONSE_LIMIT`, а разбор `session_meta` и константы `CODEX_SESSIONS_DIR`/`HEAD_BYTES` —
  из `agent-transcript.ts` (`codexMeta`, `CodexMeta{root,started,thread,forkedFrom}`). Своих
  копий ни того, ни другого в `session-feed` нет.
- На пределе глубины (10 файлов) лента отвечает `bof: false` и вехой `chain`: предохранитель
  за начало беседы не выдаётся.
- Цепочка Codex идёт **только назад**: `after`, упёршийся в конец файла-родителя, отдаёт `eof`
  этого файла и цепочку не тянет — новые записи пишутся только в текущий файл. Лента
  продолжается в родителе прямо в той же странице до лимита. Обход `~/.codex/sessions/**` —
  не чаще раза на запрос и только когда страница дошла до границы файла.
- **Цель `display-message` обязана нести двоеточие:** `-t '=имя'` tmux 3.7b сессией не считает и
  отвечает кодом 0 и строкой «:.», `-t '=имя:'` отвечает адресом. На этом лента не работала ни по
  одной живой сессии, пока шов был подменён в каждом тесте (находка слепой приёмки, таск 06).
  Адрес всё равно проверяется регуляркой: пустой «:.» до определителя не доходит.
- Живые швы отбираются в свою группу vitest по суффиксу `*.tmux.test.ts` — новый такой тест
  попадает туда сам. Внутри группы файлы параллельны, каждый на своём сокете.

### Из таска 02 — объявление возможностей

- `packages/protocol/src/capabilities.ts` — `CAP_FEED = 'feed'`, `AGENT_CAPS`, `CLIENT_CAPS`,
  `parseCaps(value: unknown): string[]`, `intersect(a, b): string[]`. Список возможностей —
  данные: добавление имени не требует правки разбора.
- `FrameType.Capabilities = 44`, `FrameType.CapabilitiesResult = 45`, payload `{caps: string[]}`
  в обе стороны. Номера 46 и 47 заняты под ленту (таск 04) — не занимать ничем другим.
- Агент: `POST /api/capabilities {caps} → {caps}`; `GET /api/diag` отдаёт `caps: {agent, negotiated}`.
  Через relay кадр `Capabilities` отвечает `CapabilitiesResult {caps: AGENT_CAPS}`, гостю наравне.
- Веб: `Transport.capabilities(caps: string[]): Promise<string[]>`; `packages/web/src/capabilities.ts`
  — `negotiateCaps(transport)`, `hasCap(name)`, `negotiatedCaps()`. Молчание агента 2 с и 404
  дают пустое пересечение, а не ошибку.
- После починки: `/api/diag` отдаёт пересечение с последним объявившимся клиентом **независимо
  от транспорта**; `RelayLink.status()` добавил `{caps, capsAt}`; в вебе появился `forgetCaps()` —
  состояние гаснет при отключении и смене транспорта. 401 на LAN означает «обмена ещё не было»
  и повторяется после входа; пустым пересечение делают только 404 и молчание 2 с.
- Пересечение и время обмена живут на `ClientSession`: `status()` берёт самый свежий обмен среди
  **подключённых**, пустой мост отдаёт `[]` и `0`. Ушедший клиент в `/api/diag` не показывается.
- Оговорка для третьего этапа: LAN помнит последний REST-обмен вечно — события «клиент ушёл» у
  REST нет. Значит `negotiated` — это «с кем договорились в последний раз», а не признак живого
  клиента.
