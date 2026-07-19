// Роутер команд агента. Реализованы `setup`, `start`, `share`, `pair`, `connect`,
// `devices`, `revoke`, `service`.

import { initCrypto } from '@termhub/protocol';
import { runSetup } from './setup.js';
import { loadConfig, loadIdentity, loadAuthorized, TMUX_SOCKET } from './config.js';
import { SessionService } from './sessions.js';
import { FileService } from './files.js';
import { VcsService } from './vcs.js';
import { AgentServer } from './server.js';
import { PushService } from './push.js';
import { Caffeinate } from './caffeinate.js';
import { wireTerminalWs } from './bridge.js';
import { RelayLink } from './relay-link.js';
import { runShare } from './share.js';
import { pairCommand } from './pair-cmd.js';
import { connectCommand } from './connect-cmd.js';
import { runDevices, runRevoke } from './devices-cmd.js';
import { serviceCommand } from './service.js';
import { runDoctor } from './doctor.js';

function usage(cmd: string | undefined): string {
  const header = cmd ? `Unknown command: ${cmd}` : 'No command specified';
  return `${header}\nAvailable: setup, start, share, pair, connect, devices, revoke, service, doctor`;
}

/** Запуск агента: конфиг → SessionService → HTTP/WS-сервер (+ relay-мост). Не завершается. */
async function runStart(): Promise<number> {
  const config = loadConfig();
  const sessions = new SessionService({ roots: config.sessionRoots, socketName: TMUX_SOCKET });
  const files = new FileService({ roots: config.sessionRoots });
  const vcs = new VcsService({ roots: config.sessionRoots });
  const push = new PushService(config);

  const caffeinate = new Caffeinate();

  // Relay-мост поднимается только если задан relayUrl (иначе агент — чисто LAN).
  let relayLink: RelayLink | undefined;
  if (config.relayUrl) {
    await initCrypto();
    relayLink = new RelayLink({
      url: config.relayUrl,
      identity: loadIdentity(),
      authorized: () => loadAuthorized(),
      sessions,
      caffeinate,
      push,
      files,
      vcs,
      socketName: TMUX_SOCKET,
    });
  }
  const link = relayLink;

  const server = new AgentServer({
    config,
    sessions,
    files,
    vcs,
    push,
    caffeinate,
    onShare: link
      ? (scope) => link.openPairing(scope).then((p) => ({ code: p.code, expiresAt: p.expiresAt }))
      : undefined,
    relayStatus: () => link?.status() ?? null,
  });
  server.attachTerminalWs(wireTerminalWs({ socketName: TMUX_SOCKET }));
  sessions.onBell((name, task) => void push.notifyBell(name, task));
  const port = await server.listen();
  sessions.startPolling();
  link?.start();
  console.log(`TermHub agent listening on ${config.host}:${port} (${config.tls ? 'https' : 'http'})`);
  if (link) console.log(`Relay bridge enabled: ${config.relayUrl}`);

  const shutdown = (): void => {
    sessions.stopPolling();
    caffeinate.set(false); // отпускаем удержание сна при остановке агента
    void Promise.resolve(link?.stop()).finally(() => server.close().finally(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return new Promise<number>(() => {});
}

/** Точка входа CLI. Возвращает код выхода процесса. */
export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === 'setup') {
    await runSetup();
    return 0;
  }
  if (cmd === 'start') return runStart();
  if (cmd === 'share') return runShare();
  if (cmd === 'pair') return pairCommand(argv.slice(1));
  if (cmd === 'connect') return connectCommand(argv.slice(1));
  if (cmd === 'devices') {
    runDevices();
    return 0;
  }
  if (cmd === 'revoke') {
    const arg = argv[1];
    if (!arg) {
      console.error('Usage: termhub revoke <fingerprint|name>');
      return 1;
    }
    return runRevoke(arg) ? 0 : 1;
  }
  if (cmd === 'service') return serviceCommand(argv.slice(1));
  if (cmd === 'doctor') return runDoctor();
  console.error(usage(cmd));
  return 1;
}
