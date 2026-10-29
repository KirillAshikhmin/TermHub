# TermHub relay на HTTPS 443: Caddy или nginx

Инструкция для чистого Ubuntu 24.04 LTS с Docker Engine. Два альтернативных варианта в одном файле:

- **Caddy в Docker** — штатная архитектура проекта с профилем `tls`, автоматический HTTPS. Хостовые TCP 80/443 должны быть свободны.
- **nginx на хосте + relay в Docker** — подходит и для сервера, на котором nginx уже обслуживает другие сайты на 443. Домены разделяются через SNI и `server_name`.

Выполнять **один** вариант. Одновременно привязать Caddy и nginx к одному IP и порту 443 нельзя. Это reverse proxy, а не перенаправление браузера на порт контейнера.

Основа: [KirillAshikhmin/TermHub](https://github.com/KirillAshikhmin/TermHub), проверенный коммит `a8bb4bd55a864584d87dde3f50922a41a199baba`. Инструкция составлена 22.10.2026. При выборе другой версии используйте совместимые версии relay, веб-интерфейса и агентов.

## 1. Адреса и подготовка

Домены `example.com` и указанные ниже IP используются только как вымышленные примеры. Во всех примерах замените:

| Пример | Значение |
|---|---|
| `relay.example.com` | Ваш домен relay |
| `admin@example.com` | Ваша почта для сертификата |
| `203.0.113.10`, `198.51.100.20` | Реальные **внешние исходящие IP** разрешённых клиентов/агентов или VPN |
| `https://www.example.com/images/bg.jpg` | URL вашей публичной картинки для нейтральной страницы |

Примерные IP из документационных диапазонов не дают доступа вашим устройствам: замените их **в обоих местах выбранного варианта до запуска**. Список разрешает и браузеры, и подключения агентов к `/relay`.

Итоговые адреса:

```text
Браузер:                 https://relay.example.com/
Конфиг агента relayUrl:   wss://relay.example.com/relay
Проверка состояния:      https://relay.example.com/healthz
```

У `https` и `wss` без явного порта используется 443. Путь `/relay` обязателен для агента.

1. Создайте DNS A-запись домена на публичный IPv4 сервера. Примеры ниже рассчитаны на IPv4. Не публикуйте AAAA, пока отдельно не настроены IPv6 listener, маршрутизация, firewall и IPv6 allowlist.
2. Откройте TCP 80/443 в firewall хоста и панели провайдера. Порт 80 нужен для HTTP→HTTPS и проверки ACME, а не для публичного доступа к relay без TLS.
3. Если используется UFW, HTTP(S) должен доходить до reverse proxy с любого адреса, чтобы посторонние получали нейтральную страницу. Ограничение relay будет на уровне Caddy/nginx.
4. Оставьте действующие ограничения SSH. Не отключайте firewall и не перезапускайте сетевые службы.
5. Эти конфиги предполагают прямой доступ к серверу, без CDN или дополнительного HTTP-прокси перед ним. Для такого прокси отдельно требуется настройка доверенных адресов; нельзя доверять `X-Forwarded-For` от всего интернета.

Команды установки далее выполняются в root-shell (`sudo -i`). Команды настройки агента — от его обычного пользователя.

```bash
ss -lntp '( sport = :80 or sport = :443 )'
ufw status numbered
```

Если UFW уже активен и этих правил нет:

```bash
ufw allow 80/tcp
ufw allow 443/tcp
```

Не включайте UFW вслепую на удалённом сервере: сначала должно существовать правило для вашего фактического SSH-порта/источника. Docker-публикация портов проходит через отдельные цепочки и может обходить UFW INPUT. Для Caddy проверьте также существующие правила `DOCKER-USER`/FORWARD и ограничения провайдера. Если ранее внедрён `HOSTING-DOCKER`, его список разрешённых Docker-портов должен учитывать TCP 80/443 Caddy. Не сбрасывайте существующую защиту ради этого.

### Docker на новом сервере

Если Docker с Compose/Buildx уже установлен, пропустите установку. На сервере с действующими контейнерами не заменяйте пакеты и не перезапускайте Docker ради этой инструкции.

```bash
apt-get update
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker version
docker compose version
docker buildx version
```

### Исходники

Конфиги развёртывания лежат вне Git checkout, чтобы обновление исходников их не затёрло.

```bash
install -d -m 755 /opt/termhub-relay
git clone https://github.com/KirillAshikhmin/TermHub.git /opt/termhub-relay/source
git -C /opt/termhub-relay/source checkout --detach a8bb4bd55a864584d87dde3f50922a41a199baba
cd /opt/termhub-relay
```

Образ собирается штатным `packages/relay/Dockerfile`: он сам собирает protocol, web и relay. Устанавливать Node.js/npm на хосте relay не нужно. `node-pty` используется агентами, в relay его компиляция отключена штатным Dockerfile.

### Нейтральная страница для посторонних

Страница не содержит названия TermHub или текста об ограничении. В обоих вариантах она возвращается с HTTP 200, включая запросы к `/healthz`, API и WebSocket от запрещённых IP. Соединение WebSocket при этом не устанавливается.

```bash
install -d -m 755 /srv/termhub-cover
cat > /srv/termhub-cover/index.html <<'EOF'
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Example</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #fff; }
    img { display: block; width: 100%; height: 100%; object-fit: cover; }
  </style>
</head>
<body><img src="https://www.example.com/images/bg.jpg" alt=""></body>
</html>
EOF
chmod 644 /srv/termhub-cover/index.html
```

Картинка загружается браузером с главного сайта: её доступность зависит от него. При переносе на другой проект замените URL и название страницы. Такая страница не является гарантией скрытия существования сервиса; доступ защищают IP-фильтр и сопряжение устройств.

## 2. Вариант A — штатный Caddy в Docker

Сохраняем структуру штатного `docker-compose.yml`: сервисы `relay`, `caddy`, профиль `tls` и постоянные тома Caddy. Отличия: убрана публикация 9720, включено доверие к контролируемому proxy, добавлены IP-фильтр, заглушка и ограничение размера логов.

### 2.1. Compose

Создайте `/opt/termhub-relay/compose.yml`:

```yaml
services:
  relay:
    build:
      context: ./source
      dockerfile: packages/relay/Dockerfile
    image: termhub-relay:local
    restart: unless-stopped
    environment:
      PORT: "9720"
      RELAY_TRUST_PROXY: "1"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  caddy:
    image: caddy:2-alpine
    profiles: ["tls"]
    restart: unless-stopped
    depends_on:
      - relay
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - /srv/termhub-cover:/srv/cover:ro
      - caddy_data:/data
      - caddy_config:/config
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  caddy_data:
  caddy_config:
```

Здесь **нет `ports` у relay**: Caddy обращается к `relay:9720` через Compose-сеть. Не объединяйте этот файл со штатным `source/docker-compose.yml`: иначе можно случайно вернуть публичный проброс 9720.

### 2.2. Caddyfile и список доступа

Создайте `/opt/termhub-relay/Caddyfile`, заменив домен, почту и IP:

```caddyfile
{
	email admin@example.com
}

relay.example.com {
	log
	encode zstd gzip

	@allowed remote_ip 203.0.113.10 198.51.100.20
	handle @allowed {
		reverse_proxy relay:9720
	}

	handle {
		root * /srv/cover
		rewrite * /index.html
		header Cache-Control "no-store"
		file_server
	}
}
```

Список доступа редактируется в строке **`@allowed remote_ip`**. Здесь проверяется адрес TCP-клиента, а не присланный им заголовок. `handle` без matcher — нейтральная страница для всех остальных. Caddy автоматически проксирует WebSocket и формирует `X-Forwarded-For`, игнорируя недоверенное значение клиента; отдельные Upgrade-настройки не нужны.

### 2.3. Сборка и запуск

Все команды Compose запускайте из `/opt/termhub-relay` с тем же `-p termhub -f compose.yml`.

```bash
cd /opt/termhub-relay
docker compose -p termhub -f compose.yml --profile tls config --quiet
docker compose -p termhub -f compose.yml --profile tls pull caddy
docker compose -p termhub -f compose.yml --profile tls run --rm --no-deps caddy \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose -p termhub -f compose.yml build --pull relay
docker compose -p termhub -f compose.yml --profile tls up -d
docker compose -p termhub -f compose.yml --profile tls ps
docker compose -p termhub -f compose.yml --profile tls logs --tail 80 caddy relay
```

Caddy сам получает и продлевает сертификат. Certbot для этого варианта не нужен. Тома `caddy_data` и `caddy_config` сохраняйте: не используйте `docker compose down -v`, не удаляйте их при обновлении.

После изменения списка IP/Caddyfile:

```bash
cd /opt/termhub-relay
docker compose -p termhub -f compose.yml --profile tls exec caddy \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose -p termhub -f compose.yml --profile tls exec caddy \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Если редактор заменил файл через rename и bind mount видит старый Caddyfile, пересоздайте **только Caddy**: `docker compose -p termhub -f compose.yml --profile tls up -d --no-deps --force-recreate caddy`.

## 3. Вариант B — nginx на хосте, без Caddy

### 3.1. Compose только для relay

Создайте `/opt/termhub-relay/compose.yml`:

```yaml
services:
  relay:
    build:
      context: ./source
      dockerfile: packages/relay/Dockerfile
    image: termhub-relay:local
    restart: unless-stopped
    environment:
      PORT: "9720"
      RELAY_TRUST_PROXY: "1"
    ports:
      - "127.0.0.1:9720:9720"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

```bash
cd /opt/termhub-relay
docker compose -p termhub -f compose.yml config --quiet
docker compose -p termhub -f compose.yml build --pull relay
docker compose -p termhub -f compose.yml up -d
docker compose -p termhub -f compose.yml ps
curl -fsS http://127.0.0.1:9720/healthz
```

Ожидается `ok`. Снаружи порт 9720 не публикуется; не добавляйте для него разрешение UFW.

### 3.2. nginx и первоначальный выпуск сертификата

Если nginx уже установлен, используйте его. Новый домен должен встречаться в `server_name` только своего виртуального хоста: если это старый алиас основного сайта, сначала удалите **только этот алиас** из прежних блоков 80/443. Сохраните остальные домены, default server и настройки сайтов.

```bash
apt-get update
apt-get install -y nginx certbot
install -d -m 755 /var/lib/letsencrypt/.well-known/acme-challenge
```

Сначала создайте `/etc/nginx/sites-available/termhub-relay` **только с HTTP** — nginx не запустится с HTTPS-конфигом, если файлов сертификата ещё нет:

```nginx
server {
    listen 80;
    server_name relay.example.com;

    location ^~ /.well-known/acme-challenge/ {
        root /var/lib/letsencrypt;
        default_type text/plain;
        try_files $uri =404;
    }

    location / { return 301 https://relay.example.com$request_uri; }
}
```

```bash
ln -s /etc/nginx/sites-available/termhub-relay /etc/nginx/sites-enabled/termhub-relay
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/lib/letsencrypt \
  --cert-name relay.example.com -d relay.example.com \
  --email admin@example.com --agree-tos --non-interactive
```

Если уже есть действующий сертификат с этим доменом в SAN, повторный выпуск не нужен: укажите его существующие `fullchain.pem`/`privkey.pem` на следующем шаге и сохраните действующую схему продления. Например, сертификат основного `example.com` может также содержать `relay.example.com` в SAN.

### 3.3. HTTPS 443, список доступа и заглушка

Сохраните HTTP-блок из предыдущего шага и **добавьте в тот же файл**:

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    access_log /var/log/nginx/termhub.access.log;
    error_log /var/log/nginx/termhub.error.log;

    allow 203.0.113.10;
    allow 198.51.100.20;
    deny all;

    error_page 403 =200 /_cover.html;

    location = /_cover.html {
        internal;
        allow all;
        alias /srv/termhub-cover/index.html;
        default_type text/html;
        charset utf-8;
        add_header Cache-Control "no-store" always;
    }

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:9720;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}
```

Список IP — **`allow` перед `deny all`**. `allow all` разрешает только внутреннюю выдачу статической заглушки, а не доступ к relay. Клиентский `X-Forwarded-For` перезаписывается, чтобы нельзя было подделать источник для relay. Не включайте глобальное доверие произвольным `real_ip_header`/`set_real_ip_from`.

HTTP/2 не обязателен. На уже работающем nginx 1.24 параметры `listen 443` согласуйте с остальными vhost: если там `listen 443 ssl http2;`, используйте ту же форму для нового vhost, не меняя остальные сайты. На чистой установке приведённого `listen 443 ssl;` достаточно.

```bash
nginx -t && systemctl reload nginx
```

Так же применяются последующие изменения allowlist. Используйте reload, а не перезапуск Docker или сетевых служб.

### 3.4. Продление сертификата

Для нового Certbot-развёртывания:

```bash
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
set -eu
/usr/sbin/nginx -t
systemctl reload nginx
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
systemctl enable --now certbot.timer
certbot renew --cert-name relay.example.com --dry-run
```

`--dry-run` проверяет продление, но по умолчанию не запускает deploy-hook. Сам hook проверьте отдельно: `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`. Если такой hook уже есть, используйте его. HTTP ACME-location должен оставаться доступным всем: IP-адреса валидаторов сертификата не входят в ваш allowlist.

## 4. Проверка обоих вариантов

### Разрешённый источник

С реального устройства, чей **выходной IP** входит в allowlist:

```bash
curl --connect-timeout 10 --max-time 15 -fsS https://relay.example.com/healthz
curl --connect-timeout 10 --max-time 15 -fsS https://relay.example.com/api/mode
```

Ожидаются именно `ok` и `{"mode":"relay"}`, а не HTML нейтральной страницы. В браузере должен появиться интерфейс выбора агента. Затем проверьте сопряжение, выбор агента и открытие терминала — одного healthcheck недостаточно.

Проверка Upgrade (доступ без сопряжения должен ограничиться самим WebSocket):

```bash
curl --http1.1 -i --no-buffer --max-time 3 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://relay.example.com/relay
```

Ожидается `101 Switching Protocols`. Последующий timeout curl допустим: тест не ведёт прикладной диалог. Это ещё не проверка E2E-соединения с агентом.

### Запрещённый источник

Из сети, которой нет в списке, откройте `/`, `/healthz`, `/api/mode`, `/relay`: ожидается только нейтральная HTML-страница с кодом 200, без интерфейса relay. Подставленный `X-Forwarded-For` не должен менять результат:

```bash
curl -i -H 'X-Forwarded-For: 203.0.113.10' https://relay.example.com/api/mode
```

Для этой проверки используйте в заголовке свой реально разрешённый IP. Не проверяйте запрет только с разрешённой сети. Внешний запрос к `PUBLIC_SERVER_IP:9720` не должен устанавливать соединение ни в одном варианте.

### Где смотреть фактический IP

Caddy:

```bash
cd /opt/termhub-relay
docker compose -p termhub -f compose.yml --profile tls logs --tail 60 caddy
```

nginx:

```bash
tail -n 60 /var/log/nginx/termhub.access.log
tail -n 30 /var/log/nginx/termhub.error.log
```

IP в настройке VPN не гарантирует, что конкретный запрос идёт через него. Split tunneling, исключение адреса самого VPN-сервера, mihomo и мобильная сеть могут дать другой источник. Ориентируйтесь на адрес в логах reverse proxy. Не добавляйте всю Docker-подсеть или весь интернет для обхода непонятного отказа.

## 5. Подключение агентов Mac и Linux

**Версии должны быть совместимы.** В проверенном развёртывании обе машины и relay собраны из `a8bb4bd`. Старый агент `636f9f4` регистрируется и принимает pairing, но новый веб-клиент возвращает пользователя к выбору агента: старый агент не подписывает `hello-ok`, как требует новый протокол.

На машине агента, от его пользователя, измените **только поле** в `~/.termhub/config.json`, сохранив остальные настройки и ключи:

```json
"relayUrl": "wss://relay.example.com/relay"
```

Это фрагмент JSON, а не замена всего файла. Сделайте резервную копию перед редактированием. `identity`/`authorized.json` не удаляйте.

Перезапуск уже установленной службы на macOS:

```bash
launchctl kickstart -k "gui/$(id -u)/dev.termhub.agent"
tail -n 20 ~/Library/Logs/termhub.log
```

На Linux:

```bash
systemctl --user restart dev.termhub.agent.service
journalctl --user -u dev.termhub.agent.service -n 30 --no-pager
```

В логах должны появиться новый relay URL и `registered as ...`. Сначала разрешите выходной IP агента в reverse proxy, иначе WebSocket получит нейтральную страницу и не подключится.

Для новой машины агента: установите Node.js ≥22 и tmux, клонируйте проект с выбранным совместимым коммитом, выполните `npm ci`, `npm run build`, затем `npx termhub setup` и `npx termhub service install` из checkout. Не запускайте агент от root. Подробности — [README проекта](https://github.com/KirillAshikhmin/TermHub/blob/a8bb4bd55a864584d87dde3f50922a41a199baba/README.md).

### Особенность Linux-агента в a8bb4bd

Эта версия требует `spawn-helper`, но node-pty 1.1.0 штатно собирает его только для macOS. На Linux перед запуском агента выполните из корня его checkout:

```bash
# Пакеты компиляции устанавливаются администратором один раз:
sudo apt-get install -y build-essential python3
# После npm ci, от обычного пользователя агента:
c++ -O2 -o node_modules/node-pty/build/Release/spawn-helper \
  node_modules/node-pty/src/unix/spawn-helper.cc
