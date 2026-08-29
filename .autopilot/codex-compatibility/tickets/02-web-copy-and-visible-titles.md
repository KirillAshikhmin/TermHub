# 02 — Устойчивое копирование и видимые заголовки

**Требования:** R01, R02, R03, R04, R05, R06, R07, R08, R09, R10i, A01
**Blocked by:** 01
**Зона:** `packages/web/src/term*.ts` · `packages/web/src/tabs.ts` · `packages/web/src/main.ts` · `packages/web/src/workspace.ts` · `packages/web/test/` · `README*.md` · `docs/manual-test-checklist*.md`
**Волна:** 2
**Status:** ready

## Что должно заработать

Drag по терминалу автоматически копирует выбранный текст. Если Codex успел
перерисовать экран и стереть подсветку, `Command/Ctrl+C` использует последний
непустой снимок; без снимка `Ctrl+C` по-прежнему уходит процессу. Внутренняя вкладка
и browser/PWA title показывают имя потока/сессии, а не вечный `TermHub`.

## Из брифа, дословно

> «не копируется текст из терминала в вебе»
> «в claude когда выделяешь - он копирует втоматом»
> «а тут и выделение сразу сбрасывается и скопировать даже через command+c не получается»
> «Имя сессии не указывается как имя таба»

## Разделы спецификации

Истории 1–19; решения 1–2 и 5; швы `terminal-copy`, `session-tabs`,
`document-title`; «Результаты аудита».

## Критерии приёмки

- [ ] Последний непустой xterm selection сохраняется через redraw, а новый gesture
  очищает старый snapshot до появления нового выделения.
- [ ] Mouseup с непустым снимком вызывает общий clipboard helper; ошибка не ломает
  терминал и оставляет возможность повторить keyboard copy.
- [ ] `Command+C`/`Ctrl+C` с текущим или сохранённым selection копирует и не шлёт
  interrupt; без selection не перехватывается.
- [ ] Тесты покрывают redraw-clear, новый клик, success/failure copy и pass-through.
- [ ] Текущий session tab обновляется из `pane_title`; browser title имеет форму
  `<display title> · TermHub`, fallback `<tmux-id> · TermHub`, а вне workspace — `TermHub`.
- [ ] Claude title/copy сценарии не регрессируют; LAN и relay используют общий код.
- [ ] README EN/RU и manual checklist EN/RU описывают Codex preset, `/title` для
  существующей сессии и ручную проверку копирования/title.
- [ ] Web tsc, build и полный vitest зелёные.
