# TermHub

[English](README.md) · **Русский**

**Доступ к терминальным (tmux) сессиям вашего Mac — с телефона или из браузера.**
Смотрите прогресс, работайте в полноценном терминале, листайте файлы и коммитьте —
локально по Wi-Fi или удалённо через собственный relay со сквозным шифрованием.
На Mac при этом **не открывается ни один порт наружу**.

Изначально TermHub заточен под работу с [Claude Code](https://claude.com/claude-code)
и другими TUI-агентами, запущенными в tmux (отвечать на вопросы агента с телефона,
подтверждать правки, дописывать промпты), но это обычный удалённый терминал — подойдёт
для любой работы в консоли.

> Статус: `0.1.0`, alpha. Агент работает на macOS.

---

## Возможности

- **Дашборд сессий** — список tmux-сессий, создание/завершение, индикаторы
  «работает» / 🔔 «ждёт ответа» (по заголовку окна, как рисует Claude Code).
- **Полноценный терминал** в браузере (xterm.js): панель быстрых клавиш под мобильную
  клавиатуру, **compose bar** — нативное поле ввода с живым зеркалом строки терминала
  (свайп/автозамена/подсказки Claude/Tab/история), кликабельные пути и ссылки.
- **Проводник** — просмотр/скачивание файлов, просмотр картинок/видео, простое
  редактирование текста, контекстное меню (копировать/переместить/переименовать/
  удалить/свойства), «Открыть в NotAText».
- **Репозиторий** — git / svn / mercurial: лог коммитов, дифф, коммит с выбором файлов,
  pull/push, ветки (переключение/создание/удаление).
- **Рабочее пространство сессии** — Терминал / Проводник / Репозиторий одной сессии
  живут одновременно, переключение вкладок не рвёт терминал и не теряет состояние.
- **PWA** — ставится на домашний экран, работает как приложение; тема ru/en.
- **Уведомления** — звук, локальные Notification и Web Push (когда вкладка закрыта).
- **Удалённый доступ** через свой relay: исходящее E2E-соединение, zero-knowledge relay.
- **CLI-клиент** (`termhub connect`) — терминал из другого компьютера, как ssh.
- **Диагностика** — веб-страница статуса и команда `termhub doctor`.

---

## Как это работает

```
                     ┌──────────────────────── ваш Mac ────────────────────────┐
   ЛОКАЛЬНАЯ СЕТЬ     │                                                          │
   ┌──────────┐ HTTPS │  ┌───────────────┐   pty    ┌──────────────────────────┐│
   │ телефон  │  + WS │  │  @termhub/    │◀────────▶│  tmux  (сокет -L termhub) ││
   │  (PWA)   │───────┼─▶│    agent      │          │   ├ main                  ││
   └──────────┘       │  │ (Node, HTTP/  │          │   ├ project-a  ├ claude … ││
                      │  │  WS-сервер)   │          │   └ рабочие сессии        ││
                      │  └───────┬───────┘          └──────────────────────────┘│
                      │          │ исходящее WSS + сквозное шифрование           │
                      └──────────┼───────────────────────────────────────────────┘
                                 │        (порты на Mac наружу НЕ открываются)
                    ┌────────────▼─────────────┐
   ВНЕ СЕТИ         │   relay  (VPS, Docker)   │   zero-knowledge коммутатор:
   ┌──────────┐ E2E │   @termhub/relay         │   видит, «кто с кем», но НЕ
   │ телефон  │────▶│   (WS-switch + статика)  │   может прочитать содержимое
   │  / CLI   │     └──────────────────────────┘
   └──────────┘
```

- **Агент** — Node-процесс на Mac. Держит tmux-сессии, отдаёт по HTTP/WebSocket дашборд,
  терминал, проводник и репозиторий, умеет пробрасывать доступ наружу через relay.
- **В локальной сети** браузер идёт к агенту напрямую: `https://<mac>.local:7710`.
- **Вне сети** агент сам открывает исходящее защищённое соединение к relay (на Mac порты
  не открываются), а телефон/CLI подключаются к тому же relay по одноразовому коду
  пейринга. Relay — только «коммутатор»: маршрутизирует, но содержимое зашифровано
  end-to-end (libsodium secretstream) и ему недоступно.
- **tmux обязателен.** К обычному терминалу IDE снаружи не подключиться — его pty
  принадлежит IDE. Рабочие сессии живут в tmux на выделенном сокете `-L termhub`
  (чтобы случайный `tmux kill-server` их не снёс), агент делает `tmux attach`.

Подробнее: [docs/remote.ru.md](docs/remote.ru.md) (relay/пейринг/Tailscale),
[docs/security.ru.md](docs/security.ru.md) (модель угроз и криптография).

---

## Монорепо

npm workspaces, `packages/*`:

| Пакет | Что внутри |
|---|---|
| **`@termhub/protocol`** | Фундамент: фрейм-кодек, E2E-крипта на libsodium, base64. |
| **`@termhub/agent`** | Node-процесс на Mac + CLI `termhub`: HTTP/WS-сервер, обёртка tmux, мост pty↔tmux↔WS, web-push, LaunchAgent, relay-сторона, CLI-клиент, VCS-браузер. |
| **`@termhub/relay`** | Zero-knowledge коммутатор (VPS, Docker): WS-switch + раздача статики. |
| **`@termhub/web`** | PWA (vite + vanilla TS, xterm.js): транспорт-абстракция (LAN REST / relay E2E), экраны дашборда/терминала/проводника/репозитория, крипта в браузере. Собирается в `packages/agent/static`. |

Технологии: Node ≥ 22, TypeScript strict (ESM), `ws`, `node-pty`,
`libsodium-wrappers-sumo`, `web-push`, vite, `@xterm/*`, vitest.

---

## Быстрый старт

```bash
git clone https://github.com/KirillAshikhmin/TermHub.git
cd TermHub
npm install          # + postinstall: chmod +x на spawn-helper node-pty
npm run build
npx termhub setup    # пароль, порт (7710), корни сессий, опц. relay, VAPID, tm/tml
npx termhub start    # поднять агента (LAN + relay, если задан)
```

Требования: **macOS**, **Node.js ≥ 22**, **tmux** (`brew install tmux`).

`setup` спросит пароль для веб-входа, порт, каталоги-корни (откуда можно открывать
сессии/файлы), при желании — адрес relay для удалённого доступа, и предложит завести
tmux-конфиг и алиасы `tm`/`tml`.

Откройте с телефона в той же Wi-Fi-сети:

```
https://<имя-mac>.local:7710
```

(`<имя-mac>` — System Settings → General → Sharing → Local hostname; при самоподписанном
сертификате примите предупреждение один раз). Введите пароль — вы на дашборде.

Автозапуск как сервис (LaunchAgent, лог — `~/Library/Logs/termhub.log`):

```bash
npx termhub service install
npx termhub service status
npx termhub service uninstall
```

### Привычка: `tm` в терминале IDE

Открывая терминал в IDE (IDEA и т.п.), наберите `tm` — создастся/откроется tmux-сессия
`main` на сокете `-L termhub`, именно её TermHub увидит на дашборде. `tml` — список
сессий. Ещё одна параллельная сессия — кнопкой «Новая сессия» на дашборде или
`tmux -L termhub new -s <имя>`.

---

## CLI

```bash
npx termhub setup          # интерактивная настройка
npx termhub start          # запустить агента (LAN + relay)
npx termhub service …      # install | uninstall | status (LaunchAgent)
npx termhub share          # одноразовый код пейринга (+ QR) для нового устройства
npx termhub pair|connect   # CLI-клиент: сопряжение и «ssh через relay»
npx termhub devices|revoke # список/отзыв допущенных устройств
npx termhub doctor         # диагностика: конфиг, git/svn/hg, tmux, агент, relay
```

---

## Диагностика

- **`termhub doctor`** — проверяет конфиг, наличие git/svn/hg, tmux-сессии, слушает ли
  агент порт, доступен ли relay; печатает цветной отчёт.
- **Веб-страница «Диагностика»** (меню `⋮` → Диагностика) — версия, аптайм, число сессий,
  **статус связи с relay** (зарегистрирован ли агент), число подключённых клиентов, корни.
  Доступна на LAN-адресе агента.

---

## Безопасность (кратко)

- LAN: вход по паролю (scrypt-хэш), cookie-сессия, самоподписанный TLS.
- Remote: agent = `server`, клиенты = `client` в E2E-хендшейке (Ed25519-fingerprint ∈
  список допущенных → libsodium `crypto_kx` → secretstream). Relay содержимое не видит.
- Пейринг новых устройств — по одноразовому коду; устройства можно отзывать.
- Все вызовы tmux/VCS — через `execFile` без shell (анти-RCE); имена/пути валидируются,
  файловые операции ограничены whitelist-корнями (realpath-проверка побега).
- Секретные файлы (`~/.termhub/*.json`) — режим `0600`.

Полная модель угроз — [docs/security.ru.md](docs/security.ru.md).

---

## Развёртывание relay (опционально)

Relay — небольшой Docker-сервис на VPS. Цикл: `npm run build` → `rsync` исходников на
сервер → `docker build -f packages/relay/Dockerfile` → `docker compose up -d`. За TLS
отвечает Caddy. Агенту в `setup` указывается `relayUrl` (`wss://<host>/relay`).
Подробности — [docs/remote.ru.md](docs/remote.ru.md).

---

## Разработка

```bash
npm run build            # tsc по пакетам + vite-сборка web → packages/agent/static
npx vitest run           # все тесты
npx tsc -p packages/web/tsconfig.json --noEmit   # web не типизируется vite-сборкой
```

- TypeScript strict, ESM везде, отступы 2 пробела.
- UI-строки веба — только через i18n (`i18n.ts`), словари ru+en с идентичным набором
  ключей (проверяется тестом).
- `packages/{agent,relay}/static` — сборочный артефакт (в `.gitignore`); тесты гоняются
  по `src` без сборки.

Как участвовать — [CONTRIBUTING.ru.md](CONTRIBUTING.ru.md).

---

## Troubleshooting

- **Не открывается `https://<mac>.local:7710`** — на части сетей не работает mDNS.
  Возьмите IP Mac (`ipconfig getifaddr en0`) и откройте `https://<IP>:7710`.
- **Не подключается через relay** — проверьте `termhub doctor` (доступен ли relay) и
  страницу «Диагностика» (зарегистрирован ли агент). Частая причина — Mac заснул или
  агент не запущен.
- **Mac засыпает** — отключите сон в System Settings, либо `caffeinate -di`, либо тумблер
  «Не давать Mac засыпать» в меню веба.
- **Запасной канал** — включите Remote Login (SSH) и делайте `tmux -L termhub attach -t main`.

---

## Документация

- [docs/remote.ru.md](docs/remote.ru.md) — удалённый доступ: relay, пейринг, Tailscale
- [docs/security.ru.md](docs/security.ru.md) — модель угроз и криптография
- [docs/notifications.ru.md](docs/notifications.ru.md) — звук, push, HTTPS
- [docs/manual-test-checklist.ru.md](docs/manual-test-checklist.ru.md) — чек-лист ручной проверки

---

## Лицензия

[MIT](LICENSE) © Kirill Ashikhmin.