```

`node_modules/node-pty/build/Release/pty.node` должен быть собран установкой node-pty; если npm запретил install scripts, сначала разрешите сборку этой зависимости согласно своей политике npm. Ручной helper не заменяет сам нативный модуль.

`npm ci` удаляет helper, поэтому сборку нужно повторять после каждой чистой установки зависимостей. Для этого проверенного коммита можно сохранить следующий `scripts.postinstall` в **package.json Linux-агента**:

```json
"postinstall": "(chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true) && if [ \"$(uname -s)\" = \"Linux\" ]; then c++ -O2 -o node_modules/node-pty/build/Release/spawn-helper node_modules/node-pty/src/unix/spawn-helper.cc; fi"
```

Это локальная поправка до upstream-исправления; сохраняйте её при обновлении исходников. К серверу relay эта проблема не относится. Если ваша версия уже исправлена, дополнительная сборка не нужна.

### Pairing и PWA

На каждой машине агента из checkout:

```bash
npx termhub share
```

В браузере откройте `https://relay.example.com/`, нажмите «Добавить по коду», введите одноразовый код, выберите агент и откройте терминал. Повторите для второй машины.

При смене домена или порта меняется origin: прежнее браузерное сопряжение автоматически не переносится. Новую иконку iPhone устанавливайте с нового HTTPS-адреса после успешного подключения. Обновление агента с сохранением его ключей само по себе не требует нового pairing.

