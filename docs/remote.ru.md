# Удалённый доступ (relay)

[English](remote.md) · **Русский**

Локальной сети не всегда достаточно — иногда нужно заглянуть в сессию,
когда вы не дома. Для этого у TermHub есть свой relay-сервер.

## Что такое relay

Relay — тонкий сервер-коммутатор (Node + `ws`, деплоится через Docker). Он
**не хранит ничего пользовательского**: только в памяти держит список
подключённых агентов и комнаты пейринга (с TTL). Содержимое трафика — целиком
E2E-зашифровано (см. [docs/security.ru.md](security.ru.md)): relay видит лишь то,
кто с кем соединился, тайминги и объём данных, но не может прочитать ни
один байт вывода терминала. Агент сам открывает исходящее защищённое
соединение к relay — на Mac при этом не открывается ни один входящий порт.

## Деплой relay

В корне репозитория уже есть `docker-compose.yml`:

```bash
docker compose up -d
```

Поднимет только `relay` на порту `9720` (для случая, когда TLS терминируете
сами — свой reverse-proxy или туннель).

Если нужен готовый публичный HTTPS-домен — профиль `tls` добавляет Caddy с
автоматическим Let's Encrypt:

```bash
docker compose --profile tls up -d
```

Перед этим отредактируйте `Caddyfile.example` — замените
`relay.example.com` на свой домен и убедитесь, что его A/AAAA-запись
указывает на этот хост, а порты 80/443 открыты. Caddy сам получит и
продлит сертификат; WebSocket-апгрейд (`/relay`) он проксирует прозрачно —
ничего дополнительно настраивать не нужно.

## Relay на нестандартном порту (с переиспользованием готового сертификата)

Если порты 80/443 на VPS уже заняты другими сервисами, relay можно поднять
на любом порту (например, `5525`) и переиспользовать уже выпущенный для
этого хоста сертификат Let's Encrypt. Раз сервис различается портом, а не
именем, relay может жить **на том же доменном имени, что и остальные
сервисы** — тогда существующий сертификат подходит как есть. Если хочется
отдельный поддомен — убедитесь, что сертификат его покрывает (wildcard или
имя в SAN).

Откройте `5525/tcp` в файрволе и выберите один из двух вариантов.

**Вариант А — TLS терминирует уже стоящий на хосте nginx** (проще всего,
если сертификат обслуживает nginx + certbot: продление уже налажено).
В `docker-compose.yml` у сервиса `relay` раскомментируйте
`RELAY_TRUST_PROXY: "1"` и привяжите порт только к localhost
(`"127.0.0.1:9720:9720"`), запустите без профиля `tls`
(`docker compose up -d`) и добавьте server-блок nginx. WebSocket-заголовки
обязательны, таймауты — большие: соединение агент↔relay живёт постоянно:

```nginx
server {
    listen 5525 ssl;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9720;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Продление сертификата дальше работает как раньше (certbot сам перезагружает
nginx).

**Вариант Б — Caddy из комплекта с примонтированными файлами сертификата.**
Перепишите `Caddyfile.example`: сайт на порту 5525, TLS — из файлов, а не
через ACME (явная директива `tls <cert> <key>` отключает автополучение —
Caddy не полезет на занятые 80/443):

```
example.com:5525 {
	tls /certs/live/example.com/fullchain.pem /certs/live/example.com/privkey.pem
	encode zstd gzip
	reverse_proxy relay:9720
}
```

В `docker-compose.yml`: у `relay` раскомментируйте `RELAY_TRUST_PROXY: "1"`
и удалите проброс `9720:9720`; у `caddy` замените порты на `"5525:5525"` и
добавьте том `/etc/letsencrypt:/certs:ro`. Монтировать нужно весь
`/etc/letsencrypt`, а не только `live/` — там символьные ссылки на
`../../archive/`, без родительского каталога они окажутся битыми. Запуск —
`docker compose --profile tls up -d`.

Продление: certbot обновит файлы, но Caddy с явной директивой `tls` сам их
не перечитает. Добавьте deploy-хук
`/etc/letsencrypt/renewal-hooks/deploy/termhub-caddy.sh` (`chmod +x`):

```bash
#!/bin/sh
docker compose -f /path/to/TermHub/docker-compose.yml --profile tls restart caddy
```

Проверка (оба варианта): `curl https://example.com:5525/healthz`, а в
браузере `https://example.com:5525` — веб-интерфейс TermHub с валидным
сертификатом. Дальше во всех адресах появляется порт: `relayUrl` =
`wss://example.com:5525/relay`, пейринг — на `https://example.com:5525`.
Нестандартный порт не мешает ни установке PWA, ни Web Push — важен лишь
валидный HTTPS-сертификат.

