# TermHub

**English** · [Русский](README.ru.md)

**Access your Mac's tmux terminal sessions — from your phone or a browser.**
Watch progress, work in a full terminal, browse files and commit — locally over
Wi-Fi or remotely through your own end-to-end encrypted relay. Meanwhile, **not a
single inbound port is opened on the Mac**.

TermHub is built first and foremost for working with [Claude Code](https://claude.com/claude-code)
and other TUI agents running in tmux (answer the agent's questions from your phone,
approve edits, top up prompts), but it is a plain remote terminal — good for any
console work.

> Status: `0.1.0`, alpha. The agent runs on macOS and Linux.

---

## Features

- **Session dashboard** — list of tmux sessions, create/kill, "running" / 🔔 "waiting
  for input" indicators (read from the window title, the way Claude Code paints it).
- **Full terminal** in the browser (xterm.js): a quick-keys bar tuned for the mobile
  keyboard, a **compose bar** — a native input field with a live mirror of the terminal
  line (swipe/autocorrect/Claude suggestions/Tab/history), clickable paths and links.
- **File browser** — view/download files, preview images/video, simple text editing,
  a context menu (copy/move/rename/delete/properties), "Open in NotAText".
- **Repository** — git / svn / mercurial: commit log, diff, commit with file selection,
  pull/push, branches (switch/create/delete).
- **Session workspace** — Terminal / Files / Repository of one session are live at the
  same time; switching tabs never tears down the terminal or loses state.
- **PWA** — installs to the home screen, runs like an app; ru/en theme.
- **Notifications** — sound, local Notifications and Web Push (when the tab is closed).
- **Remote access** through your own relay: an outbound E2E connection, zero-knowledge relay.
- **CLI client** (`termhub connect`) — a terminal from another computer, like ssh.
- **Diagnostics** — a web status page and the `termhub doctor` command.

---

## How it works

```
                     ┌──────────────────────── your Mac ───────────────────────┐
   LOCAL NETWORK      │                                                          │
   ┌──────────┐ HTTPS │  ┌───────────────┐   pty    ┌──────────────────────────┐│
   │  phone   │  + WS │  │  @termhub/    │◀────────▶│  tmux (socket -L termhub) ││
   │  (PWA)   │───────┼─▶│    agent      │          │   ├ main                  ││
   └──────────┘       │  │ (Node, HTTP/  │          │   ├ project-a  ├ claude … ││
                      │  │  WS server)   │          │   └ work sessions         ││
                      │  └───────┬───────┘          └──────────────────────────┘│
                      │          │ outbound WSS + end-to-end encryption          │
                      └──────────┼───────────────────────────────────────────────┘
                                 │        (no inbound ports opened on the Mac)
                    ┌────────────▼─────────────┐
   OFF-NETWORK      │   relay  (VPS, Docker)   │   zero-knowledge switch:
   ┌──────────┐ E2E │   @termhub/relay         │   sees who ↔ whom, but
   │  phone   │────▶│   (WS switch + static)   │   CANNOT read the content
   │  / CLI   │     └──────────────────────────┘
   └──────────┘
```

- **The agent** is a Node process on the Mac. It holds the tmux sessions and serves the
  dashboard, terminal, file browser and repository over HTTP/WebSocket; it can also
  bridge access outward through a relay.
- **On the local network** the browser talks to the agent directly: `https://<mac>.local:7710`.
- **Off-network** the agent itself opens an outbound secure connection to the relay (no
  ports are opened on the Mac), and the phone/CLI connect to the same relay via a one-time
  pairing code. The relay is only a "switch": it routes, but the content is end-to-end
  encrypted (libsodium secretstream) and inaccessible to it.
- **tmux is mandatory.** You cannot attach to a plain IDE terminal from the outside — its
  pty belongs to the IDE. Work sessions live in tmux on a dedicated socket `-L termhub`
  (so a stray `tmux kill-server` won't wipe them), and the agent does `tmux attach`.

More: [docs/remote.md](docs/remote.md) (relay/pairing/Tailscale),
[docs/security.md](docs/security.md) (threat model and cryptography).

---

## Monorepo

npm workspaces, `packages/*`:

| Package | What's inside |
|---|---|
| **`@termhub/protocol`** | Foundation: frame codec, E2E crypto on libsodium, base64. |
| **`@termhub/agent`** | Node process on the host (macOS/Linux) + the `termhub` CLI: HTTP/WS server, tmux wrapper, pty↔tmux↔WS bridge, web-push, auto-start service (LaunchAgent/systemd), relay side, CLI client, VCS browser. |
| **`@termhub/relay`** | Zero-knowledge switch (VPS, Docker): WS switch + static serving. |
| **`@termhub/web`** | PWA (vite + vanilla TS, xterm.js): transport abstraction (LAN REST / relay E2E), dashboard/terminal/files/repository screens, in-browser crypto. Built into `packages/agent/static`. |

Stack: Node ≥ 22, TypeScript strict (ESM), `ws`, `node-pty`,
`libsodium-wrappers-sumo`, `web-push`, vite, `@xterm/*`, vitest.

---

## Quick start

```bash
git clone https://github.com/KirillAshikhmin/TermHub.git
cd TermHub
npm install          # + postinstall: chmod +x on the node-pty spawn-helper
npm run build
npx termhub setup    # password, port (7710), session roots, optional relay, VAPID, tm/tml
npx termhub start    # bring up the agent (LAN + relay, if configured)
```

Requirements: **macOS or Linux**, **Node.js ≥ 22**, **tmux** (`brew install tmux` / `apt install tmux`).
On Linux, `npm install` may build node-pty from source — if so, install `build-essential` and `python3` first.

`setup` asks for a web-login password, a port, root directories (where sessions/files may
be opened from), optionally a relay address for remote access, and offers to create a
tmux config and the `tm`/`tml` aliases.

Open it from your phone on the same Wi-Fi network:

```
https://<host-name>.local:7710
```

(`<host-name>` — on macOS: System Settings → General → Sharing → Local hostname; on Linux
`.local` needs Avahi, otherwise use the machine's LAN IP; with a self-signed certificate,
accept the warning once). Enter the password — you're on the dashboard.

Auto-start as a service — `install` picks the backend for your OS (a **LaunchAgent** on
macOS, a **systemd `--user`** unit on Linux):

```bash
npx termhub service install     # macOS: ~/Library/LaunchAgents · Linux: ~/.config/systemd/user
npx termhub service status
npx termhub service uninstall
```

Logs: macOS — `~/Library/Logs/termhub.log`; Linux — `journalctl --user -u dev.termhub.agent -f`.
On a headless Linux server `install` also enables lingering (`loginctl enable-linger`) so the
agent starts at boot without an active login; if that step lacks privileges, run
`sudo loginctl enable-linger <user>` once.

### The habit: `tm` in the IDE terminal

When you open a terminal in your IDE (IDEA, etc.), type `tm` — it creates/opens the tmux
session `main` on socket `-L termhub`, which is exactly what TermHub sees on the dashboard.
`tml` lists sessions. One more parallel session — the "New session" button on the dashboard
or `tmux -L termhub new -s <name>`.

---

## CLI

```bash
npx termhub setup          # interactive setup
npx termhub start          # start the agent (LAN + relay)
npx termhub service …      # install | uninstall | status (LaunchAgent / systemd --user)
npx termhub share          # one-time pairing code (+ QR) for a new device
npx termhub pair|connect   # CLI client: pairing and "ssh over relay"
npx termhub devices|revoke # list/revoke authorized devices
npx termhub doctor         # diagnostics: config, git/svn/hg, tmux, agent, relay
```

---

## Diagnostics

- **`termhub doctor`** — checks the config, presence of git/svn/hg, tmux sessions, whether
  the agent is listening on its port, and whether the relay is reachable; prints a colored report.
- **The "Diagnostics" web page** (menu `⋮` → Diagnostics) — version, uptime, session count,
  **relay link status** (is the agent registered), number of connected clients, roots.
  Available on the agent's LAN address.

---

## Security (in brief)

- LAN: password login (scrypt hash), cookie session, self-signed TLS.
- Remote: agent = `server`, clients = `client` in the E2E handshake (Ed25519 fingerprint ∈
  allow-list → libsodium `crypto_kx` → secretstream). The relay never sees the content.
- Pairing new devices — via a one-time code; devices can be revoked.
- All tmux/VCS calls go through `execFile` without a shell (anti-RCE); names/paths are
  validated, file operations are confined to whitelisted roots (realpath escape check).
- Secret files (`~/.termhub/*.json`) — mode `0600`.

Full threat model — [docs/security.md](docs/security.md).

---

## Deploying the relay (optional)

The relay is a small Docker service on a VPS. Cycle: `npm run build` → `rsync` the sources
to the server → `docker build -f packages/relay/Dockerfile` → `docker compose up -d`. TLS
is handled by Caddy. The agent is pointed at `relayUrl` (`wss://<host>/relay`) during `setup`.
Details — [docs/remote.md](docs/remote.md).

---

## Development

```bash
npm run build            # tsc across packages + vite build of web → packages/agent/static
npx vitest run           # all tests
npx tsc -p packages/web/tsconfig.json --noEmit   # web is not type-checked by the vite build
```

- TypeScript strict, ESM everywhere, 2-space indent.
- Web UI strings — only via i18n (`i18n.ts`), ru+en dictionaries with an identical key set
  (enforced by a test).
- `packages/{agent,relay}/static` is a build artifact (in `.gitignore`); tests run against
  `src` without a build.

How to contribute — [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Troubleshooting

- **`https://<mac>.local:7710` won't open** — mDNS doesn't work on some networks. Take the
  Mac's IP (`ipconfig getifaddr en0`) and open `https://<IP>:7710`.
- **Can't connect through the relay** — check `termhub doctor` (is the relay reachable) and
  the "Diagnostics" page (is the agent registered). A common cause — the Mac went to sleep or
  the agent isn't running.
- **The Mac falls asleep** — disable sleep in System Settings, or `caffeinate -di`, or the
  "Keep Mac awake" toggle in the web menu.
- **Fallback channel** — enable Remote Login (SSH) and do `tmux -L termhub attach -t main`.

---

## Documentation

- [docs/remote.md](docs/remote.md) — remote access: relay, pairing, Tailscale
- [docs/security.md](docs/security.md) — threat model and cryptography
- [docs/notifications.md](docs/notifications.md) — sound, push, HTTPS
- [docs/manual-test-checklist.md](docs/manual-test-checklist.md) — manual test checklist

---

## License

[MIT](LICENSE) © Kirill Ashikhmin.