## 6. Обновление и откат relay

Из `/opt/termhub-relay` сохраните конфиги и предыдущий образ перед изменениями:

```bash
cd /opt/termhub-relay
cp -a compose.yml compose.yml.before-update
git -C source rev-parse HEAD > revision.before-update
docker tag termhub-relay:local termhub-relay:before-update
```

Также сохраните Caddyfile и тома Caddy **или** vhost nginx, сертификаты/настройки Certbot; `/srv/termhub-cover` нужен в обоих вариантах. Защищайте резервные копии приватных ключей сертификатов.

Затем fetch/checkout выбранного проверенного коммита в `source`, согласуйте версии агентов, пересоберите и замените только relay:

```bash
cd /opt/termhub-relay
docker compose -p termhub -f compose.yml build --pull relay
docker compose -p termhub -f compose.yml up -d --no-deps relay
docker compose -p termhub -f compose.yml logs --tail 50 relay
```

Команды подходят обоим вариантам: профиль `tls` для обновления только сервиса `relay` не нужен. Не перезапускайте Docker daemon, nginx, Caddy или VPN-контейнеры ради обновления relay. Активные подключения relay оборвутся при замене контейнера; агенты должны переподключиться.

Откат образа:

```bash
cd /opt/termhub-relay
docker tag termhub-relay:before-update termhub-relay:local
docker compose -p termhub -f compose.yml up -d --no-deps --no-build --force-recreate relay
```

