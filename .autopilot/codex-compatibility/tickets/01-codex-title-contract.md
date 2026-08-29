# 01 — Codex title-контракт и безопасный пресет

**Требования:** R01, R06, R07, R08, R09, R10i
**Blocked by:** —
**Зона:** `packages/protocol/src/session-title.ts` · `packages/protocol/test/session-title.test.ts` · `packages/agent/src/sessions.ts` · `packages/agent/test/sessions.unit.test.ts`
**Волна:** 1
**Status:** ready

## Что должно заработать

Общий парсер отличает работающий Codex от `Action Required`, очищает служебный
префикс и сохраняет прежнюю семантику Claude. Новая сессия из web-пресета `codex`
стартует без title-анимации и публикует `thread-title`, не меняя глобальный config.

## Из брифа, дословно

> «Поправь Termhub для работы с Codex»
> «Имя сессии не указывается как имя таба, там просто название папки и всё»
> «Сама сессия так и называетя TermHub»

## Разделы спецификации

Истории 10, 12–18; «Что здесь называется именем сессии»; «Результаты аудита»;
решения 3–4; швы `session-title`, `session-preset`.

## Критерии приёмки

- [ ] `[ ! ] Action Required` и `[ . ] Action Required` дают managed=true,
  waiting=true, working=false и не оставляют служебный prefix в display text.
- [ ] Все прежние Claude-title тесты (braille/полукруг/`✳`/обычный title) зелёные.
- [ ] `codex` preset формирует argv без shell с `tui.animations=false` и
  `tui.terminal_title=["activity","thread-title"]`; zsh/Claude не изменены.
- [ ] Никакой пользовательский Codex config или протокол не меняется.
- [ ] Узкие protocol/agent тесты и TypeScript build соответствующих пакетов зелёные.

