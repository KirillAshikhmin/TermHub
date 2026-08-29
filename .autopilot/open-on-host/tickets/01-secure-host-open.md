# 01 — Безопасное системное открытие файла

**Требования:** R03, R04, R05, R09i, R10i
**Blocked by:** —
**Зона:** `packages/agent/src/host-open.ts` · `packages/agent/src/files.ts` · `packages/agent/src/server.ts` · `packages/agent/src/relay-link.ts` · `packages/agent/test/`
**Волна:** 1
**Status:** ready

## Что должно заработать

Существующий `fileOp` принимает action `open-host`. FileService безопасно разрешает
обычный файл внутри roots, а системный opener открывает его на macOS/Linux без shell.
LAN и relay используют один dispatcher; read-only relay guest получает отказ.

## Из брифа, дословно

> «которая открывает файл там, где запущена сессия»
> «в частности на моем мак»
> «реализуй теперь»

## Разделы спецификации

Истории 3–11; Решения 1–4 и 6; швы `host-opener`, `file-service`, `transport`.

## Критерии приёмки

- [ ] macOS использует `open`, Linux — `xdg-open`; unsupported OS, spawn error и non-zero exit дают reject.
- [ ] Никакого shell; абсолютный realpath передаётся отдельным argv-аргументом.
- [ ] `openOnHost` принимает только существующий обычный файл внутри разрешённого root.
- [ ] `runFileOp('open-host')` вызывает этот seam; LAN route возвращает success/error.
- [ ] Relay повторно проверяет scoped path и требует write permission для host side effect.
- [ ] Узкие agent/relay тесты и agent build зелёные.
