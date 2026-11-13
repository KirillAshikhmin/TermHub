// Роутер команд агента. Реализованы `setup`, `start`, `share`, `pair`, `connect`,
// `devices`, `revoke`, `service`.

import os from 'node:os';
import { initCrypto } from '@termhub/protocol';
import { runSetup } from './setup.js';
import { readRelayDial, describeDial } from './relay-dial.js';
import { runLocalCert } from './local-cert.js';
import { loadConfig, loadIdentity, loadAuthorized, readTerminalMode, TMUX_SOCKET } from './config.js';
import { SessionService } from './sessions.js';
import { FileService } from './files.js';
import { VcsService } from './vcs.js';
import { AgentServer } from './server.js';
import { bellSummary } from './bell-summary.js';
import { PushService } from './push.js';
import { Caffeinate } from './caffeinate.js';
import { LidAwake, sudoersInstallCommand } from './lid-awake.js';
import { wireTerminalWs } from './bridge.js';
import { RelayLink } from './relay-link.js';
import { LocalRelay, readLocalRelay, localRelayUrl, sharePairing } from './local-relay.js';
import { runShare } from './share.js';
import { pairCommand } from './pair-cmd.js';
import { connectCommand } from './connect-cmd.js';
import { runDevices, runRevoke } from './devices-cmd.js';
import { serviceCommand } from './service.js';
import { runDoctor } from './doctor.js';
import { localUrls } from './local-urls.js';

function usage(cmd: string | undefined): string {
  const header = cmd ? `Unknown command: ${cmd}` : 'No command specified';
  return `${header}\nAvailable: setup, start, share, pair, connect, devices, revoke, service, doctor, local-cert, lid-awake`;
}

/** Запуск агента: конфиг → SessionService → HTTP/WS-сервер (+ relay-мост). Не завершается. */
async function runStart(): Promise<number> {
  const config = loadConfig();
  // Способ подключения терминала один на оба пути: LAN и relay ведут в один attachTerminal.
  const terminalMode = readTerminalMode(config);
  const sessions = new SessionService({ roots: config.sessionRoots, socketName: TMUX_SOCKET });
  const files = new FileService({ roots: config.sessionRoots });
  const vcs = new VcsService({ roots: config.sessionRoots });
  const push = new PushService(config);

  // Режим «не спать при закрытой крышке» (macOS): настройка, оставшаяся включённой после
  // падения прошлого запуска, возвращается сразу.
  const lidAwake = new LidAwake();
  void lidAwake.recover();
  const caffeinate = new Caffeinate({ lid: lidAwake });

  // Relay-мосты: на внешний relay (relayUrl) и на свой, запущенный на этой машине
  // (localRelay). Ни того ни другого — агент чисто LAN. Мосты независимы: устройство
  // спарено с агентом, а не с relay, и ходит через тот, чью страницу открыло.
  const relayDial = readRelayDial(config);
  const localRelayCfg = readLocalRelay(config);
  const localRelay = localRelayCfg ? new LocalRelay(localRelayCfg) : undefined;
  const links: RelayLink[] = [];
  let localLink: RelayLink | undefined;
  if (config.relayUrl || localRelayCfg) {
    await initCrypto();
    const identity = loadIdentity();
    const makeLink = (url: string, dial: typeof relayDial): RelayLink =>
      new RelayLink({
        url,
        dial,
        identity,
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
    if (config.relayUrl) links.push(makeLink(config.relayUrl, relayDial));
    if (localRelayCfg) {
      localLink = makeLink(localRelayUrl(localRelayCfg), { insecure: true });
      links.push(localLink);
    }
  }
  // Статус для диагностики: связь — основного моста (внешний, а без него свой),
  // пересечение возможностей — самого свежего обмена среди всех.
  const relayStatus = (): ReturnType<RelayLink['status']> | null => {
    if (links.length === 0) return null;
    const all = links.map((l) => l.status());
    const freshest = all.reduce((a, b) => (b.capsAt > a.capsAt ? b : a));
    return { ...all[0], caps: freshest.caps, capsAt: freshest.capsAt };
  };

  const server = new AgentServer({
    config,
    sessions,
    files,
    vcs,
    push,
    caffeinate,
    socketName: TMUX_SOCKET,
    onShare: links.length > 0 ? (scope) => sharePairing(links, scope) : undefined,
    relayStatus,
    localRelay:
      localRelay && localLink
        ? () => {
            const st = localLink.status();
            return {
              port: localRelay.config.port,
              tls: localRelay.config.tls !== null,
              running: localRelay.running,
              connected: st.connected,
              clients: st.clients,
            };
          }
        : undefined,
  });
  server.attachTerminalWs(wireTerminalWs({ socketName: TMUX_SOCKET, configMode: terminalMode }));
  // Уведомление несёт сводку: спросил ли агент что-то и чем закончил ход.
  sessions.onBell(
    (name, task) => void bellSummary(name, { socketName: TMUX_SOCKET }).then((summary) => push.notifyBell(name, task, summary)),
  );
  const port = await server.listen();
  sessions.startPolling();
  localRelay?.start();
  for (const l of links) l.start();
  console.log(`TermHub agent listening on ${config.host}:${port} (${config.tls ? 'https' : 'http'})`);
  const loopbackPort = server.loopbackPort();
  if (loopbackPort !== undefined) console.log(`Local http entrance: http://localhost:${loopbackPort}`);
  if (config.relayUrl) console.log(`Relay bridge enabled: ${config.relayUrl} (${describeDial(relayDial)})`);
  if (localRelayCfg) {
    console.log(`Local relay: ${localRelayCfg.tls ? 'https' : 'http'} on ${localRelayCfg.host}:${localRelayCfg.port}`);
    if (!localRelayCfg.tls) console.warn('Local relay runs without TLS: do not expose it to the internet as is.');
  }

  const shutdown = (): void => {
    sessions.stopPolling();
    caffeinate.set(false); // отпускаем удержание сна при остановке агента
    lidAwake.release(); // и возвращаем сон по закрытой крышке
    void Promise.allSettled(links.map((l) => l.stop())).finally(() => {
      localRelay?.stop();
      void server.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return new Promise<number>(() => {});
}

/** Точка входа CLI. Возвращает код выхода процесса. */
/** `termhub lid-awake`: проверяет разрешение на режим «не спать при закрытой крышке» и,
 *  если его нет, печатает команду, которой владелец выдаёт его один раз. Сам агент
 *  sudoers не трогает: права root выдаёт человек, видя, на что именно. */
async function runLidAwake(): Promise<number> {
  const lid = new LidAwake();
  if (!lid.supported) {
    console.log('Lid-close sleep prevention is available on macOS hosts only.');
    return 0;
  }
  await lid.refreshReady(true);
  if (lid.state().lidReady) {
    console.log('Ready: the agent may switch lid-close sleep off and on.');
    console.log('In the app, hold the "Keep awake" button to turn it on; opening the lid turns it off.');
    return 0;
  }
  console.log('The agent needs permission to run two exact commands as root, without a password:');
  console.log('  /usr/bin/pmset -a disablesleep 0');
  console.log('  /usr/bin/pmset -a disablesleep 1');
  console.log('\nGrant it once by running:\n');
  console.log(`  ${sudoersInstallCommand(os.userInfo().username)}`);
  console.log('\nTo revoke: sudo rm /etc/sudoers.d/termhub-lidawake');
  return 0;
}

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
  if (cmd === 'local-cert') return runLocalCert();
  if (cmd === 'lid-awake') return runLidAwake();
  console.error(usage(cmd));
  return 1;
}
