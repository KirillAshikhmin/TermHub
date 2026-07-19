# Manual Test Checklist

**English** · [Русский](manual-test-checklist.ru.md)

Testing on two platforms — iPhone Safari and Android Chrome. Items marked
📱 require a real phone (an emulator and DevTools mobile mode do not cover
them: real push notifications, installing the PWA to the home screen, and a
real mobile keyboard are required).

## Login

- [ ] Open `http://<mac>.local:7710` (or the IP — see README → Troubleshooting)
- [ ] Enter the correct password — you land on the dashboard, the cookie is
      saved (returning within 30 days does not require a password)
- [ ] Enter an incorrect password — a clear error, without revealing details
- [ ] 5 incorrect attempts in a row from one device — login is blocked for a
      minute (a rate-limit-exceeded message)

## Dashboard

- [ ] Empty session list — a hint "run `tm` in the IDEA terminal"
- [ ] Session card — name, directory (truncated if needed), current command
      (`zsh`/`claude`/…), "active N min ago", a count of connected clients
- [ ] 🔔 indicator on a session with a bell (see the "Push notifications"
      section below)
- [ ] Create a session (name + directory from the list + `zsh`/`claude`
      preset) — it appears in the list and is confirmed by `tmux ls` on the Mac
- [ ] Terminate a session (with confirmation) — it disappears from the list
      and from `tmux ls`
- [ ] The list refreshes automatically (polling ~3 s) while the tab is visible

## Terminal

- [ ] Open a session — the real output of the tmux session is visible
- [ ] Input from the phone keyboard arrives and is displayed correctly
- [ ] Quick-key panel: Esc, Tab, Shift+Tab, arrows, Enter, Ctrl+C, y/n — each
      sends the expected sequence
- [ ] A− / A+ change the terminal font size; the value is preserved across
      sessions
- [ ] 📱 Rotating the phone / the on-screen keyboard appearing — the terminal
      resizes without clipping text
- [ ] 📱 Turn Wi-Fi/mobile data off and back on — a "reconnecting" banner
      appears; once the network is back, the terminal restores the connection
      on its own

## PWA installation (requires HTTPS — see docs/notifications.md)

- [ ] 📱 iPhone Safari: "Share" → "Add to Home Screen" (iOS ≥ 16.4); the icon
      on the home screen opens TermHub as a standalone app
- [ ] 📱 Android Chrome: the browser offers "Install app" on its own or the
      item appears in the menu; after installation it opens without the
      address bar

## Push notifications

- [ ] Tap "Allow notifications" in the header — the browser requests permission
- [ ] Enable `terminal_bell` in Claude Code (see docs/notifications.md), wait
      for Claude Code to "ring" — with the tab open, a sound + a system
      `Notification`
- [ ] 📱 Minimize the app or lock the phone, wait for a bell — a push
      notification arrives with the session name
- [ ] Several bells in a row within 30 seconds — the notification arrives no
      more than once per session (throttling)

## Remote (relay)

- [ ] The relay is up (`docker compose up -d`, see docs/remote.md), and the
      agent has `relayUrl` set in its config
- [ ] On the Mac: `termhub share` — shows a code `XXXX-YYYY-YYYY-YYYY` and a QR
- [ ] 📱 On the phone: open the PWA at the relay address, "Add by code", enter
      the code (or scan the QR) — the device is paired
- [ ] 📱 From the phone in remote mode: the agent's session list is visible,
      you can open a terminal, and input/output work the same as on LAN
- [ ] From another computer: `termhub pair <code> --relay <url>`, then
      `termhub connect` — the terminal opens in the CLI, and input/output/resize
      work
- [ ] `termhub devices` shows both paired devices; `termhub revoke <fingerprint>`
      — the device loses access (its next connection is rejected)
