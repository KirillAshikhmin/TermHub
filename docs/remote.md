# Remote access (relay)

**English** · [Русский](remote.ru.md)

A local network isn't always enough — sometimes you need to check in on a
session while you're away from home. For that, TermHub has its own relay
server.

## What is a relay

A relay is a thin switchboard server (Node + `ws`, deployed via Docker). It
**stores nothing that belongs to the user**: it keeps only an in-memory list of
connected agents and pairing rooms (with a TTL). The traffic payload is fully
E2E-encrypted (see [docs/security.md](security.md)): the relay sees only who
connected to whom, the timings, and the data volume, but it cannot read a
single byte of terminal output. The agent itself opens an outbound secure
connection to the relay — so not a single inbound port is opened on the Mac.

## Deploying the relay

The repository root already contains a `docker-compose.yml`:

```bash
docker compose up -d
```

This brings up only `relay` on port `9720` (for the case where you terminate
TLS yourself — your own reverse proxy or tunnel).

If you need a ready-made public HTTPS domain, the `tls` profile adds Caddy with
automatic Let's Encrypt:

```bash
docker compose --profile tls up -d
```

Before doing that, edit `Caddyfile.example` — replace `relay.example.com` with
your own domain and make sure its A/AAAA record points to this host and that
ports 80/443 are open. Caddy will obtain and renew the certificate itself; it
proxies the WebSocket upgrade (`/relay`) transparently — nothing extra needs to
be configured.

## Relay on a non-standard port (reusing an existing certificate)

If ports 80/443 on the VPS are already taken by other services, the relay can
live on any port (say, `5525`) and reuse a Let's Encrypt certificate that is
already issued for this host. Since the service is distinguished by port rather
than by name, the relay can use **the same domain name as the other services** —
then the existing certificate fits as is. If you want a separate subdomain,
make sure the certificate covers it (wildcard or a SAN entry).

Open `5525/tcp` in the firewall and pick one of the two options.

**Option A — TLS is terminated by the nginx already on the host** (simplest if
the certificate is managed by nginx + certbot: renewal is already wired up).
In `docker-compose.yml` uncomment `RELAY_TRUST_PROXY: "1"` for the `relay`
service and bind its port to localhost only (`"127.0.0.1:9720:9720"`), start
without the `tls` profile (`docker compose up -d`), and add an nginx server
block. The WebSocket headers are mandatory and the timeouts must be long — the
agent↔relay connection stays open permanently:

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

Note `$remote_addr`, not `$proxy_add_x_forwarded_for`: the latter *appends* the
observed address to whatever the client sent, so the header arrives partly
attacker-controlled. The relay reads the rightmost hop precisely for that reason,
but replacing the header instead of appending to it leaves nothing to get wrong —
the rate limit is the only anti-abuse control on the public `/relay` endpoint.

Certificate renewal keeps working as before (certbot reloads nginx itself).

**Option B — the bundled Caddy with the certificate files mounted in.**
Rewrite `Caddyfile.example`: a site on port 5525, TLS from files rather than
ACME (an explicit `tls <cert> <key>` disables automatic issuance — Caddy won't
touch the occupied ports 80/443):

```
example.com:5525 {
	tls /certs/live/example.com/fullchain.pem /certs/live/example.com/privkey.pem
	encode zstd gzip
	reverse_proxy relay:9720
}
```

In `docker-compose.yml`: for `relay` uncomment `RELAY_TRUST_PROXY: "1"` and
remove the `9720:9720` publish; for `caddy` replace the ports with
`"5525:5525"` and add a volume `/etc/letsencrypt:/certs:ro`. Mount the whole
`/etc/letsencrypt`, not just `live/` — it contains symlinks into
`../../archive/` that break without the parent directory. Start with
`docker compose --profile tls up -d`.

Renewal: certbot updates the files, but Caddy with an explicit `tls` directive
won't re-read them by itself. Add a deploy hook
`/etc/letsencrypt/renewal-hooks/deploy/termhub-caddy.sh` (`chmod +x`):

```bash
#!/bin/sh
docker compose -f /path/to/TermHub/docker-compose.yml --profile tls restart caddy
```

Verify (either option): `curl https://example.com:5525/healthz`, and in the
browser `https://example.com:5525` shows the TermHub web UI with a valid
certificate. Everywhere below, addresses then include the port: `relayUrl` =
`wss://example.com:5525/relay`, pairing at `https://example.com:5525`. A
non-standard port is no obstacle to installing the PWA or to Web Push — only a
valid HTTPS certificate matters.

## Configuring the agent for the relay

`~/.termhub/config.json` must specify `relayUrl` — **the full ws(s) address,
which must include the `/relay` path** — for example:

```
wss://relay.example.com/relay
```

