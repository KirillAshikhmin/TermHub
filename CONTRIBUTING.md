# Contributing

**English** · [Русский](CONTRIBUTING.ru.md)

Thanks for your interest in TermHub! Patches, ideas and bug reports are welcome.

## Quick start

```bash
npm install        # + postinstall: chmod +x on the node-pty spawn-helper
npm run build      # tsc across packages + vite build of web
npx vitest run     # all tests
```

Requirements: **macOS** (for the agent), **Node.js ≥ 22**, **tmux**.

## Code rules

- **TypeScript strict, ESM**, 2-space indent. Comments in Russian, and only where the code isn't self-evident.
- **Web UI strings — only via i18n** (`packages/web/src/i18n.ts`): ru+en dictionaries with an identical key set (enforced by a test).
- **Web is not type-checked by the vite build** — after editing web, run `npx tsc -p packages/web/tsconfig.json --noEmit`.
- **Features — for all transports**: LAN, local network and relay, where applicable.
- tmux/VCS calls — only through `execFile` without a shell (anti-RCE); names/paths are validated, file operations confined to whitelisted roots. Secret files (`~/.termhub/*.json`) — mode `0600`.

## Before a PR

- `npm run build` and `npx vitest run` are green.
- Changes to the remote side — run `packages/agent/test/e2e.full.test.ts` (a live E2E agent↔relay↔client).
- One PR — one logically complete change; the commit message briefly states the point.

On architecture and security — [README](README.md), [docs/security.md](docs/security.md), [docs/remote.md](docs/remote.md).