При следующей сборке будет использован текущий checkout, поэтому для полного отката восстановите также сохранённую ревизию исходников. Не откатывайте одну сторону протокола на несовместимую версию: согласуйте web/relay и агентов.

Relay не хранит ключи агентов: их резервные копии делаются на самих машинах в `~/.termhub`. In-memory комнаты pairing и текущие соединения теряются при перезапуске relay.

## 7. Где находятся настройки

| Что | Путь или пример адреса |
|---|---|
| Веб / агент | `https://relay.example.com/` / `wss://relay.example.com/relay` |
| Compose выбранного варианта | `/opt/termhub-relay/compose.yml` |
| Исходники | `/opt/termhub-relay/source` |
| Caddy / IP allowlist | `/opt/termhub-relay/Caddyfile`, строка `@allowed remote_ip` |
| nginx / IP allowlist | `/etc/nginx/sites-available/termhub-relay`, строки `allow` перед `deny all` |
| Нейтральная HTML-страница | `/srv/termhub-cover/index.html` |
| Картинка | `https://www.example.com/images/bg.jpg` — заменить своим URL |
| Сертификат nginx/Certbot | `/etc/letsencrypt/live/relay.example.com/` |
| Сертификаты Caddy | Постоянный Docker-том `termhub_caddy_data` |
| Конфиг агента | `~/.termhub/config.json` на каждой машине агента |