The easiest way to set it is during `termhub setup` (the "Relay URL for external
access" prompt); alternatively you can add it to the config manually and restart
the agent. On a successful connection, the agent log shows the line
`Relay bridge enabled: wss://...`.

## A relay on the agent's own machine (no VPS)

If the machine has a public address and the router can forward a port, the relay does not
have to live on a VPS: the agent starts it itself. What faces the internet is then the
relay, not the password login — access is still granted by pairing, every device has its
own key, revocation is per device, and the traffic is end-to-end encrypted. The password
login stays on the local network.

It is switched on by one field in `~/.termhub/config.json` (absent by default, and nothing
changes without it):

```json
"localRelay": { "port": 7720 }
```

| Field | Meaning |
|---|---|
| `port` | Relay port. Must differ from the agent port. |
| `host` | Bind address, `0.0.0.0` by default. |
| `tls` | `{ "cert": path, "key": path }` — the relay certificate. Absent — the agent's certificate (`tls`) is used. `null` — plain HTTP. |

Restart the agent after the change. What happens:

- the relay runs as a separate process next to the agent and is restarted if it crashes;
  it stops together with the agent. Its log goes to the agent log with the `[relay]` prefix;
- the agent connects to it over loopback with a second bridge. `relayUrl`, if set, keeps
  working as before — both relays are active at once;
- `termhub share` and "Share" issue one code for both relays: the device enters it on the
  page it opened. A paired device is bound to the page address, so the phone pairs again
  for a new address (each address has its own device key);
- relay settings from the agent's environment (`RELAY_CHUNKED`, `RELAY_CLIENT_TRANSPORT`,
  `RTC_PORT_RANGE`, `RTC_PUBLIC_IP`) apply to the local relay too.

Router forwarding: any external port (443 is fine) to `localRelay.port` on the agent's
machine. Do not forward the agent's own port (the password login).

**Certificate.** The browser needs HTTPS with a certificate for the name you open the page
by: point a domain at the public address, issue a certificate for it (Let's Encrypt) and
put the paths into `localRelay.tls`. The certificate is read when the relay starts —
restart the agent after renewal. Without TLS (`"tls": null`, e.g. on port 80) the page
opens, but the application code travels in clear text: anyone on the path can replace it
and take the device key. Service worker and PWA install do not work without HTTPS either.
Plain HTTP is for testing only.

The local relay state is shown in the connection details window ("Local relay" row) and in
`/api/diag` (`localRelay`).

## Networks where the provider throttles each connection

If the relay page opens as a blank screen and the agent keeps losing its link although the
server looks healthy, there may be a filter on the path that lets through about 25 packets per
connection and then goes silent. To check:

```bash
curl -m 20 -o /dev/null -w '%{size_download}\n' https://relay.example.com/assets/<bundle name>.js
```

If the download freezes at 14–17 KB, that is it. The workarounds for the browser (chunked
bundle, WebRTC, short requests) and for the agent (disguise, own tunnel) are opt-in; how they
work and how to set them up is in a separate document: [throttling.md](throttling.md).

## Pairing a new device

On the Mac (the agent must be running):

```bash
npx termhub share
```

This shows a one-time code of the form `XXXX-YYYY-YYYY-YYYY` and a QR code right
there in the terminal. The code lives for about 5 minutes and allows at most 3
entry attempts — if you run out of time or make a mistake, generate a new one
with the same `termhub share`.

**From a phone:** open the PWA at the relay address (for example,
`https://relay.example.com`), tap "Add by code" and enter the code (or scan the
QR).

> The same can be done from the web UI: the "Share access" item in the dashboard
> menu issues a code and can optionally limit the guest to a single session
> (view-only / file access) — see "Guest access" in `security.md`.

**From another computer (CLI):**

```bash
npx termhub pair <code> --relay wss://relay.example.com/relay
```

Additional flags:

- `--name <name>` — the name this device will have in the `termhub devices` list
  on the Mac (defaults to the hostname);
- `--agent-label <label>` — a local name for the agent used by the `connect`
  command (defaults to its `agentId`).

After pairing, connect:

```bash
npx termhub connect                       # if exactly one agent is known
npx termhub connect <label> --session <name>
```

It works like ssh: `~.` at the start of a line, or `Ctrl-]`, disconnects from
the session.

## Listing and revoking devices

```bash
npx termhub devices                  # name, fingerprint, date added
npx termhub revoke <fingerprint|name>
```

Both commands operate locally on the `~/.termhub/authorized.json` file on the
Mac — the relay is not involved; a revoked device simply stops passing the E2E
handshake on its next connection attempt.

## Alternative: Tailscale instead of a relay

If the Mac and the phone are already on the same Tailscale network, you don't
need to run a relay at all: the ordinary LAN path works, except that instead of
a `.local` address you use a Tailscale IP or a MagicDNS name
(`http://<tailscale-host>:7710`). To get real HTTPS (required for installing the
PWA and for Web Push, see [docs/notifications.md](notifications.md)):

```bash
tailscale cert <your-tailscale-hostname>
```

Add the resulting `.crt`/`.key` to `~/.termhub/config.json` (the `tls` field —
`setup` doesn't ask for it, so add it manually):

```json
"tls": { "cert": "/path/to/<hostname>.crt", "key": "/path/to/<hostname>.key" }
```

then restart `termhub start`. After that, open
`https://<tailscale-hostname>:7710`.
