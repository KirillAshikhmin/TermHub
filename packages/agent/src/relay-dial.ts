// Способ соединения с relay — один на агента и CLI-клиент. Обычный путь — WebSocket
// прямо по адресу relay. Для сетей, где фильтр душит каждое соединение после пары
// десятков пакетов, есть три обхода, все — настройкой:
//   relayDisguise  — перед TLS шлётся преамбула «разрешённого» протокола (ssh/rdp/dns),
//                    и фильтр пропускает соединение целиком; на relay нужен порт
//                    маскировки, его адрес задаёт relayConnect;
//   relayConnect   — соединяться не с адресом из relayUrl, а с этим host:port (порт
//                    маскировки либо локальный конец своего туннеля, напр. `ssh -L`);
//                    имя для TLS при этом остаётся из relayUrl;
//   relayTransport — 'poll': вместо WebSocket короткие HTTP-запросы (каждый на свежем
//                    соединении) — работает без порта маскировки и без туннеля.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { WebSocket } from 'ws';
import { PollSocket, disguisePreface, isDisguise } from '@termhub/protocol';
import type { Disguise } from '@termhub/protocol';
import { configPath } from './paths.js';

export interface RelayDial {
  connect?: string;
  disguise?: Disguise;
  transport?: 'ws' | 'poll';
}

interface DialSource {
  relayConnect?: unknown;
  relayDisguise?: unknown;
  relayTransport?: unknown;
}

/** Собирает способ соединения: переменные окружения старше config.json (CLI-клиент на
 *  чужой машине конфига агента не имеет). Чужое значение не ломает запуск, но и молча
 *  не проглатывается. */
export function readRelayDial(
  source?: DialSource | null,
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.warn,
): RelayDial {
  const cfg = source === undefined ? readConfigQuietly() : source;
  const pick = (envName: string, value: unknown): unknown => env[envName] || value;
  const dial: RelayDial = {};
  const connect = pick('TERMHUB_RELAY_CONNECT', cfg?.relayConnect);
  if (typeof connect === 'string' && connect.length > 0) {
    if (splitHostPort(connect)) dial.connect = connect;
    else log(`[config] relayConnect "${connect}" is not host:port, ignored`);
  }
  const disguise = pick('TERMHUB_RELAY_DISGUISE', cfg?.relayDisguise);
  if (disguise !== undefined && disguise !== null && disguise !== '' && disguise !== 'none') {
    if (isDisguise(disguise)) dial.disguise = disguise;
    else log(`[config] unknown relayDisguise "${String(disguise)}", ignored (ssh, rdp, dns)`);
  }
  const transport = pick('TERMHUB_RELAY_TRANSPORT', cfg?.relayTransport);
  if (transport === 'poll') dial.transport = 'poll';
  else if (transport !== undefined && transport !== null && transport !== '' && transport !== 'ws') {
    log(`[config] unknown relayTransport "${String(transport)}", using ws`);
  }
  return dial;
}

function readConfigQuietly(): DialSource | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as DialSource;
  } catch {
    return null;
  }
}

function splitHostPort(value: string): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(value);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1].replace(/^\[|\]$/g, ''), port };
}

/** Короткое описание способа для лога. */
export function describeDial(dial: RelayDial): string {
  if (dial.transport === 'poll') return 'short requests';
  const parts: string[] = [];
  if (dial.disguise) parts.push(`disguised as ${dial.disguise}`);
  if (dial.connect) parts.push(`via ${dial.connect}`);
  return parts.length > 0 ? `websocket, ${parts.join(', ')}` : 'websocket';
}

/** Открывает соединение с relay выбранным способом. Возвращаемое значение ведёт себя
 *  как ws.WebSocket в той части, которой пользуются мост агента и CLI. */
export function openRelaySocket(url: string, dial: RelayDial = {}): WebSocket {
  if (dial.transport === 'poll') return new PollWs(url) as unknown as WebSocket;
  if (!dial.connect && !dial.disguise) return new WebSocket(url);
  const target = new URL(url);
  const secure = target.protocol === 'wss:';
  const to = (dial.connect && splitHostPort(dial.connect)) || {
    host: target.hostname,
    port: Number(target.port) || (secure ? 443 : 80),
  };
  const preface = dial.disguise ? disguisePreface(dial.disguise) : null;
  const createConnection = (): net.Socket => {
    const raw = net.connect({ host: to.host, port: to.port });
    raw.setNoDelay(true);
    // Преамбула уходит первым пакетом, до TLS: по нему фильтр и решает судьбу потока.
    if (preface) raw.write(preface);
    if (!secure) return raw;
    const name = target.hostname.replace(/^\[|\]$/g, '');
    return tls.connect({ socket: raw, servername: net.isIP(name) ? undefined : name });
  };
  return new WebSocket(url, { createConnection } as unknown as ConstructorParameters<typeof WebSocket>[1]);
}

/** PollSocket в одежде ws.WebSocket: события 'open' / 'message'(Buffer, isBinary) / 'close'. */
class PollWs extends EventEmitter {
  private readonly sock: PollSocket;

  constructor(url: string) {
    super();
    this.sock = new PollSocket(url);
    this.sock.onopen = () => this.emit('open');
    this.sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.emit('message', Buffer.from(ev.data, 'utf8'), false);
      else this.emit('message', Buffer.from(ev.data), true);
    };
    this.sock.onclose = (ev) => this.emit('close', ev.code, Buffer.from(ev.reason));
    // 'error' без слушателя уронил бы процесс; за сбоем всегда идёт 'close'.
    this.sock.onerror = () => {
      if (this.listenerCount('error') > 0) this.emit('error', new Error('relay request failed'));
    };
  }

  get readyState(): number {
    return this.sock.readyState;
  }

  get bufferedAmount(): number {
    return this.sock.bufferedAmount;
  }

  send(data: string | Uint8Array, _opts?: unknown): void {
    this.sock.send(data);
  }

  ping(): void {
    /* живость видна серверу по самим запросам */
  }

  close(code?: number, reason?: string): void {
    this.sock.close(code, reason);
  }

  terminate(): void {
    this.sock.close(1006, '');
  }
}