Пример allowlist: `203.0.113.10` и `198.51.100.20`. Это документальные адреса, их нужно заменить реальными исходящими IP. Сам адрес сервера не разрешает автоматически клиентов VPN: учитывается фактический источник запроса.

Для чистой схемы достаточно TCP 80/443. При переносе с другого порта закрывайте старый вход после перевода всех агентов и браузеров.

## Источники и границы проверки

- [Штатный Compose TermHub](https://github.com/KirillAshikhmin/TermHub/blob/a8bb4bd55a864584d87dde3f50922a41a199baba/docker-compose.yml), [Caddyfile.example](https://github.com/KirillAshikhmin/TermHub/blob/a8bb4bd55a864584d87dde3f50922a41a199baba/Caddyfile.example), [Dockerfile relay](https://github.com/KirillAshikhmin/TermHub/blob/a8bb4bd55a864584d87dde3f50922a41a199baba/packages/relay/Dockerfile).
- [Docker Engine на Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
- [Caddy remote_ip](https://caddyserver.com/docs/caddyfile/matchers#remote-ip), [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [automatic HTTPS](https://caddyserver.com/docs/automatic-https).
- [nginx WebSocket](https://nginx.org/en/docs/http/websocket.html), [allow/deny](https://nginx.org/en/docs/http/ngx_http_access_module.html), [error_page](https://nginx.org/en/docs/http/ngx_http_core_module.html#error_page).
- [Certbot webroot и renewal hooks](https://eff-certbot.readthedocs.io/en/stable/using.html).

Рабочая схема nginx/443, allowlist, заглушка и подключение обновлённых Mac/Linux агентов проверены на действующей установке. Команды нового выпуска сертификата требуют вашего DNS и реального сервера; в рамках подготовки документа production не перенастраивается.

Проверка примеров документа: оба Compose-файла прошли `docker compose config`; Caddyfile — `caddy validate` (образ `caddy:2-alpine`); полный nginx-конфиг — `nginx -t` на nginx 1.24 с временным тестовым сертификатом. Выпуск публичного сертификата Caddy на новом сервере в эту проверку не входил.
