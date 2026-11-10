// Порт маскировки: клиент (агент, CLI) первым пакетом шлёт преамбулу «разрешённого»
// протокола (SSH, RDP, DNS — см. protocol/disguise.ts), фильтр на пути пропускает такое
// соединение без лимита, а здесь преамбула срезается и остаток потока уходит как есть
// на обычный вход relay (или на TLS-прокси перед ним). Содержимое не разбирается.

import net from 'node:net';
import { prefaceLength } from '@termhub/protocol';

/** Сколько ждём преамбулу: дольше — это не наш клиент. */
const PREFACE_TIMEOUT_MS = 5_000;
/** Преамбула не бывает длиннее: больше буферизовать незачем. */
const PREFACE_MAX = 8 * 1024;

export interface DisguiseProxyOpts {
  port: number;
  upstreamHost: string;
  upstreamPort: number;
}

export interface DisguiseProxyHandle {
  port: number;
  close(): Promise<void>;
}

export function startDisguiseProxy(opts: DisguiseProxyOpts): Promise<DisguiseProxyHandle> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    client.setNoDelay(true);
    let head: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), PREFACE_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      let len: number | null;
      try {
        len = prefaceLength(head);
      } catch {
        client.destroy();
        return;
      }
      if (len === null) {
        if (head.length > PREFACE_MAX) client.destroy();
        return;
      }
      clearTimeout(timer);
      client.off('data', onData);
      client.pause();
      const rest = head.subarray(len);
      const upstream = net.connect(opts.upstreamPort, opts.upstreamHost);
      sockets.add(upstream);
      upstream.setNoDelay(true);
      upstream.on('close', () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('connect', () => {
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on('data', onData);
    client.on('close', () => clearTimeout(timer));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : opts.port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
