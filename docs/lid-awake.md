# Staying awake with the lid closed

The regular "Keep Mac awake" button prevents idle sleep, but closing a laptop lid puts it
to sleep anyway — and the agents in your sessions stop. This mode disables sleep entirely,
lid included: you can close the laptop and carry it, and the work goes on.

Available only when the host is a Mac. It does not exist on Linux hosts or for guests.

Русская версия: [lid-awake.ru.md](lid-awake.ru.md).

## How to use it

- **Tap** the cup button — the old behaviour: no idle sleep.
- **Hold** the button (about 0.6 s) to turn on "stay awake with the lid closed too". The
  button starts blinking yellow and keeps blinking while the mode is on. Any press of the
  blinking button — a tap or a hold — turns it off.
- **Opening the lid turns it off.** You enable the mode before closing the laptop; once
  the lid has been closed and opened again, the mode has done its job.
- Every switch — the regular mode, the lid mode and the automatic switch-off — is reported
  with a toast.

The button lives in the "⋯" menu on the dashboard and in the action strip of the session
switcher; with the desktop sidebar layout it sits right in the header.

## One-time setup on the Mac

Only root can disable lid-close sleep. The agent runs as your user, so it needs permission
to run two exact commands without a password:

```
/usr/bin/pmset -a disablesleep 0
/usr/bin/pmset -a disablesleep 1
```

Run on the Mac:

```bash
npx termhub lid-awake
```

It checks whether the permission is granted and, if not, prints the line to run once (it
creates `/etc/sudoers.d/termhub-lidawake` and validates it with `visudo`). No agent
restart is needed afterwards.

Until the permission is granted, holding the button changes nothing and the app says that
setup is needed.

To revoke the permission:

```bash
sudo rm /etc/sudoers.d/termhub-lidawake
```

## Good to know

- **Heat.** A closed, working laptop in a bag gets hot. The mode is meant for a desk or a
  stand — which is why it turns itself off when the lid opens and why the button blinks.
- **It is a system setting.** While the mode is on the Mac will not sleep at all — not on
  lid close, not when idle, not from the Sleep menu item. To check by hand:
  `pmset -g | grep SleepDisabled`.
- **The mode does not outlive the agent.** Stopping the agent restores sleep. If the agent
  crashed, the setting is restored the next time it starts.
- **To restore by hand:** `sudo pmset -a disablesleep 0`.
- **Desktop Macs** (no lid): the mode turns on and works as "never sleep", but it does not
  turn itself off — hold the button to disable it.

## How it works

The mechanism comes from the [Fermata](https://github.com/iccir/Fermata) utility: the
`SleepDisabled` power setting. Fermata sets it with a private call from a privileged
helper; TermHub sets the same setting with the stock `pmset -a disablesleep` command via
`sudo -n`. The agent polls the lid every two seconds (`ioreg -r -k AppleClamshellState`).

The decision and the rejected alternatives are in
[ADR 0036](adr/0036-lid-awake-via-pmset-and-sudoers.md) (Russian).
