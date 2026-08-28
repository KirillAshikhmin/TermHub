# 05 — Доводка по итогам ревью: фокус, очередь, единый `termHash`, ассерты

**Требования:** R11 (§13 «единый источник `#/term/`»), R13 (§14–§15), R02/R06i (§2 — имя по умолчанию в ручной форме), G01.5 (README)
**Blocked by:** 03
**Зона:** `packages/web/src/workspace.ts` · `term.ts` · `dashboard.ts` · `gradle.ts` · `sw.ts` (только формат `#/term/`) · `packages/web/test/{create-modal,relay-transport,term-keys,term-input-queue,workspace}.test.ts` · `packages/agent/test/sessions.unit.test.ts` · `packages/agent/test/sessions.tmux.test.ts` · `README.md` · `README.ru.md`
**Волна:** 3
**Status:** ready

## Что должно заработать

Отложенные находки ревью, которые дороже оставить, чем закрыть. Поведение для
пользователя: переключение вкладок не крадёт фокус у compose-бара при повторе события
маршрута; очередь ввода до подключения не отправляет в pty разорванный UTF-8; в ручной
форме создания (relay) пустое поле «Имя» даёт то же санитизированное имя папки, что и
форма со списком (папка `my.app` → `my_app`, а не отказ агента); все переходы на экран
сессии строятся одним `termHash`. Плюс пять ассертов, которые сейчас не могут упасть,
делаются дискриминирующими, и README перестаёт ссылаться на сессию `main`.

## Из брифа, дословно

> «при переключении на вкладку фокус должен на неё перемещаться, точнее на терминал внутри, а то ввод пропадает.»
> «допустим папка MyProject, создали сессию не вводя имя»

## Разделы спецификации

Решения §2, §13, §14, §15; Швы: «`openCreateModal` в happy-dom», «`enterAction`», «Очередь ввода», «`workspace.show('term')`», «`SessionService.create` с подменённым `execFile`», «Живой tmux».

## Критерии приёмки

- [ ] `workspace.show('term')` фокусирует терминал только при переходе на вкладку «Сессия» (вид не был активен до этого `show`); повторный `show('term')` на уже активной вкладке фокус не трогает — тест в `workspace.test.ts`
- [ ] Очередь ввода (`term.ts`): чанк, который не влезает в лимит 8 КБ целиком, отбрасывается целиком (без `subarray` внутри чанка) — тест в `term-input-queue.test.ts` (многобайтовый символ на границе не режется)
- [ ] У фокуса при монтаже в `term.ts` — комментарий по-русски: для пути workspace он срабатывает на скрытом элементе, рабочий фокус там даёт `show('term')`; для `openTerminal`/`remote.ts` — этот
- [ ] Ручная форма модалки: при пустом поле «Имя» имя = `sanitizeSessionName(dir)` (как в форме со списком), `autoName: true`; `dir` уходит как введён — тест в `create-modal.test.ts` (`my.app` → `my_app`)
- [ ] Все построения `#/term/<имя>` в `workspace.ts`, `term.ts` (goTo и остальные), `gradle.ts`, `sw.ts` идут через `routes.termHash` (в `sw.ts` — только если он собирает такой URL и импорт `routes` не тянет DOM/xterm; иначе оставить и сказать в CONCERNS); `grep -n "#/term/" packages/web/src` показывает только `routes.ts`
- [ ] `sessions.unit.test.ts` (тест скрытой сборочной сессии, ~:432): утверждается ровно одна попытка `new-session` с именем `_gradle_MyProject_ab12cd1`; дубликат `svcGradle` убран
- [ ] `sessions.tmux.test.ts` (~:65): живой отказ tmux на дубле удовлетворяет `toMatchObject({ code: 1, stderr: expect.stringMatching(/duplicate session/) })`
- [ ] `relay-transport.test.ts` (~:433): утверждение, что отправленный кадр `Create` содержит `autoName: true`
- [ ] `create-modal.test.ts` (~:106–108): утверждения `location.hash`/`history.length`, держащиеся на эмуляции `replaceState`, либо убраны, либо помечены комментарием как следствие эмуляции; доказательство — пара spy
- [ ] `term-keys.test.ts` (~:81, :93): тест и его имя утверждают контракт для `keypress` (возврат `false` + `defaultPrevented`), а не «ни байта»
- [ ] README.md / README.ru.md (~:222): пример запасного SSH-канала ссылается на имя папки (`attach -t <имя-папки>` или `<name>`), не на `main`; обе версии синхронны
- [ ] `npx tsc -p packages/web/tsconfig.json --noEmit` без ошибок; `npx vitest run` зелёный (сейчас 681); `npm run build -w @termhub/web` проходит и `grep -c libsodium packages/agent/static/assets/main-*.js` = 0
