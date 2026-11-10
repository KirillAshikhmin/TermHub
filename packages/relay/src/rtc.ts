// Серверная сторона «сокета поверх WebRTC DataChannel» (см. protocol/rtcsock.ts).
// RtcConn, как и PollConn, повторяет интерфейс ws.WebSocket — relay о способе доставки
// не знает. Relay здесь — ICE-lite с известным адресом: сам никуда не ходит, отвечает на
// проверки клиента. Первым пакетом потока поэтому всегда оказывается STUN клиента — на
// этом и держится проход через фильтр, который душит остальные потоки.
// werift (WebRTC на TypeScript) грузится лениво: relay без этого режима его не трогает.

import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PollDecoder,
  POLL_BINARY,
  POLL_CLOSE,
  POLL_TEXT,
  RTC_CHUNK,
  decodePollClose,
  encodePollClose,
  encodePollMessage,
  stripCandidates,
} from '@termhub/protocol';

export interface RtcOptions {
  /** Диапазон UDP-портов (границы обязаны различаться): по порту на соединение. */
  portRange: [number, number];
  /** Внешний адрес relay, если он за NAT (Docker): подставляется в кандидаты ответа. */
  publicIp?: string;
}

/** Канал не открылся за это время — соединение бросаем, порт освобождаем. */
const CONNECT_TIMEOUT_MS = 15_000;
const GATHER_TIMEOUT_MS = 3_000;
const MAX_OFFER = 16 * 1024;

const OPEN = 1;
const CLOSED = 3;

interface ChannelLike {
  readyState: string;
  bufferedAmount: number;
  send(data: Buffer): void;
  close(): void;
  onMessage: { subscribe(fn: (data: string | Buffer) => void): unknown };
  stateChanged: { subscribe(fn: (state: string) => void): unknown };
}

interface PeerLike {
  iceGatheringState: string;
  connectionState: string;
  localDescription: { sdp: string } | null;
  onDataChannel: { subscribe(fn: (channel: ChannelLike) => void): unknown };
  iceGatheringStateChange: { subscribe(fn: (state: string) => void): unknown };
  connectionStateChange: { subscribe(fn: (state: string) => void): unknown };
  setRemoteDescription(d: { type: 'offer'; sdp: string }): Promise<unknown>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(d: unknown): Promise<unknown>;
  close(): Promise<unknown> | unknown;
}

/** Одно соединение. События как у ws: 'message'(Buffer, isBinary), 'close', 'pong'. */
export class RtcConn extends EventEmitter {
  readyState = OPEN;
  private readonly decoder: PollDecoder;

  constructor(
    private readonly pc: PeerLike,
    private readonly channel: ChannelLike,
    maxMessage: number,
  ) {
    super();
    this.decoder = new PollDecoder(maxMessage);
    channel.onMessage.subscribe((data) => this.onChunk(data));
    channel.stateChanged.subscribe((state) => {
      if (state === 'closed' || state === 'closing') this.gone(1006, '');
    });
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') this.gone(1006, '');
    });
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  send(data: string | Buffer | Uint8Array, _opts?: { binary?: boolean }): void {
    if (this.readyState !== OPEN) return;
    const frame =
      typeof data === 'string'
        ? encodePollMessage(POLL_TEXT, Buffer.from(data, 'utf8'))
        : encodePollMessage(POLL_BINARY, data);
    this.write(frame);
  }

  private write(frame: Uint8Array): void {
    const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    try {
      for (let at = 0; at < buf.length; at += RTC_CHUNK) this.channel.send(buf.subarray(at, at + RTC_CHUNK));
    } catch {
      this.gone(1006, '');
    }
  }

  ping(): void {
    if (this.readyState === OPEN && this.pc.connectionState === 'connected') setImmediate(() => this.emit('pong'));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState !== OPEN) return;
    this.write(encodePollClose(code, reason));
    // Сообщению закрытия нужно время уйти, прежде чем соединение будет разобрано.
    this.readyState = CLOSED;
    const t = setTimeout(() => this.dispose(), 1_000);
    if (typeof t.unref === 'function') t.unref();
    this.emit('close', code, Buffer.from(reason));
  }

  terminate(): void {
    this.gone(1006, '');
  }

  private gone(code: number, reason: string): void {
    const wasOpen = this.readyState === OPEN;
    this.readyState = CLOSED;
    this.dispose();
    if (wasOpen) this.emit('close', code, Buffer.from(reason));
  }

  private disposed = false;
  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.channel.close();
    } catch {
      /* уже закрыт */
    }
    void Promise.resolve(this.pc.close()).catch(() => undefined);
  }

  private onChunk(data: string | Buffer): void {
    if (this.readyState !== OPEN || typeof data === 'string') return;
    let messages: Array<{ kind: number; body: Uint8Array }>;
    try {
      messages = this.decoder.push(new Uint8Array(data));
    } catch {
      this.close(1009, 'message too big');
      return;
    }
    for (const m of messages) {
      if (this.readyState !== OPEN) return;
      const buf = Buffer.from(m.body.buffer, m.body.byteOffset, m.body.byteLength);
      if (m.kind === POLL_TEXT) this.emit('message', buf, false);
      else if (m.kind === POLL_BINARY) this.emit('message', buf, true);
      else if (m.kind === POLL_CLOSE) {
        const { code, reason } = decodePollClose(m.body);
        this.gone(code, reason);
        return;
      }
    }
  }
}

