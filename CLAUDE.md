# CLAUDE.md

Инструкции для работы с кодом **TermHub**. Прочитай перед любыми правками.
Общение — на русском.

## Что это

TermHub даёт доступ к терминальным (tmux) сессиям Mac с телефона/браузера.
Два режима: **LAN** (PWA + пароль, прямое WS-подключение к агенту) и **remote**
(тонкий zero-knowledge relay + E2E-крипта, пейринг по одноразовому коду) плюс
CLI-клиент «ssh через relay».

Полный обзор — `README.md`; безопасность — `docs/security.md`; удалённый доступ —
`docs/remote.md`. Статус — `0.1.0` alpha.

## Монорепо (npm workspaces, `packages/*`)

| Пакет            | Что внутри |
|------------------|------------|
| `@termhub/protocol` | Фундамент: фрейм-кодек (`frames.ts`), E2E-крипта на libsodium (`crypto.ts`), base64 (`b64.ts`). Зависимость всех остальных. |
| `@termhub/agent` | Node-процесс на Mac + CLI `termhub`. HTTP/WS-сервер (`server.ts`+`auth.ts`), обёртка tmux (`sessions.ts`), мост pty↔tmux↔WS (`bridge.ts`), web-push (`push.ts`), LaunchAgent (`service.ts`), конфиг/setup (`config.ts`/`setup.ts`/`paths.ts`), remote-сторона (`relay-link.ts`/`share.ts`), CLI-клиент (`connect-cmd.ts`/`pair-cmd.ts`/`client-store.ts`/`devices-cmd.ts`), роутер команд (`cli.ts`). |
| `@termhub/relay` | Zero-knowledge коммутатор (VPS, Docker): `index.ts`+`rooms.ts`, раздача статики `static.ts`, точка входа `main.ts`. |
| `@termhub/web`   | PWA (vite + vanilla TS, xterm.js). Транспорт-абстракция `transport.ts`/`relay-transport.ts`, экраны `dashboard.ts`/`term.ts`/`pairing.ts`, SW `sw.ts`, крипта-в-браузере `keys.ts`/`remote.ts`. Собирается в `packages/agent/static` (раздаётся агентом). |

Технологии: Node ≥ 22, TypeScript strict (ESM везде), `ws`, `node-pty`,
`libsodium-wrappers-sumo`, `web-push`, vite, `@xterm/*`, vitest.

## Команды

```bash
npm install            # + postinstall: chmod +x на spawn-helper node-pty (иначе pty не спавнится)
npm run build          # tsc по всем пакетам + vite-сборка web → packages/agent/static
npx vitest run         # все тесты (240 шт.)
npx vitest run packages/agent/test/sessions.unit.test.ts   # один файл
npm run build -w @termhub/web        # только web-бандл
node packages/agent/bin/termhub.js <команда>   # запуск CLI из исходников после build

# CLI пользователя (после npm run build):
npx termhub setup      # интерактивно: пароль, порт, корни сессий, relay, VAPID, tmux/zsh
npx termhub start      # поднять агента (LAN + relay, если задан relayUrl)
npx termhub share      # одноразовый код пейринга (+ QR) для нового устройства
npx termhub connect|pair|devices|revoke|service   # см. cli.ts
```

## Критические знания (иначе не вывести из кода)

1. **tmux — обязательный фундамент.** К обычной сессии терминала IDE снаружи
   не подключиться (pty принадлежит IDE). Рабочие сессии запускаются внутри
   tmux (`setup` заводит алиас `tm`), агент делает `tmux attach`. Без tmux
   продукт не работает.

2. **`packages/{agent,relay}/static` — сборочный артефакт (в `.gitignore`).**
   Тесты гоняются по `src` без сборки. Порядок `npm run build && npx vitest run`
   раньше ломал тест-заглушку — теперь тест изолирован (передаёт пустой
   `staticDir`), но **держи дерево чистым перед прогоном**: если сомневаешься,
   `rm -rf packages/{agent,relay}/static` перед `npx vitest run`.

