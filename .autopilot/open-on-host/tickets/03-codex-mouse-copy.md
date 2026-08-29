# 03 — Копирование при mouse tracking Codex

**Требования:** R11
**Blocked by:** —
**Зона:** `packages/web/src/term.ts` · `packages/web/test/term-copy*.test.ts` · `packages/web/test/term-harness.ts` · `docs/manual-test-checklist*.md`
**Волна:** 2
**Status:** ready

## Что должно заработать

В реальном Codex TUI на Mac пользователь делает Option+drag, xterm принудительно
создаёт selection несмотря на active mouse tracking, а существующий контроллер
автоматически копирует его и сохраняет для Command+C.

## Критерии приёмки

- [ ] Опция xterm для Option-click/drag force selection включена на macOS без отключения mouse tracking Codex.
- [ ] Обычный click/drag без Option продолжает доставляться TUI.
- [ ] Тест проверяет опции настоящего mount и сценарий force-selection при активном mouse mode, а не вручную вызывает готовый selection без mouse mode.
- [ ] EN/RU checklist описывает Option+drag и auto-copy/Command+C.
- [ ] Web tests, tsc и общий build зелёные.
