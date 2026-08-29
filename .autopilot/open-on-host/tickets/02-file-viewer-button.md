# 02 — Кнопка «Открыть на хосте» в Проводнике

**Требования:** R01, R02, R03, R05, R06, R07, R08, R09i, R10i
**Blocked by:** 01
**Зона:** `packages/web/src/files.ts` · `packages/web/src/i18n.ts` · `packages/web/test/` · `docs/manual-test-checklist*.md`
**Волна:** 2
**Status:** ready

## Что должно заработать

В footer file viewer для любого типа файла появляется «Открыть на хосте». Кнопка
вызывает `fileOp('open-host')`, защищена от двойного клика, показывает success/error и
возвращается в активное состояние. У read-only relay guest кнопки нет.

## Из брифа, дословно

> «при открытии файла в Проводнике есть кнопка Открыть в NotAText»
> «добавь так же просто кнопку Открыть на хосте»
> «коммить всё, если ещё не закоммитил»

## Разделы спецификации

Истории 1–3 и 6, 9–15; Решения 4–6; швы `transport`, `file-viewer`.

## Критерии приёмки

- [ ] Кнопка есть для text/image/media/binary/truncated preview рядом с другими действиями.
- [ ] Один click → один `fileOp('open-host', {root, path})`; pending блокирует повтор.
- [ ] Success/error локализованы; после обоих исходов кнопка снова активна, модалка остаётся.
- [ ] Read-only relay guest кнопку не видит; LAN/full-scope пользователь видит.
- [ ] DOM-тесты покрывают типы preview, double-click, success/error и permission.
- [ ] EN/RU manual checklist обновлён; web tests, tsc и build зелёные.
- [ ] После общего зелёного прогона фича закоммичена, задеплоена; tmux до/после совпадает.
