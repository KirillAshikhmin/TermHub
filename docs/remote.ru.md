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
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Обратите внимание: `$remote_addr`, а не `$proxy_add_x_forwarded_for`. Второй
*дописывает* наблюдённый адрес к тому, что прислал клиент, — заголовок приходит
частично подконтрольным атакующему. Relay именно поэтому читает крайний правый
хоп, но замена заголовка вместо дописывания не оставляет места для ошибки:
rate-limit — единственная защита от злоупотреблений на публичном `/relay`.

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

## Сети, где провайдер душит соединение

Признак: страница relay открывается белым экраном (HTML приходит, бандл виснет), агент
то и дело теряет связь, а с сервера при этом всё в порядке. Так ведёт себя фильтр, который
пропускает в каждом соединении около 25 пакетов от сервера и дальше молчит. Проверка:

```bash
curl -m 20 -o /dev/null -w '%{size_download}\n' https://relay.example.com/assets/<имя бандла>.js
```

Если скачивание замирает на 14–17 КБ — это оно. Обходов три, все включаются настройкой
(разбор и замеры — `docs/adr/0034-throttled-networks-short-flows-and-disguise.md`).

**1. Браузер: бандл кусками и транспорт короткими запросами.** В окружении relay:

```yaml
environment:
  RELAY_CHUNKED: "1"                # бандл кусками по 8 КБ, собирает service worker
  RELAY_CLIENT_TRANSPORT: "poll"    # вместо WebSocket — короткие HTTP-запросы
```

и в Caddy — только HTTP/1.1 и закрытие соединения после каждого ответа (готовый блок
закомментирован в `Caddyfile.example`). Без этого браузер пустит все запросы одним
соединением, и оно умрёт. На отдельном устройстве транспорт можно выбрать вручную:
`localStorage['termhub.relayTransport'] = 'poll'` (или `'ws'`, `'rtc'`).

**2. Агент и CLI: маскировка.** Фильтр решает по первому пакету клиента и пропускает
соединения, начинающиеся как SSH, RDP или DNS. Relay открывает порт, который срезает такую
преамбулу:

```yaml
environment:
  DISGUISE_PORT: "9444"
  DISGUISE_UPSTREAM: "caddy:443"    # куда отдавать поток после преамбулы (TLS-прокси)
ports:
  - "9444:9444"
```

а в `~/.termhub/config.json` агента:

```json
"relayConnect": "relay.example.com:9444",
"relayDisguise": "ssh"
```

`relayUrl` остаётся прежним: из него берутся имя для TLS и путь. Значения `relayDisguise` —
`ssh`, `rdp`, `dns`. Для CLI-клиента на другой машине то же задаётся переменными
`TERMHUB_RELAY_CONNECT` и `TERMHUB_RELAY_DISGUISE`.

**3. Агент и CLI: без лишнего порта.** Либо короткие запросы — `"relayTransport": "poll"`
(`TERMHUB_RELAY_TRANSPORT=poll`), медленнее, но не требует ничего на сервере, кроме пункта 1;
либо свой туннель: `ssh -N -L 19443:127.0.0.1:443 user@relay.example.com` и
`"relayConnect": "127.0.0.1:19443"` без маскировки.

**4. Браузер: WebRTC вместо коротких запросов.** Настоящий долгий поток: эхо быстрее, чем у
коротких запросов. Нужен UDP до relay:

```yaml
environment:
  RELAY_CLIENT_TRANSPORT: "rtc"     # не открылся канал — браузер сам откатится на poll
  RTC_PORT_RANGE: "9450-9457"       # по порту на одновременное соединение
  RTC_PUBLIC_IP: "203.0.113.10"     # внешний адрес, если relay за NAT (Docker)
ports:
  - "9450-9457:9450-9457/udp"
```

В логе агента способ виден в строке запуска:
`Relay bridge enabled: wss://… (websocket, disguised as ssh, via relay.example.com:9444)`.

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

> То же самое можно сделать прямо из веба: пункт «Поделиться доступом» в меню
> дашборда выдаёт код и, при желании, ограничивает гостя одной сессией
> (только просмотр / доступ к файлам) — см. «Гостевой доступ» в `security.ru.md`.

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
