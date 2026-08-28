# 03 — Экран сессии: фокус при переключении, ввод до подключения, Enter — ровно одно действие

**Требования:** R13, R13.1, R13.2, R13.3, R13.4, R14, R15
**Blocked by:** 02
**Зона:** `packages/web/src/term.ts` · `tabs.ts` · `workspace.ts` · новый `term-keys.ts` · `packages/web/test/`
**Волна:** 2
**Status:** ready

## Что должно заработать

Переключился на вкладку сессии (тап по табу или по карточке панели, возврат с
Проводника/Репозитория/Gradle) — курсор в терминале сразу, не через секунды после
`connected`, и независимо от тумблера ⌨ (при выключенном тумблере поле стоит в
`inputmode=none`, экранная клавиатура не всплывает, аппаратная работает). Сам тап по
вкладке не уводит фокус (на телефоне не закрывает клавиатуру). Набранное до
подключения не пропадает: копится и уходит сразу после первого кадра RESIZE.
Enter делает ровно одно: тумблер включён — Enter отправляет (`\r`), Shift+Enter переносит
(`\x1b\r`); выключен — Enter и Shift+Enter переносят. Сегодня ветка «перенос» не гасит
`keydown`, браузер порождает `keypress`, и xterm шлёт второй `\r` — отсюда «перенос и
тут же отправка, независимо от переключателя».

## Из брифа, дословно

> «при переключении на вкладку фокус должен на неё перемещаться, точнее на терминал внутри, а то ввод пропадает.»
> «почему-то всегда при нажатии энтер сперва вставляется перевод строки и тут же идёт отправка команды. независимо от переключателя.»

## Разделы спецификации

Истории 26–32; Решения §14–§17; Границы (`web/term`, `web/term-keys`, `web/tabs`,
`web/workspace`); Швы: `enterAction`, полоса вкладок, очередь ввода, `workspace.show('term')`.

## Критерии приёмки

- [ ] Новый чистый модуль `term-keys.ts`: `enterAction({type, key, shiftKey}, enterSends) -> 'send' | 'newline' | 'suppress' | 'pass'`; тест-таблица: `keydown Enter` при `enterSends && !shift` → `send`; при `shift || !enterSends` → `newline`; `keypress Enter` → `suppress`; `keyup Enter` и любые не-Enter → `pass`
- [ ] Обработчик в `term.ts` делегирует `enterAction`: `newline` → один `sendData('\x1b\r')` + `e.preventDefault()` + `return false`; `suppress` → `preventDefault()` + `return false`; `send`/`pass` → `return true`. Тест обвязки (без xterm, обработчик вынесен фабрикой или проверен через мок): `keydown` с `cancelable: true` → `defaultPrevented === true` и ровно один вызов отправки; последующий `keypress` → ни одного байта
- [ ] Ветки Cmd/Option+стрелок и compose-бар — поведение без изменений
- [ ] `tabs.ts`: `mousedown` по кнопке таба `.th-tab__btn` → `preventDefault()`; тест в `tabs.test.ts`
- [ ] `term.ts`: после `term.open(host)` и применения режима клавиатуры (`applyKeyboardMode`) — `term.focus()` безусловно; существующий фокус на `connected` (при включённом ⌨) остаётся; хэндл терминала получает метод `focus()`
- [ ] `workspace.show('term')` вызывает `focus()` хэндла (тест с `vi.mock('../src/term')`: после `show('files')` → `show('term')` фокус вызван)
- [ ] Очередь ввода: `sendData` при статусе ≠ `connected` копит байты (лимит 8 КБ, лишнее отбрасывается с конца); на `connected` порядок — `sendResize()`, затем очередь; `onEnd` и teardown очищают очередь. Тест на порядок кадров и лимит
- [ ] `npx tsc -p packages/web/tsconfig.json --noEmit` без новых ошибок; `npx vitest run` зелёный; `npm run build -w @termhub/web` проходит и `grep -c libsodium packages/agent/static/assets/main-*.js` = 0
- [ ] Комментарии по-русски у причины (keypress после `false` без `preventDefault`) и у очереди (инвариант «первый кадр — RESIZE»)