## Настройка агента на relay

В `~/.termhub/config.json` должен быть указан `relayUrl` — **полный
ws(s)-адрес, обязательно с путём `/relay`**, например:

```
wss://relay.example.com/relay
```

Проще всего задать его при `termhub setup` (вопрос «Relay URL для доступа
извне»); можно и дописать в конфиг вручную и перезапустить агента. При
успешном подключении в логе агента появится строка
`Relay bridge enabled: wss://...`.

## Пейринг нового устройства

На Mac (агент должен быть запущен):

```bash
npx termhub share
```

Покажет одноразовый код вида `XXXX-YYYY-YYYY-YYYY` и QR-код прямо в
терминале. Код живёт около 5 минут и допускает не больше 3 попыток ввода —
если не успели или ошиблись, сгенерируйте новый тем же `termhub share`.

**С телефона:** откройте PWA по адресу relay (например,
`https://relay.example.com`), нажмите «Добавить по коду» и введите код (или
отсканируйте QR).

> В меню LAN-дашборда есть похожий пункт «Поделиться доступом», но он пока
> помечен «скоро» — код на данный момент генерируется только командой
> `termhub share` на Mac.

**С другого компьютера (CLI):**

```bash
npx termhub pair <код> --relay wss://relay.example.com/relay
```

Дополнительные флаги:

- `--name <имя>` — как это устройство будет называться в списке
  `termhub devices` на Mac (по умолчанию — hostname);
- `--agent-label <ярлык>` — локальное имя агента для команды `connect`
  (по умолчанию — его `agentId`).

После пейринга подключайтесь:

```bash
npx termhub connect                       # если известен ровно один агент
npx termhub connect <ярлык> --session <имя>
```

Работает как ssh: `~.` в начале строки или `Ctrl-]` — отключиться от
сессии.

## Список устройств и отзыв

```bash
npx termhub devices                  # имя, fingerprint, дата добавления
npx termhub revoke <fingerprint|имя>
```

Обе команды работают локально с файлом `~/.termhub/authorized.json` на
Mac — relay в этом не участвует, отозванное устройство просто перестаёт
проходить E2E-хендшейк при следующей попытке подключиться.

## Альтернатива: Tailscale вместо relay

Если Mac и телефон уже в одной сети Tailscale, можно вообще не поднимать
relay: работает обычный LAN-путь, только вместо `.local`-адреса — Tailscale
IP или MagicDNS-имя (`http://<tailscale-host>:7710`). Чтобы получить
настоящий HTTPS (нужен для установки PWA и Web Push, см.
[docs/notifications.ru.md](notifications.ru.md)):

```bash
tailscale cert <ваш-tailscale-hostname>
```

Полученные `.crt`/`.key` пропишите в `~/.termhub/config.json` (поле `tls` —
`setup` его не спрашивает, добавляется вручную):

```json
"tls": { "cert": "/путь/до/<hostname>.crt", "key": "/путь/до/<hostname>.key" }
```

и перезапустите `termhub start`. Дальше открывайте
`https://<tailscale-hostname>:7710`.
