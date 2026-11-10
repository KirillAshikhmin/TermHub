# Networks where the provider throttles each connection

**English** · [Русский](throttling.ru.md)

This document covers one specific kind of blocking and the ways around it. All of them are off
by default and opt-in; on an ordinary network you need none of this. Why the design is what it
is, and what was rejected, is in
[ADR 0034](adr/0034-throttled-networks-short-flows-and-disguise.md) (Russian).

## What it looks like

- The relay page opens as a blank screen: the HTML arrives, the app bundle hangs.
- The agent keeps losing its link to the relay although the server looks healthy.
- Any large download from the server freezes at 14–35 KB and stays silent instead of failing.

One command to check (use your address and the bundle name from the page source):

```bash
curl -m 20 -o /dev/null -w '%{size_download}\n' https://relay.example.com/assets/<bundle name>.js
```

If the number stops at 14–17 thousand, this is it.

## How the filter works

The filter counts packets in each individual connection. About 25 packets from the server get
through (including the connection-setup reply and bare acknowledgements), then the stream goes
silent without a reset. That explains every observed number:

| What the connection carries | Where it stops |
|---|---|
| HTTPS (TLS eats part of the budget) | 14–17 KB |
| plain HTTP, arbitrary TCP | 34–36 KB |
| small messages, like a terminal | exactly at the 25th |
| UDP, including HTTP/3 | 24 packets |
| upload to the server | ~146 KB (the server runs out of acknowledgements) |

The port does not matter, nor does the TLS server name (SNI) or the TLS version. But the filter
has two properties every workaround relies on.

**The budget is per connection, not per address.** Each new connection gets a fresh budget and
there is no penalty for connection rate: 300 connections of 8 KB over 12 threads carry 2.4 MB
in 4 seconds. So volume can travel as many short connections.

**The client's first packet decides the connection's fate.** If a connection starts like one of
the "allowed" protocols, it is let through entirely, whatever follows — TLS included:

| How the connection starts | What is recognised |
|---|---|
| SSH | the client banner `SSH-2.0-…` plus its KEXINIT packet (the banner alone is not enough) |
| RDP | the 19 bytes of an X.224 request |
| DNS over TCP | a query with a two-byte length |
| STUN (UDP) | first packet is a binding request; this is how WebRTC starts |
| DNS over UDP | first packet is a query |

The server's replies are not inspected. These do not help: WireGuard, QUIC, OpenVPN, bare DTLS,
mail protocols, SOCKS, WebSocket, BitTorrent and a dozen more that were tested.

## The workarounds

| Workaround | For | Speed | Keystroke echo | Needed on the server |
|---|---|---|---|---|
| Chunked bundle | browser (page load) | 715 KB in 0.8 s | — | relay and proxy settings |
| WebRTC | browser | ~1.3 MB/s | ~80 ms | a UDP port range |
| Short requests | browser, agent, CLI | ~96 KB/s | ~280 ms | relay and proxy settings |
| Disguise | agent, CLI | 3+ MB/s | ~100 ms | one TCP port |
| Own tunnel | agent, CLI | 2–3.7 MB/s | 70–130 ms | SSH access |

The numbers were measured through a real throttled path. The browser needs the chunked bundle
plus one of the two transports; the agent and CLI need disguise, a tunnel or short requests.

### Chunked bundle

The relay compresses a file and serves it in 8 KB chunks (`/_c/<index>/<path>`), each over its
own connection. The service worker fetches chunks in parallel, joins and decompresses them, and
hands the page an ordinary response at the ordinary address — so lazy parts of the app, styles
and everything else travel the same way with no change to the app itself.

On the first visit there is no service worker yet. For that the relay rewrites `index.html`:
instead of direct links to the bundle it carries a small loader, `boot.js`. The loader registers
the service worker, waits until it answers the `/__sw-chunked` probe, and only then attaches the
bundle.

Limitation: without a service worker (Firefox private windows, in-app browsers) the loader
attaches the bundle directly after 10 seconds, and on a throttled network it will not arrive.

### WebRTC

A WebRTC connection starts with the client's STUN packet, and the filter lets such a UDP flow
through entirely. The browser gets a real long-lived channel (DataChannel): the latency is one
round trip to the server rather than a connection setup per keystroke.

The two sides agree with a single short request, `POST /relay/rtc`. The relay has a known public
address and never dials out — it only answers the client's checks; the client's addresses are
not sent at all. If the channel does not open within 7 seconds (UDP is closed on this network),
the browser switches to short requests for 10 minutes and then tries again.

### Short requests

A "socket" with the WebSocket interface on the outside, where every message travels as its own
HTTP request over a fresh connection: up is `POST /relay/up`, down is several long
`GET /relay/down` requests with chunk numbers (the client keeps them open in advance, so data
from the server arrives without waiting for a new connection). Chunks are up to 8 KB down and
16 KB up.

This is the slowest but least demanding way: it works wherever the page itself opens and needs
neither UDP nor extra ports.

### Disguise

Before TLS, the agent and CLI send the beginning of an "allowed" protocol — SSH, RDP or DNS — as
the first packet. The relay strips that preface on a dedicated port and passes the rest of the
stream on to its normal entrance. What flows is a real WebSocket over TLS, at full speed.

The browser cannot take this path: it does not choose the first bytes of a connection.

