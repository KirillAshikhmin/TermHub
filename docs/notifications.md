# Notifications

**English** · [Русский](notifications.ru.md)

## How it works

TermHub detects that a session is "ringing" (bell) in two ways: while you are
looking at an open terminal, it scans the raw BEL byte (`0x07`) directly in the
output; for all other sessions, it polls the tmux `window_bell_flag` flag every
2 seconds (which is why `~/.tmux.conf` needs the `monitor-bell on` option — it
is appended, along with the other settings, by `termhub setup`).

From there, there are three delivery channels:

1. **Tab open** — sound (unlocked by the first tap on the screen, as browsers
   require) + a system `Notification`.
2. **App closed** — Web Push directly from the Mac (requires an HTTPS
   subscription context, see below).
3. **Remote mode** — the same: the push subscription is also delivered to the
   agent over the E2E channel, and the sending itself is no different from LAN.

Throttling: no more than one push per session every 30 seconds, so that a burst
of bells does not flood you with notifications.

## Enable sound in Claude Code (`terminal_bell`)

For Claude Code to actually send a BEL when it is waiting for your reply, its
`~/.claude/settings.json` must contain:

```json
{ "preferredNotifChannel": "terminal_bell" }
```

In some terminals (Ghostty, Kitty, iTerm2) the terminal's own system
notification is used by default instead — TermHub will not see it; it
specifically needs `terminal_bell`. Set this once and run Claude Code inside a
tmux session (that is, via `tm`, see README) — then the BEL will reach TermHub
too.

## Local notifications (Android/desktop)

These work out of the box if you grant them via the "Allow notifications" button
in the app header. Without explicit browser permission, TermHub will not show a
notification — it is never requested automatically.

## Web Push (when the app is closed)

VAPID keys are generated automatically during `termhub setup` — nothing extra
needs to be configured. But the push subscription itself (like installing the
PWA) only works in a secure context (HTTPS, as well as `localhost`), so over
plain `http://<mac>.local:7710` (LAN) push is unavailable — the site still works
as usual in that case, just without push and without the prompt to install the
app.

You can obtain HTTPS for a local address in two ways.

### Option 1: Tailscale (`tailscale cert`)

If the Mac and phone are on the same Tailscale network:

```bash
tailscale cert <your-tailscale-hostname>
```

The command will place `<hostname>.crt`/`<hostname>.key` in the current
directory. Add the paths to `~/.termhub/config.json`:

```json
"tls": { "cert": "/path/<hostname>.crt", "key": "/path/<hostname>.key" }
```

and restart `termhub start`. Open `https://<hostname>:7710` — the certificate is
real (trusted, via Let's Encrypt), and the browser will not complain.

### Option 2: mkcert (local certificate for `.local`/IP)

```bash
brew install mkcert
mkcert -install                         # once — installs the root certificate into the system
mkcert <mac-name>.local <mac-IP>        # for example: mkcert macbook.local 192.168.1.42
```

Two files will appear: `*.pem` (the certificate) and `*-key.pem` (the key). Add
them to `~/.termhub/config.json`:

```json
"tls": { "cert": "/path/to/<name>.pem", "key": "/path/to/<name>-key.pem" }
```

and restart the agent — the address will become `https://<mac-name>.local:7710`.

Important: an mkcert certificate is trusted only by machines where its root
certificate has been installed manually (`mkcert -install`; the path to the root
is `mkcert -CAROOT`). On a phone, the browser does not trust such a certificate
by default — either transfer the root certificate to the phone manually, or use
the Tailscale option, where the certificate is trusted out of the box.

## iOS: installing the PWA on the home screen

On iPhone, Web Push and full offline operation are available only to an app
installed on the home screen — a regular Safari tab does not get them:

1. Open TermHub over HTTPS (see above) in Safari.
2. "Share" → "Add to Home Screen".
3. Requires iOS 16.4 or newer.
4. Notifications are requested from the installed app itself — via the "Allow
   notifications" button in the header.
