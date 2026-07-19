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

> The LAN dashboard menu has a similar "Share access" item, but for now it is
> marked "soon" — at the moment the code is generated only by the
> `termhub share` command on the Mac.

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
