// Роутер команд агента. Реализованы `setup`, `start`, `share`, `pair`, `connect`,
// `devices`, `revoke`, `service`.

import { initCrypto } from '@termhub/protocol';
import { runSetup } from './setup.js';
import { loadConfig, loadIdentity, loadAuthorized, readTerminalMode, TMUX_SOCKET } from './config.js';
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
import { localUrls } from './local-urls.js';

function usage(cmd: string | undefined): string {
  const header = cmd ? `Unknown command: ${cmd}` : 'No command specified';
  return `${header}\nAvailable: setup, start, share, pair, connect, devices, revoke, service, doctor`;
}

/** Запуск агента: конфиг → SessionService → HTTP/WS-сервер (+ relay-мост). Не завершается. */
async function runStart(): Promise<number> {
  const config = loadConfig();
  // Способ подключения терминала один на оба пути: LAN и relay ведут в один attachTerminal.
  const terminalMode = readTerminalMode(config);
  const sessions = new SessionService({ roots: config.sessionRoots, socketName: TMUX_SOCKET });
  // Альтернативный экран на сокете агента выключен: у того буфера нет истории по стандарту,
  // и панель с Claude Code оставалась без прокрутки. Сервера может ещё не быть — тогда опция
  // уедет с первой созданной сессией, а старт агента это не задержит и не уронит. Дальше опцию
  // держит сам SessionService: сервер умер вместе с последней сессией — на новом она ставится заново.
  await sessions.disableAlternateScreen();
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
      roots: config.sessionRoots,
      socketName: TMUX_SOCKET,
      configMode: terminalMode,
      localUrls: () => localUrls({ port: config.port, tls: config.tls !== null }),
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
    socketName: TMUX_SOCKET,
    onShare: link
      ? (scope) => link.openPairing(scope).then((p) => ({ code: p.code, expiresAt: p.expiresAt }))
      : undefined,
    relayStatus: () => link?.status() ?? null,
  });
  server.attachTerminalWs(wireTerminalWs({ socketName: TMUX_SOCKET, configMode: terminalMode }));
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