/** Подставляет внешний адрес в кандидаты ответа: за NAT relay видит только свой внутренний. */
export function advertise(sdp: string, publicIp: string | undefined): string {
  if (!publicIp) return sdp;
  return sdp
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('a=candidate:')) {
        const parts = line.split(' ');
        if (parts.length > 5 && parts[2].toLowerCase() === 'udp') parts[4] = publicIp;
        return parts.join(' ');
      }
      if (line.startsWith('c=IN IP4 ')) return `c=IN IP4 ${publicIp}`;
      return line;
    })
    .join('\r\n');
}

/** Сигнализация `POST <prefix>/rtc` и учёт соединений. */
export class RtcHub {
  private readonly peers = new Set<PeerLike>();
  private werift?: Promise<{ RTCPeerConnection: new (config: unknown) => PeerLike }>;

  constructor(
    private readonly prefix: string,
    private readonly maxMessage: number,
    private readonly opts: RtcOptions,
    /** Канал открылся: вернуть false — отказать (лимит по IP). */
    private readonly accept: (conn: RtcConn, req: IncomingMessage) => boolean,
    /** Допуск до разбора предложения: лимит новых соединений с адреса. */
    private readonly allow: (req: IncomingMessage) => boolean,
  ) {}

  close(): void {
    for (const pc of [...this.peers]) void Promise.resolve(pc.close()).catch(() => undefined);
    this.peers.clear();
  }

  /** true — запрос был наш и на него отвечено (или будет отвечено). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (url.pathname !== `${this.prefix}/rtc`) return false;
    if (req.method !== 'POST') {
      req.resume();
      reply(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (!this.allow(req)) {
      req.resume();
      reply(res, 429, { error: 'too many requests' });
      return true;
    }
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_OFFER) {
        reply(res, 413, { error: 'too large' });
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on('error', () => undefined);
    req.on('end', () => {
      let sdp: unknown;
      try {
        sdp = (JSON.parse(Buffer.concat(parts).toString('utf8')) as { sdp?: unknown }).sdp;
      } catch {
        sdp = undefined;
      }
      if (typeof sdp !== 'string' || sdp.length === 0) return reply(res, 400, { error: 'bad offer' });
      this.answer(sdp, req).then(
        (answer) => reply(res, 200, { sdp: answer }),
        () => reply(res, 500, { error: 'rtc failed' }),
      );
    });
    return true;
  }

  private async answer(offer: string, req: IncomingMessage): Promise<string> {
    this.werift ??= import('werift') as unknown as Promise<{ RTCPeerConnection: new (config: unknown) => PeerLike }>;
    const { RTCPeerConnection } = await this.werift;
    const pc = new RTCPeerConnection({
      iceServers: [],
      iceUseDefaultStunServer: false,
      iceLite: true,
      icePortRange: this.opts.portRange,
      iceUseIpv6: false,
      iceUseTcp: false,
    });
    this.peers.add(pc);
    const drop = (): void => {
      if (!this.peers.delete(pc)) return;
      void Promise.resolve(pc.close()).catch(() => undefined);
    };
    let opened = false;
    const timer = setTimeout(() => {
      if (!opened) drop();
    }, CONNECT_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed') {
        clearTimeout(timer);
        this.peers.delete(pc);
      }
    });
    pc.onDataChannel.subscribe((channel) => {
      const start = (): void => {
        if (opened) return;
        opened = true;
        clearTimeout(timer);
        const conn = new RtcConn(pc, channel, this.maxMessage);
        if (!this.accept(conn, req)) conn.terminate();
      };
      if (channel.readyState === 'open') start();
      else channel.stateChanged.subscribe((state) => state === 'open' && start());
    });
    try {
      // Кандидаты клиента не нужны: он сам придёт проверками на наш адрес.
      await pc.setRemoteDescription({ type: 'offer', sdp: stripCandidates(offer) });
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, GATHER_TIMEOUT_MS);
          pc.iceGatheringStateChange.subscribe((state) => {
            if (state === 'complete') {
              clearTimeout(t);
              resolve();
            }
          });
        });
      }
      const local = pc.localDescription?.sdp;
      if (!local) throw new Error('no local description');
      return advertise(local, this.opts.publicIp);
    } catch (err) {
      clearTimeout(timer);
      drop();
      throw err;
    }
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(data);
}
