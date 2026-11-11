// Свой relay на машине агента (`localRelay` в config.json). Нужен тем, у кого есть белый
// адрес и проброс порта: телефон ходит к машине напрямую, без VPS, а наружу смотрит не
// вход по паролю, а relay — те же ключи устройств, пейринг, отзыв и сквозное шифрование.
//
// Relay живёт отдельным процессом: он разбирает трафик из интернета, и его падение или
// занятый цикл событий не должны трогать агента с терминалами. Агент ходит к нему по
// loopback вторым мостом, рядом с мостом на `relayUrl` (если тот задан).

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePairingCode } from '@termhub/protocol';
import type { TermhubConfig, DeviceScope, AuthorizedDevice } from './config.js';

export interface LocalRelayConfig {
  port: number;
  host: string;
  tls: { cert: string; key: string } | null;
  /** Не запускать relay без сертификата (страховка от случайного `tls: null` или
   *  пропавшего сертификата агента). */
  requireHttps?: boolean;
}

const RESTART_START_MS = 1000;
const RESTART_MAX_MS = 30_000;
/** Проживший столько процесс считается здоровым: следующая пауза перезапуска снова короткая. */
const HEALTHY_MS = 60_000;

/** Читает `localRelay`. Поля нет — своего relay нет (так у всех, кто его не просил).
 *  `tls` не задан — берётся сертификат агента; `tls: null` — обычный HTTP. Битое
 *  значение relay не поднимает и молча не проглатывается. */
export function readLocalRelay(
  config: Pick<TermhubConfig, 'localRelay' | 'tls' | 'port'>,
  log: (message: string) => void = console.warn,
): LocalRelayConfig | null {
  const raw: unknown = config.localRelay;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') {
    log('[config] localRelay must be an object like {"port": 7720}, ignored');
    return null;
  }
  const r = raw as { port?: unknown; host?: unknown; tls?: unknown; requireHttps?: unknown };
  if (typeof r.port !== 'number' || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) {
    log(`[config] localRelay.port "${String(r.port)}" is not a port number, local relay is off`);
    return null;
  }
  if (r.port === config.port) {
    log('[config] localRelay.port equals the agent port, local relay is off');
    return null;
  }
  let tls = config.tls;
  if (r.tls === null) tls = null;
  else if (r.tls !== undefined) {
    const t = r.tls as { cert?: unknown; key?: unknown };
    if (typeof t !== 'object' || typeof t.cert !== 'string' || typeof t.key !== 'string') {
      log('[config] localRelay.tls must be {"cert": path, "key": path} or null, local relay is off');
      return null;
    }
    tls = { cert: t.cert, key: t.key };
  }
  const host = typeof r.host === 'string' && r.host.length > 0 ? r.host : '0.0.0.0';
  if (r.requireHttps === true) {
    if (!tls) {
      log('[config] localRelay.requireHttps is set, but there is no certificate (localRelay.tls or tls), local relay is off');
      return null;
    }
    return { port: r.port, host, tls, requireHttps: true };
  }
  return { port: r.port, host, tls };
}

/** Адрес, по которому агент сам ходит к своему relay. */
export function localRelayUrl(cfg: LocalRelayConfig): string {
  const any = cfg.host === '0.0.0.0' || cfg.host === '::';
  const host = any ? '127.0.0.1' : cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
  return `${cfg.tls ? 'wss' : 'ws'}://${host}:${cfg.port}/relay`;
}

/** Окружение процесса relay. Настройки relay из окружения агента (RELAY_*, RTC_*)
 *  наследуются: ими владелец включает те же режимы, что и на VPS. */
export function localRelayEnv(cfg: LocalRelayConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PORT: String(cfg.port), HOST: cfg.host };
  delete env.TLS_CERT;
  delete env.TLS_KEY;
  delete env.STATIC_DIR;
  // Прокси перед этим relay нет: адрес клиента берётся с сокета, заголовку верить нельзя.
  delete env.RELAY_TRUST_PROXY;
  delete env.RELAY_REQUIRE_HTTPS;
  if (cfg.requireHttps) env.RELAY_REQUIRE_HTTPS = '1';
  if (cfg.tls) {
    env.TLS_CERT = cfg.tls.cert;
    env.TLS_KEY = cfg.tls.key;
  }
  return env;
}