3. **Крипто-роли фиксированы:** агент = `server`, клиенты (web/CLI) = `client`
   в `sessionKeys`. Хендшейк: plaintext `hello{edPub}` → проверка fingerprint ∈
   authorized → `hello-ok{header}` → `hello-fin{header}` → secretstream. Роли
   web/CLI/agent должны оставаться зеркальными — при правке хендшейка меняй все
   три стороны согласованно и гоняй `e2e.full.test.ts`.

4. **tmux в тестах — только изолированный сокет** `-L termhub-test-<uniq>` +
   `kill-server` в teardown. Никогда не трогай дефолтный tmux-сервер. Все вызовы
   tmux — через `execFile` без shell (анти-RCE); имена/каталоги валидируются
   (`^[\w.-]{1,40}$`, whitelist корней, пресеты команд).

4a. **В проде рабочие сессии живут на выделенном сокете** `-L termhub`
   (`config.TMUX_SOCKET`) — чтобы случайный `tmux kill-server` (без `-L`) не
   сносил рабочие сессии. Имя сокета — единый источник: `cli.ts` прокидывает
   `TMUX_SOCKET` в `SessionService`/`wireTerminalWs`/`RelayLink`, а `setup`
   печёт его в `tm`/`tml` (`-L termhub …`). Меняешь имя — согласуй обе стороны.

5. **Если pty/tmux не спавнится в песочнице** (posix_spawn/EPERM) — перезапусти
   команду тестов с `dangerouslyDisableSandbox: true` (для локального дев-окружения).

6. **libsodium не должен попадать в LAN-бандл.** Крипта грузится ленивым
   `import('./remote')` только в relay-режиме. Проверка: в собранном
   `packages/agent/static/assets/main-*.js` не должно быть `libsodium`/`crypto_kx`
   (грепом). Фрейм-кодек тяни из `@termhub/protocol/frames` (без крипты).

## Стиль и правила

- TypeScript strict, ESM, отступы 2 пробела. Комментарии — по-русски и только
  там, где код не самоочевиден.
- UI-строки веба — только через i18n (`i18n.ts`), оба словаря ru+en с
  идентичным набором ключей (проверяется тестом).
- Секретные файлы (`~/.termhub/*.json`) — mode `0600`, каталог `0700`.
- README и `CONTRIBUTING` — двуязычные: `*.md` (английский, основной) + `*.ru.md`
  (русский); при правке держи обе версии синхронными. Доки в `docs/` — на русском.
- **Не коммитить/пушить без явной просьбы пользователя.** Ветка одна (`main`),
  remote не настроен.

## Прежде чем сказать «готово»

`npx vitest run` зелёный на чистом дереве, при правке remote — прогнать
`packages/agent/test/e2e.full.test.ts` (живой E2E агент↔relay↔клиент).

**Деплой обязателен при любом изменении.** Цикл: изменил → проверил (тесты/сборка)
→ **задеплоил relay**. Процедура (см. [[relay-vps-deploy]]): `npm run build` →
`rsync … root@203.0.113.10:/root/termhub-src/` → на сервере
`docker build -t termhub-relay:latest -f packages/relay/Dockerfile .` →
`docker compose up -d` → проверить `curl --resolve relay.example.com:9443:203.0.113.10`.
Правка агента (`packages/agent/src`) — ещё и рестарт локального LaunchAgent
(`launchctl kickstart -k gui/$(id -u)/dev.termhub.agent`); web-only — только пересборка
(агент раздаёт static с диска). **web НЕ типизируется сборкой** (`vite build` без tsc) —
после правок web гоняй `npx tsc -p packages/web/tsconfig.json --noEmit`, иначе висячие
ссылки (типа удалённой переменной) проскочат в рантайм.

Примечание: `packages/web/src/relay-transport.ts` даёт предсуществующую tsc-придирку
(Uint8Array/BlobPart) — не блокер, рантайму безразлично.