### Own tunnel

Since real SSH is left alone by the filter, the agent can reach the relay through ordinary
`ssh -L` port forwarding. It needs no support on the relay side, but the agent now depends on a
separate process: if the tunnel dies, so does the link.

## Setup

The steps below assume the `docker-compose.yml` layout from the repository: the relay behind
Caddy. Replace `relay.example.com` and `203.0.113.10` with your own values.

### 1. Proxy: HTTP/1.1 and connection close

Required for the chunked bundle and for short requests. In HTTP/2 every request shares one
connection, which dies on the third; so use HTTP/1.1 only and close the connection after every
response except WebSocket. In the `Caddyfile`:

```
{
	servers {
		protocols h1
	}
}

relay.example.com {
	encode zstd gzip
	@plain not header Connection *pgrade*
	header @plain Connection close
	reverse_proxy relay:9720
}
```

The proxy must set the header: the one the relay itself sends is stripped by the proxy, as HTTP
requires.

### 2. Relay: environment and ports

```yaml
services:
  relay:
    environment:
      RELAY_CHUNKED: "1"                # chunked bundle
      RELAY_CLIENT_TRANSPORT: "rtc"     # what to offer the browser: ws | poll | rtc
      RTC_PORT_RANGE: "9450-9457"       # WebRTC: one port per simultaneous connection
      RTC_PUBLIC_IP: "203.0.113.10"     # public address when the relay is behind NAT (Docker)
      DISGUISE_PORT: "9444"             # disguise port for the agent and CLI
      DISGUISE_UPSTREAM: "caddy:443"    # where the stream goes after the preface
    ports:
      - "9450-9457:9450-9457/udp"
      - "9444:9444"
```

| Variable | What it does |
|---|---|
| `RELAY_CHUNKED=1` | chunked bundle serving and the loader in `index.html` |
| `RELAY_CLIENT_TRANSPORT` | the hint for the browser: `ws` (default), `poll`, `rtc`. With `rtc` but no `RTC_PORT_RANGE` the relay honestly hints `poll` |
| `RTC_PORT_RANGE` | enables WebRTC; the two bounds must differ |
| `RTC_PUBLIC_IP` | the address the relay announces to the client; without it, the relay's own interface addresses |
| `DISGUISE_PORT` | enables the disguise port |
| `DISGUISE_UPSTREAM` | `host:port` behind the disguise port; defaults to the relay itself, but then the client arrives without TLS — behind a proxy, point it at the proxy |

Memory: with WebRTC the relay container needs 256 MB (at 128 MB it came close to the limit
under load).

### 3. Browser

Nothing to configure: the transport comes from the relay's hint. A single device can override
it in the browser console:

```js
localStorage['termhub.relayTransport'] = 'poll'   // or 'rtc', 'ws'; removeItem restores the relay's hint
```

After enabling chunked mode, reload an already open page once.

### 4. Agent and CLI

The way is set in the agent's `~/.termhub/config.json`; `relayUrl` stays as it was — it supplies
the TLS name and the path.

**Disguise:**

```json
"relayConnect": "relay.example.com:9444",
"relayDisguise": "ssh"
```

`relayDisguise` is `ssh`, `rdp` or `dns`.

**Short requests** (nothing needed on the server beyond step 1):

```json
"relayTransport": "poll"
```

**Own tunnel.** Create a dedicated key and on the server allow it to forward a single port only
— a line in `authorized_keys`:

```
restrict,port-forwarding,permitopen="127.0.0.1:443",command="/bin/false" ssh-ed25519 AAAA… termhub-tunnel
```

`command="/bin/false"` is mandatory: `restrict` alone forbids a terminal and forwarding but not
command execution. Then the tunnel and the agent config:

```bash
ssh -N -i ~/.ssh/termhub_tunnel -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
    -L 127.0.0.1:19443:127.0.0.1:443 user@relay.example.com
```

```json
"relayConnect": "127.0.0.1:19443"
```

The tunnel has to stay up — run it as a service (a LaunchAgent with `KeepAlive` on macOS, a unit
with `Restart=always` under systemd).

A CLI client on another machine has no agent config — set the same through the
`TERMHUB_RELAY_CONNECT`, `TERMHUB_RELAY_DISGUISE` and `TERMHUB_RELAY_TRANSPORT` environment
variables; they take precedence over the config.

## How to verify

- `curl https://relay.example.com/api/mode` → `{"mode":"relay","chunked":true,"transport":"rtc"}`.
- The page source carries `<script src="./boot.js?v=…" data-js="…">` instead of a bundle link.
- The relay log at startup: `disguise port :9444 → caddy:443`.
- The agent log shows the chosen way in its startup line:
  `Relay bridge enabled: wss://… (websocket, disguised as ssh, via relay.example.com:9444)`.
- If the agent loses its link over a tunnel, check `nc -z 127.0.0.1 19443` first.

## What to expect

- Disguise relies on the filter trusting the first packet. If that rule changes, short requests
  and WebRTC remain — they do not depend on it.
- WebRTC needs UDP from the client to the relay; where it is closed the browser falls back to
  short requests by itself.
- Short requests are slow for large files (about 100 KB/s each way); a terminal has plenty.
- The relay stays zero-knowledge in every mode: only the delivery changes, end-to-end encryption
  and the handshake are the same ([security.md](security.md)).
