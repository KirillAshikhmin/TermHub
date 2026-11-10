import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { initCrypto, generateIdentity, fingerprint, sign, type Identity } from '@termhub/protocol';
import { startRelay } from '../../relay/src/index.js';
import { startDisguiseProxy } from '../../relay/src/disguise-port.js';
import { describeDial, openRelaySocket, readRelayDial, type RelayDial } from '../src/relay-dial.js';

let identity: Identity;
beforeAll(async () => {
  await initCrypto();
  identity = generateIdentity();
});

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

describe('readRelayDial', () => {
  it('пустой конфиг — прямой WebSocket', () => {
    expect(readRelayDial({}, {})).toEqual({});
    expect(describeDial({})).toBe('websocket');
  });

  it('читает три поля конфига', () => {
    const dial = readRelayDial({ relayConnect: 'relay.example.com:9444', relayDisguise: 'rdp', relayTransport: 'ws' }, {});
    expect(dial).toEqual({ connect: 'relay.example.com:9444', disguise: 'rdp' });
    expect(describeDial(dial)).toBe('websocket, disguised as rdp, via relay.example.com:9444');
    expect(readRelayDial({ relayTransport: 'poll' }, {})).toEqual({ transport: 'poll' });
  });

  it('окружение старше конфига', () => {
    const dial = readRelayDial({ relayDisguise: 'ssh' }, { TERMHUB_RELAY_DISGUISE: 'dns', TERMHUB_RELAY_CONNECT: '127.0.0.1:19443' });
    expect(dial).toEqual({ connect: '127.0.0.1:19443', disguise: 'dns' });
  });

  it('чужие значения отбрасываются с предупреждением, запуск не ломают', () => {
    const warnings: string[] = [];
    const dial = readRelayDial(
      { relayConnect: 'no-port', relayDisguise: 'http', relayTransport: 'carrier-pigeon' },
      {},
      (m) => warnings.push(m),
    );
    expect(dial).toEqual({});
    expect(warnings).toHaveLength(3);
    expect(readRelayDial({ relayDisguise: 'none' }, {}, (m) => warnings.push(m))).toEqual({});
    expect(warnings).toHaveLength(3);
  });
});

describe('openRelaySocket на живом relay', () => {
  /** Регистрирует агента выбранным способом и возвращает выданный relay идентификатор. */
  async function registerVia(url: string, dial: RelayDial): Promise<string> {
    const ws = openRelaySocket(url, dial);
    closers.push(() => ws.terminate());
    ws.on('error', () => undefined);
    const inbox: string[] = [];
    const waiters: Array<(m: string) => void> = [];
    ws.on('message', (data: Buffer) => {
      const text = data.toString('utf8');
      const w = waiters.shift();
      if (w) w(text);
      else inbox.push(text);
    });
    const next = (): Promise<string> =>
      new Promise((resolve) => {
        const m = inbox.shift();
        if (m !== undefined) resolve(m);
        else waiters.push(resolve);
      });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send(JSON.stringify({ t: 'register', edPub: Buffer.from(identity.edPub).toString('base64') }));
    const challenge = JSON.parse(await next()) as { nonce: string };
    const sig = sign(identity.edSec, Buffer.from(challenge.nonce, 'base64'));
    ws.send(JSON.stringify({ t: 'prove', sig: Buffer.from(sig).toString('base64') }));
    return (JSON.parse(await next()) as { agentId: string }).agentId;
  }

  async function stand(): Promise<{ relayPort: number; disguisePort: number }> {
    const relay = await startRelay({ port: 0, silent: true });
    closers.push(() => relay.close());
    const proxy = await startDisguiseProxy({ port: 0, upstreamHost: '127.0.0.1', upstreamPort: relay.port });
    closers.push(() => proxy.close());
    return { relayPort: relay.port, disguisePort: proxy.port };
  }

  it.each(['ssh', 'rdp', 'dns'] as const)('маскировка %s через порт маскировки', async (disguise) => {
    const { disguisePort } = await stand();
    // адрес в relayUrl намеренно нерабочий: соединение обязано пойти на relayConnect
    const id = await registerVia('ws://relay.invalid:1/relay', { connect: `127.0.0.1:${disguisePort}`, disguise });
    expect(id).toBe(fingerprint(identity.edPub));
  });

  it('свой адрес без маскировки (туннель)', async () => {
    const { relayPort } = await stand();
    const id = await registerVia('ws://relay.invalid:1/relay', { connect: `127.0.0.1:${relayPort}` });
    expect(id).toBe(fingerprint(identity.edPub));
  });

  it('короткими запросами', async () => {
    const { relayPort } = await stand();
    const id = await registerVia(`ws://127.0.0.1:${relayPort}/relay`, { transport: 'poll' });
    expect(id).toBe(fingerprint(identity.edPub));
  });
});
