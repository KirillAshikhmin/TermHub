# Участие в разработке

[English](CONTRIBUTING.md) · **Русский**

Спасибо за интерес к TermHub! Патчи, идеи и баг-репорты приветствуются.

## Быстрый старт

```bash
npm install        # + postinstall: chmod +x на spawn-helper node-pty
npm run build      # tsc по пакетам + vite-сборка web
npx vitest run     # все тесты
```

Требования: **macOS** (для агента), **Node.js ≥ 22**, **tmux**.

## Правила кода

- **TypeScript strict, ESM**, отступы 2 пробела. Комментарии — по-русски и только там, где код не самоочевиден.
- **UI-строки веба — только через i18n** (`packages/web/src/i18n.ts`): словари ru+en с идентичным набором ключей (проверяется тестом).
- **web не типизируется vite-сборкой** — после правок web прогоняйте `npx tsc -p packages/web/tsconfig.json --noEmit`.
- **Фичи — для всех транспортов**: LAN, локальная сеть и relay, где применимо.
- Вызовы tmux/VCS — только через `execFile` без shell (анти-RCE); имена/пути валидируются, файловые операции ограничены whitelist-корнями. Секретные файлы (`~/.termhub/*.json`) — режим `0600`.

## Перед PR

- `npm run build` и `npx vitest run` — зелёные.
- Правки remote-части — прогоните `packages/agent/test/e2e.full.test.ts` (живой E2E агент↔relay↔клиент).
- Один PR — одна логически завершённая правка; сообщение коммита кратко описывает суть.

Об архитектуре и безопасности — [README.ru.md](README.ru.md), [docs/security.ru.md](docs/security.ru.md), [docs/remote.ru.md](docs/remote.ru.md).
