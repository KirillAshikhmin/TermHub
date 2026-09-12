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
- [ ] Create a session (name + directory from the list + `zsh`/`claude`/`codex`
      preset) — it appears in the list and is confirmed by `tmux ls` on the Mac
- [ ] Terminate a session (with confirmation) — it disappears from the list
      and from `tmux ls`
- [ ] The list refreshes automatically (polling ~3 s) while the tab is visible

## Terminal

- [ ] Open a session — the real output of the tmux session is visible
- [ ] Input from the phone keyboard arrives and is displayed correctly
- [ ] Create a session with the `codex` preset — its session tab shows the Codex
      thread title (or thread identifier before it is named), and the browser/PWA
      title has the form `<display title> · TermHub`
- [ ] In that Codex session, run `/rename Copy check` — within one list-poll cycle
      the existing session tab and browser title update in place; the tmux session
      name itself remains unchanged
- [ ] In a Codex process that was started without the preset, run `/title`, include
      `thread-title`, then `/rename Existing check` — TermHub starts showing that
      title without recreating or renaming the tmux session
- [ ] In Codex on macOS (with mouse tracking active), hold `Option` and drag over
      output — releasing the pointer copies the selected text automatically; after
      a redraw clears the highlight, `Command+C` still copies the last non-empty
      selection. A drag without `Option` continues to reach the Codex TUI
- [ ] Drag-select output in Claude Code — releasing the pointer copies the selected
      text automatically; after a redraw clears the highlight, `Command+C`/`Ctrl+C`
      still copies the last non-empty selection
- [ ] Start a foreground command with no terminal selection and press `Ctrl+C` — the
      interrupt reaches the process (copy handling does not consume it)
- [ ] Quick-key panel: Esc, Tab, Shift+Tab, arrows, Enter, Ctrl+C, y/n — each
      sends the expected sequence
- [ ] A− / A+ change the terminal font size; the value is preserved across
      sessions
- [ ] 📱 Rotating the phone / the on-screen keyboard appearing — the terminal
      resizes without clipping text
- [ ] 📱 Turn Wi-Fi/mobile data off and back on — a "reconnecting" banner
      appears; once the network is back, the terminal restores the connection
      on its own
- [ ] Return from a session workspace to the dashboard/login/pairing screen — the
      browser/PWA title returns to `TermHub`

### Connection method and the alternate screen

- [ ] Open a session — the chip in the header names the working connection method
      (`control mode`), and the agent log shows the same mode
- [ ] Tap the chip — a message "Next time the terminal opens: attach" appears, the
      chip is marked as pending, yet the live terminal keeps running in its current
      mode (input/output are not interrupted)
- [ ] Go back to the session list and open the session again — the chip shows
      `attach`; switch it back to `control mode`
- [ ] Set `"terminalMode": "attach"` in the agent config and restart the agent — a
      client request for `control mode` is ignored: the chip shows `attach` and is
      marked as overridden — tapping it explains that the agent picks the mode (the
      agent setting outranks the request)
- [ ] In a Claude/Codex session (control mode) scroll the output with a finger —
      the history scrolls locally, without the network, and no tmux status line is
      visible
- [ ] 📱 In that same agent session, drag a finger across the output — it is the
      terminal history that scrolls, while the app window with its panels stays put
      (the page itself does not move and pull-to-refresh does not fire); a slow
      short drag moves the history too instead of standing still
- [ ] A Claude Code session scrolls too — but only after Claude itself is
      restarted: the alternate screen is forbidden on the agent socket
      (`alternate-screen off`, ADR 0019), while an already running process stays
      in its previous mode and its output never reaches the history
- [ ] Run `vim` (or `htop`) in the session — the "Full-screen app" badge does NOT
      appear: the app stays in the normal buffer, and that is expected rather than
      a breakage. The price shows up right there: after quitting `vim` the screen
      is not restored and its redraw frames stay in the history
- [ ] Check the badge itself where the alternate screen is still on — another tmux
      socket, the setting turned off, or an app that bypasses it: the "Full-screen
      app" badge lights up, tapping it explains that such an app keeps no
      scrollback, and a touch drag now scrolls inside the app itself; quitting the
      app hides the badge and the history scrolls again
- [ ] Open "Diagnostics" — the "Terminal connection method (last known)" row names
      the mode of the last connection (the agent does not report it in diagnostics,
      so the row reflects the last state frame, possibly from another agent), and
      "Client request" the one chosen by the switch

## Files

- [ ] Open text, image, media, binary, and oversized/truncated files — every viewer
      footer has an "Open on host" button next to its existing actions
- [ ] Tap "Open on host" — exactly one native default application opens that file
      on the Mac running the TermHub agent, a success toast appears, and the viewer
      stays open
- [ ] Make the host opener fail — the agent error appears, the viewer stays open,
      and the button can be pressed again
- [ ] Pair a read-only relay guest with file access — file previews work, but the
      "Open on host" button is absent

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
