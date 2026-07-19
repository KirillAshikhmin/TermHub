// Команда `termhub pair <код>` и её тестируемое ядро runPair.
//
// runPair открывает WS к relay, джойнит комнату пейринга (pair-join), шлёт агенту
// hello, зашифрованный ключом кода (sealPair), ждёт ответ агента (openPair), из его
// edPub выводит agentId (fingerprint) и сохраняет известного агента в client-store.
// Зеркало web-экрана pairing.ts, но на Node ws и без DOM.
//
// О двух именах: `deviceName` — имя ЭТОГО устройства, сообщаемое агенту (попадёт в
// его список устройств `termhub devices`; флаг `--name`, по умолчанию — hostname).
// `name` — локальная метка агента (для `connect <name>` и вывода «Спарено с …»;
// флаг `--agent-label`, по умолчанию — agentId). Ответ агента (openPair reply)
// содержит лишь `{edPub, ok}` — имени агента там нет, поэтому метка задаётся
// локально. Слать метку агента ему же как имя устройства было бы бессмысленно —
// имена разделены (как clientName/agentName в web).

import os from 'node:os';
import { WebSocket } from 'ws';
import {
  fingerprint,
  fromB64,
  initCrypto,
  openPair,
  pairKey,
  parsePairingCode,
  sealPair,
  toB64,
} from '@termhub/protocol';
import type { ClientStore, KnownAgent } from './client-store.js';
import { loadClientStore } from './client-store.js';

/** Длина Ed25519-публичного ключа. */
const ED25519_PUB_BYTES = 32;
/** Тайм-аут ожидания ответа агента (relay TTL — 5 мин, но CLI-порог короче). */
const PAIR_TIMEOUT_MS = 60_000;

/** Опции ядра пейринга. */
export interface RunPairOpts {
  /** Код пейринга XXXX-YYYY-YYYY-YYYY. */
  code: string;
  /** ws(s)://host/relay. */
  relayUrl: string;
  /** Локальная метка агента (по умолчанию — agentId). */
  name?: string;
  /** Имя этого устройства, сообщаемое агенту (по умолчанию — hostname). */
  deviceName?: string;
  /** Хранилище клиента (по умолчанию — loadClientStore()). */
  store?: ClientStore;
  /** Тайм-аут ответа (для тестов). */
  timeoutMs?: number;
}

/** Ядро пейринга: спаривает с агентом и сохраняет его в client-store. */
export function runPair(opts: RunPairOpts): Promise<KnownAgent> {
  const { roomId, secret } = parsePairingCode(opts.code);
  const key = pairKey(secret);
  const store = opts.store ?? loadClientStore();
  const deviceName = opts.deviceName ?? os.hostname();

  return new Promise<KnownAgent>((resolve, reject) => {
    const ws = new WebSocket(opts.relayUrl);
    let settled = false;

    const finish = (err: Error | null, agent?: KnownAgent): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* уже закрыт — идемпотентно */
      }
      if (err) reject(err);
      else resolve(agent!);
    };

    const timer = setTimeout(() => finish(new Error('Timed out waiting for the agent to respond.')), opts.timeoutMs ?? PAIR_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'pair-join', roomId }));
      const hello = sealPair(key, { edPub: toB64(store.identity.edPub), name: deviceName });
      ws.send(JSON.stringify({ t: 'pair-msg', data: toB64(hello) }));
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data.toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
        msg = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.t === 'pair-msg' && typeof msg.data === 'string') {
        let reply: { edPub?: unknown; ok?: unknown };
        try {
          reply = openPair<{ edPub?: unknown; ok?: unknown }>(key, fromB64(msg.data));
        } catch {
          finish(new Error('Invalid pairing code: could not decrypt the agent response.'));
          return;
        }
        if (reply.ok !== true || typeof reply.edPub !== 'string') {
          finish(new Error('Agent rejected the pairing.'));
          return;
        }
        const agentEdPub = fromB64(reply.edPub);
        if (agentEdPub.length !== ED25519_PUB_BYTES) {
          finish(new Error('Agent sent an invalid public key.'));
          return;
        }
        const agentId = fingerprint(agentEdPub);
        const agent: KnownAgent = {
          agentId,
          name: opts.name || agentId,
          agentEdPub: reply.edPub,
          relayUrl: opts.relayUrl,
          addedAt: Date.now(),
        };
        store.add(agent);
        finish(null, agent);
      } else if (msg.t === 'pair-closed' || msg.t === 'pair-peer-left') {
        finish(new Error('Pairing closed: the code expired or the agent disconnected.'));
      } else if (msg.t === 'error') {
        finish(
          new Error(
            msg.code === 'no-room'
              ? 'Pairing room not found: check the code and that the agent has opened pairing (termhub share).'
              : `Relay rejected the pairing (${String(msg.code)}).`,
          ),
        );
      }
    });

    ws.on('close', () => finish(new Error('Connection to relay closed before pairing completed (wrong or expired code?).')));
    ws.on('error', () => {
      /* за ошибкой всегда следует close — обработка там */
    });
  });
}

// ── Команда CLI ────────────────────────────────────────────────────────────────

/** Разбирает `pair <код> [--relay <url>] [--name <имя-устройства>] [--agent-label <ярлык>]`.
 *  `--name` — имя ЭТОГО устройства, сообщаемое агенту (по умолчанию — hostname);
 *  `--agent-label` — локальный ярлык агента для `connect <ярлык>` (по умолчанию — agentId). */
function parsePairArgs(args: string[]): { code?: string; relay?: string; deviceName?: string; agentLabel?: string } {
  let code: string | undefined;
  let relay: string | undefined;
  let deviceName: string | undefined;
  let agentLabel: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--relay') relay = args[++i];
    else if (a.startsWith('--relay=')) relay = a.slice('--relay='.length);
    else if (a === '--name') deviceName = args[++i];
    else if (a.startsWith('--name=')) deviceName = a.slice('--name='.length);
    else if (a === '--agent-label') agentLabel = args[++i];
    else if (a.startsWith('--agent-label=')) agentLabel = a.slice('--agent-label='.length);
    else if (!a.startsWith('-') && code === undefined) code = a;
  }
  return { code, relay, deviceName, agentLabel };
}

/** Резолвит relay: явный --relay, иначе единственный известный. */
function resolveRelay(store: ClientStore, explicit?: string): string {
  if (explicit) return explicit;
  const relays = [...new Set(store.list().map((a) => a.relayUrl))];
  if (relays.length === 1) return relays[0]!;
  throw new Error('No relay specified. Provide one: termhub pair <code> --relay <ws(s)://host/relay>');
}

/** Точка входа команды `termhub pair`. */
export async function pairCommand(args: string[]): Promise<number> {
  const { code, relay, deviceName, agentLabel } = parsePairArgs(args);
  if (!code) {
    console.error('Usage: termhub pair <code> [--relay <url>] [--name <device-name>] [--agent-label <label>]');
    return 1;
  }
  await initCrypto();
  const store = loadClientStore();

  let relayUrl: string;
  try {
    relayUrl = resolveRelay(store, relay);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  try {
    // --name → deviceName (имя этого устройства для агента); --agent-label → name
    // (локальный ярлык агента, по умолчанию agentId).
    const agent = await runPair({ code, relayUrl, name: agentLabel, deviceName, store });
    console.log(`Paired with ${agent.name} (${agent.agentId})`);
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}
