import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  LocalRelay,
  readLocalRelay,
  localRelayUrl,
  localRelayEnv,
  sharePairing,
} from '../src/local-relay.js';
import type { AuthorizedDevice } from '../src/config.js';

const TLS = { cert: '/c.pem', key: '/k.pem' };

describe('readLocalRelay', () => {
  it('нет поля — своего relay нет', () => {
    expect(readLocalRelay({ port: 7710, tls: null })).toBeNull();
  });

  it('сертификат по умолчанию — агента, адрес — все интерфейсы', () => {
    expect(readLocalRelay({ port: 7710, tls: TLS, localRelay: { port: 7720 } })).toEqual({
      port: 7720,
      host: '0.0.0.0',
      tls: TLS,
    });
  });

  it('tls: null выключает TLS, свой сертификат старше агентского', () => {
    expect(readLocalRelay({ port: 7710, tls: TLS, localRelay: { port: 7720, tls: null } })?.tls).toBeNull();
    const own = { cert: '/a', key: '/b' };
    expect(readLocalRelay({ port: 7710, tls: TLS, localRelay: { port: 7720, tls: own } })?.tls).toEqual(own);
  });

  it('requireHttps: без сертификата relay не поднимается, с ним — флаг едет в окружение', () => {
    const log = vi.fn();
    expect(readLocalRelay({ port: 7710, tls: null, localRelay: { port: 7720, requireHttps: true } }, log)).toBeNull();
    expect(readLocalRelay({ port: 7710, tls: TLS, localRelay: { port: 7720, tls: null, requireHttps: true } }, log)).toBeNull();
    expect(log).toHaveBeenCalledTimes(2);
    const cfg = readLocalRelay({ port: 7710, tls: TLS, localRelay: { port: 7720, requireHttps: true } });
    expect(cfg?.requireHttps).toBe(true);
    expect(localRelayEnv(cfg!, {}).RELAY_REQUIRE_HTTPS).toBe('1');
    expect(localRelayEnv({ port: 7720, host: '0.0.0.0', tls: TLS }, { RELAY_REQUIRE_HTTPS: '1' }).RELAY_REQUIRE_HTTPS).toBeUndefined();
  });

  it('битое значение relay не поднимает и говорит об этом', () => {
    const log = vi.fn();
    const bad = [{ port: 0 }, { port: '80' }, { port: 7710 }, { port: 7720, tls: { cert: 1 } }, 'on'];
    for (const localRelay of bad) {
      expect(readLocalRelay({ port: 7710, tls: null, localRelay: localRelay as never }, log)).toBeNull();
    }
    expect(log).toHaveBeenCalledTimes(bad.length);
  });
});

describe('адрес и окружение', () => {
  it('агент ходит к своему relay по loopback', () => {
    expect(localRelayUrl({ port: 7720, host: '0.0.0.0', tls: TLS })).toBe('wss://127.0.0.1:7720/relay');
    expect(localRelayUrl({ port: 80, host: '192.168.0.5', tls: null })).toBe('ws://192.168.0.5:80/relay');
    expect(localRelayUrl({ port: 80, host: '::1', tls: null })).toBe('ws://[::1]:80/relay');
  });

  it('окружение: порт, адрес и сертификат — свои; доверие прокси снято', () => {
    const env = localRelayEnv(
      { port: 7720, host: '0.0.0.0', tls: TLS },
      { PORT: '1', RELAY_TRUST_PROXY: '1', STATIC_DIR: '/x', RELAY_CHUNKED: '1' },
    );
    expect(env).toMatchObject({ PORT: '7720', HOST: '0.0.0.0', TLS_CERT: '/c.pem', TLS_KEY: '/k.pem', RELAY_CHUNKED: '1' });
    expect(env.RELAY_TRUST_PROXY).toBeUndefined();
    expect(env.STATIC_DIR).toBeUndefined();
    const plain = localRelayEnv({ port: 7720, host: '0.0.0.0', tls: null }, { TLS_CERT: '/old', TLS_KEY: '/old' });
    expect(plain.TLS_CERT).toBeUndefined();
  });
});

describe('LocalRelay', () => {
  afterEach(() => vi.useRealTimers());

  function fakeChild(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
    return Object.assign(new EventEmitter(), { kill: vi.fn() });
  }

  it('перезапускает упавший процесс с растущей паузой и гасит его при остановке', () => {
    vi.useFakeTimers();
    const children: Array<ReturnType<typeof fakeChild>> = [];
    const relay = new LocalRelay(
      { port: 7720, host: '0.0.0.0', tls: null },
      {
        spawn: () => {
          const c = fakeChild();
          children.push(c);
          return c as never;
        },
        log: () => {},
      },
    );
    relay.start();
    expect(children).toHaveLength(1);
    expect(relay.running).toBe(true);

    children[0].emit('exit', 1, null);
    expect(relay.running).toBe(false);
    vi.advanceTimersByTime(999);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(2);

    children[1].emit('exit', 1, null);
    vi.advanceTimersByTime(1999);
    expect(children).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(3);

    relay.stop();
    expect(children[2].kill).toHaveBeenCalled();
    children[2].emit('exit', null, 'SIGTERM');
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(3);
  });

  it('не запустился — агент жив, попытка повторяется', () => {
    vi.useFakeTimers();
    let calls = 0;
    const relay = new LocalRelay(
      { port: 7720, host: '0.0.0.0', tls: null },
      {
        spawn: () => {
          calls++;
          throw new Error('no relay build');
        },
        log: () => {},
      },
    );
    expect(() => relay.start()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(2);
    relay.stop();
  });
});

describe('sharePairing', () => {
  function link(opts: { fail?: boolean; delay?: number } = {}) {
    let finish!: (d: AuthorizedDevice) => void;
    const done = new Promise<AuthorizedDevice>((r) => (finish = r));
    const l = {
      preset: undefined as { code: string } | undefined,
      cancelled: '' as string,
      finish,
      async openPairing(_scope: unknown, preset?: { code: string; roomId: string; secret: string }) {
        l.preset = preset;
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
        if (opts.fail) throw new Error('relay unreachable');
        return { code: preset?.code ?? 'own-code', expiresAt: 1, done };
      },
      cancelPairing(reason: string) {
        l.cancelled = reason;
      },
    };
    return l;
  }

  it('один relay — код генерит сам мост', async () => {
    const a = link();
    expect((await sharePairing([a])).code).toBe('own-code');
    expect(a.preset).toBeUndefined();
  });

  it('один код на оба relay; недоступный relay выдачу не срывает', async () => {
    const a = link({ fail: true });
    const b = link();
    const res = await sharePairing([a, b]);
    expect(res.code).toBe(b.preset?.code);
    expect(a.preset?.code).toBe(res.code);
  });

  it('оба недоступны — отказ с причиной', async () => {
    await expect(sharePairing([link({ fail: true }), link({ fail: true })])).rejects.toThrow('relay unreachable');
  });

  it('код одноразовый: спарились на одном relay — на другом он снят', async () => {
    const a = link();
    const b = link();
    await sharePairing([a, b]);
    b.finish({ name: 'phone', edPub: '', fingerprint: 'fp', addedAt: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(a.cancelled).toBe('Pairing code already used');
    expect(b.cancelled).toBe('');
  });
});