function relayBin(): string {
  const entry = fileURLToPath(import.meta.resolve('@termhub/relay'));
  return path.resolve(path.dirname(entry), '..', 'bin', 'termhub-relay.js');
}

type Spawn = (env: NodeJS.ProcessEnv) => Pick<ChildProcess, 'on' | 'kill'>;

/** Держит процесс relay: поднимает, перезапускает после падения с растущей паузой,
 *  гасит вместе с агентом. */
export class LocalRelay {
  private child?: Pick<ChildProcess, 'on' | 'kill'>;
  private stopped = true;
  private delay = RESTART_START_MS;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly spawn: Spawn;

  constructor(
    readonly config: LocalRelayConfig,
    opts: { spawn?: Spawn; log?: (message: string) => void } = {},
  ) {
    this.spawn = opts.spawn ?? ((env) => fork(relayBin(), [], { env, stdio: 'inherit' }));
    this.log = opts.log ?? console.warn;
  }

  private readonly log: (message: string) => void;

  get running(): boolean {
    return this.child !== undefined;
  }

  start(): void {
    this.stopped = false;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }

  private launch(): void {
    if (this.stopped) return;
    let child: Pick<ChildProcess, 'on' | 'kill'>;
    try {
      child = this.spawn(localRelayEnv(this.config));
    } catch (err) {
      // Нет собранного relay — агент работает дальше, своего relay просто нет.
      this.log(`[local-relay] cannot start: ${(err as Error).message}`);
      this.retry();
      return;
    }
    this.child = child;
    const startedAt = Date.now();
    let gone = false;
    const onGone = (why: string): void => {
      if (gone) return;
      gone = true;
      if (this.child !== child) return; // остановлен нами
      this.child = undefined;
      if (Date.now() - startedAt >= HEALTHY_MS) this.delay = RESTART_START_MS;
      this.log(`[local-relay] stopped (${why}), restarting in ${Math.round(this.delay / 1000)}s`);
      this.retry();
    };
    child.on('exit', (code: number | null, signal: string | null) => onGone(signal ?? `code ${code ?? '?'}`));
    child.on('error', (err: Error) => onGone(err.message));
  }

  private retry(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.launch(), this.delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.delay = Math.min(this.delay * 2, RESTART_MAX_MS);
  }
}

interface PairingLink {
  openPairing(
    scope?: DeviceScope,
    preset?: { code: string; roomId: string; secret: string },
  ): Promise<{ code: string; expiresAt: number; done: Promise<AuthorizedDevice> }>;
  cancelPairing(reason: string): void;
}

/** Один код пейринга на все relay агента: устройство вводит его на том, через который
 *  пришло. Ответ — от первого relay, открывшего комнату (недоступный второй выдачу кода
 *  не задерживает). Код одноразовый: спарились на одном relay — на остальных он снят. */
export async function sharePairing(
  links: PairingLink[],
  scope?: DeviceScope,
): Promise<{ code: string; expiresAt: number }> {
  if (links.length === 1) {
    const p = await links[0].openPairing(scope);
    return { code: p.code, expiresAt: p.expiresAt };
  }
  const preset = generatePairingCode();
  const opened = links.map((link) =>
    link.openPairing(scope, preset).then((p) => {
      void p.done.then(
        () => {
          for (const other of links) if (other !== link) other.cancelPairing('Pairing code already used');
        },
        () => {},
      );
      return p;
    }),
  );
  try {
    const first = await Promise.any(opened);
    return { code: first.code, expiresAt: first.expiresAt };
  } catch (err) {
    const errors = (err as AggregateError).errors;
    throw errors?.[0] instanceof Error ? errors[0] : (err as Error);
  }
}
