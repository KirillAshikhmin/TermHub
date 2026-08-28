# 01 — Агент: свободное имя сессии и фактическое имя в ответе

**Требования:** R01, R03, R04, R05, R05.1, R06i, R06i.1, R07i, R08i, R09i, R10i, R10i.1
**Blocked by:** —
**Зона:** `packages/agent/src/sessions.ts` · `packages/agent/src/server.ts` · `packages/agent/src/relay-link.ts` · `packages/agent/test/` (sessions.unit, sessions.tmux, server, relay-link, e2e.full)
**Волна:** 1
**Status:** ready

## Что должно заработать

Запрос на создание сессии с признаком «имя не вводили» (`autoName: true`) и именем
`MyProject` при уже существующей `MyProject` создаёт `MyProject1`; следующий такой же —
`MyProject2`; дыры заполняются (заняты `MyProject` и `MyProject2` → `MyProject1`). Без
признака — прежнее поведение: tmux откажет на дубле, ошибка уходит наружу как сегодня.
Оба транспорта (HTTP `POST /api/sessions` и кадр `Create` через relay) отвечают
**фактическим** именем: `{ok: true, session}` и `CreateOk{session}`. Два одновременных
создания не сталкиваются: «duplicate session» от tmux → следующий номер.

## Из брифа, дословно

> «при создании сессии, если уже есть сессия с названием папки, то создавалась новая с инкрементом значения»
> «допустим папка MyProject, создали сессию не вводя имя, следующая такая же не создастся, а сделай что бы создавалась MyProject1, если и акая есть, то MyProject2 и т.д.»

## Разделы спецификации

Истории 1–15, Решения §1–§6, Границы (`agent/sessions`, `agent/server`, `agent/relay-link`),
Швы: `SessionService.create` с подменённым `execFile`, `pickFreeName`, живой tmux,
`POST /api/sessions`, `Create → CreateOk`.

## Критерии приёмки

- [ ] `create({name:'MyProject', autoName:true, …})`: занято `MyProject` → создаётся `MyProject1`; заняты `MyProject`,`MyProject1` → `MyProject2`; заняты `MyProject`,`MyProject2` → `MyProject1`; свободно → `MyProject`
- [ ] Без `autoName` (или `false`) — прежнее поведение: `new-session` с именем как есть, ошибка tmux пробрасывается без повторов
- [ ] `pickFreeName(base, taken)` экспортирована и покрыта: обрезка базы под суффикс при 40 символах (база из 40 → 39 символов + «1»), `v2` → `v21`, дыры, потолок перебора → ошибка
- [ ] Занятые имена — сырой `tmux list-sessions -F '#{session_name}'` (не `list()`, чтобы видеть и скрытые сборочные сессии); «no server running» → пустой список; иная ошибка пробрасывается
- [ ] `duplicate session` (exit 1 + stderr) от `new-session` при `autoName` → кандидат в занятые, следующий номер, не больше 5 попыток, затем внятная ошибка; иная ошибка `new-session` — сразу наружу
- [ ] `create` возвращает `{ name }`; `POST /api/sessions` → `200 {ok: true, session: <имя>}` (тест через `stubSessions`); `doCreate` в relay-link шлёт `CreateOk{session: <фактическое>}` — тест: второй CREATE с `autoName` на занятое имя получает `session` с суффиксом
- [ ] Валидация имени/пресета/корня/каталога не ослаблена; кандидаты по построению остаются в `^[\w-]{1,40}$`; путь к JDK/командные строки не затронуты
- [ ] Живой tmux (`sessions.tmux.test.ts`, изолированный сокет): трижды `create` с `autoName` → `main`, `main1`, `main2`; повтор без `autoName` → ошибка
- [ ] `npx vitest run` зелёный; `packages/agent/test/e2e.full.test.ts` прогнан отдельно (правился `relay-link.ts`)
- [ ] У ветки повторов и у выбора сырого списка — короткий комментарий по-русски, почему так
