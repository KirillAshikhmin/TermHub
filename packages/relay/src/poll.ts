// Серверная сторона «сокета поверх коротких запросов» (см. protocol/pollsock.ts).
// PollConn повторяет ту часть интерфейса ws.WebSocket, которой пользуется relay, —
// поэтому регистрация агентов, комнаты и форвардинг о способе доставки не знают.
// Каждый ответ закрывает соединение: в сети, где фильтр душит поток после пары десятков
// пакетов, жить может только соединение на один запрос.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PollDecoder,
  POLL_BINARY,
  POLL_CLOSE,
  POLL_DOWN_CHUNK,
  POLL_HOLD_MS,
  POLL_TEXT,
  POLL_UP_CHUNK,
  decodePollClose,
  encodePollClose,
  encodePollMessage,
} from '@termhub/protocol';

/** Сессия без единого запроса дольше этого считается брошенной. */
const SESSION_IDLE_MS = 60_000;
/** Сколько выданных, но не подтверждённых кусков держим для повтора. */
const MAX_UNACKED = 64;
/** Сколько кусков вверх ждём вне очереди (клиент шлёт по одному, запас — на повторы). */
const MAX_UP_AHEAD = 8;
const SID_RE = /^[0-9a-f]{32}$/;

const OPEN = 1;
const CLOSED = 3;

interface Waiter {
  res: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
}

/** Одно логическое соединение. События как у ws: 'message'(Buffer, isBinary), 'close', 'pong'. */
export class PollConn extends EventEmitter {
  readyState = OPEN;
  readonly sid = crypto.randomBytes(16).toString('hex');
  lastSeen = Date.now();

  // вниз
  private queue: Buffer[] = [];
  private queued = 0;
  private readonly sent = new Map<number, Buffer>();
  private sentBytes = 0;
  private nextSlice = 0;
  private readonly waiters = new Map<number, Waiter>();
  // вверх
  private upNext = 0;
  private readonly upAhead = new Map<number, Buffer>();
  private readonly decoder: PollDecoder;

  constructor(
    maxMessage: number,
    private readonly onGone: (conn: PollConn) => void,
  ) {
    super();
    this.decoder = new PollDecoder(maxMessage);
  }

  /** Неотправленное и неподтверждённое — мера того, успевает ли получатель. */
  get bufferedAmount(): number {
    return this.queued + this.sentBytes;
  }

  send(data: string | Buffer | Uint8Array, _opts?: { binary?: boolean }): void {
    if (this.readyState !== OPEN) return;
    const frame =
      typeof data === 'string'
        ? encodePollMessage(POLL_TEXT, Buffer.from(data, 'utf8'))
        : encodePollMessage(POLL_BINARY, data);
    this.push(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
  }

  /** Живость меряется запросами: клиент, который тянет поток, жив. */
  ping(): void {
    if (this.readyState !== OPEN) return;
    if (this.waiters.size > 0 || Date.now() - this.lastSeen < SESSION_IDLE_MS) {
      setImmediate(() => this.emit('pong'));
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState !== OPEN) return;
    const frame = encodePollClose(code, reason);
    this.push(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    this.readyState = CLOSED;
    this.pump();
    // Клиенту даём время забрать хвост с сообщением закрытия, потом сессию забываем.
    const t = setTimeout(() => this.drop(), 5_000);
    if (typeof t.unref === 'function') t.unref();
    this.emit('close', code, Buffer.from(reason));
  }

  terminate(): void {
    const wasOpen = this.readyState === OPEN;
    this.readyState = CLOSED;
    this.drop();
    if (wasOpen) this.emit('close', 1006, Buffer.alloc(0));
  }

  private drop(): void {
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      end(w.res, 410);
    }
    this.waiters.clear();
    this.queue = [];
    this.queued = 0;
    this.sent.clear();
    this.sentBytes = 0;
    this.onGone(this);
  }

  // ── вниз ───────────────────────────────────────────────────────────────────

  private push(frame: Buffer): void {
    this.queue.push(frame);
    this.queued += frame.length;
    this.pump();
  }

  /** Раздаёт данные ждущим запросам строго по номерам: кусок режется в момент отправки,
   *  поэтому мелкие сообщения, пришедшие подряд, уезжают одним ответом. */
  private pump(): void {
    while (this.queued > 0 && this.sent.size < MAX_UNACKED) {
      const waiter = this.waiters.get(this.nextSlice);
      if (!waiter) return;
      this.waiters.delete(this.nextSlice);
      clearTimeout(waiter.timer);
      const slice = this.cut(POLL_DOWN_CHUNK);
      this.sent.set(this.nextSlice, slice);
      this.sentBytes += slice.length;
      this.nextSlice++;
      end(waiter.res, 200, slice);
    }
  }

  private cut(max: number): Buffer {
    const out = Buffer.allocUnsafe(Math.min(max, this.queued));
    let at = 0;
    while (at < out.length) {
      const head = this.queue[0];
      const n = Math.min(head.length, out.length - at);
      head.copy(out, at, 0, n);
      at += n;
      if (n === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(n);
    }
    this.queued -= out.length;
    return out;
  }

  handleDown(res: ServerResponse, seq: number, ack: number): void {
    this.lastSeen = Date.now();
    for (const [n, slice] of this.sent) {
      if (n < ack) {
        this.sent.delete(n);
        this.sentBytes -= slice.length;
      }
    }
    const again = this.sent.get(seq);
    if (again) return end(res, 200, again); // повтор запроса, чей ответ не доехал
    if (seq < this.nextSlice) return end(res, 410); // кусок уже подтверждён и забыт
    if (this.readyState !== OPEN && this.queued === 0) return end(res, 410);
    const previous = this.waiters.get(seq);
    if (previous) {
      clearTimeout(previous.timer);
      end(previous.res, 204);
    }
    const timer = setTimeout(() => {
      if (this.waiters.get(seq)?.res === res) this.waiters.delete(seq);
      end(res, 204);
    }, POLL_HOLD_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.waiters.set(seq, { res, timer });
    res.on('close', () => {
      const w = this.waiters.get(seq);
      if (w?.res === res) {
        clearTimeout(w.timer);
        this.waiters.delete(seq);
      }
    });
    this.pump();
  }

  // ── вверх ──────────────────────────────────────────────────────────────────

  handleUp(res: ServerResponse, seq: number, body: Buffer): void {
    this.lastSeen = Date.now();
    if (this.readyState !== OPEN) return end(res, 410);
    if (seq < this.upNext) return end(res, 200); // повтор уже принятого куска
    if (seq > this.upNext + MAX_UP_AHEAD) return end(res, 400);
    this.upAhead.set(seq, body);
    end(res, 200);
    for (;;) {
      const chunk = this.upAhead.get(this.upNext);
      if (!chunk) return;
      this.upAhead.delete(this.upNext);
      this.upNext++;
      let messages: Array<{ kind: number; body: Uint8Array }>;
      try {
        messages = this.decoder.push(chunk);
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
          this.readyState = CLOSED;
          this.drop();
          this.emit('close', code, Buffer.from(reason));
          return;
        }
      }
    }
  }
}

/** Реестр сессий и разбор запросов `<prefix>/open|down|up`. */
export class PollHub {
  private readonly conns = new Map<string, PollConn>();
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(
    private readonly prefix: string,
    private readonly maxMessage: number,
    /** Новое соединение: вернуть false — отказать (лимит по IP). */
    private readonly accept: (conn: PollConn, req: IncomingMessage) => boolean,
  ) {
    this.sweep = setInterval(() => {
      const now = Date.now();
      for (const conn of [...this.conns.values()]) {
        if (now - conn.lastSeen > SESSION_IDLE_MS) conn.terminate();
      }
    }, 15_000);
    if (typeof this.sweep.unref === 'function') this.sweep.unref();
  }

  close(): void {
    clearInterval(this.sweep);
    for (const conn of [...this.conns.values()]) conn.terminate();
  }

  /** true — запрос был наш и на него отвечено. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!url.pathname.startsWith(`${this.prefix}/`)) return false;
    const op = url.pathname.slice(this.prefix.length + 1);
    const method = req.method ?? 'GET';
    if (op === 'open' && method === 'POST') {
      req.resume();
      const conn = new PollConn(this.maxMessage, (c) => this.conns.delete(c.sid));
      if (!this.accept(conn, req)) {
        end(res, 429);
        return true;
      }
      this.conns.set(conn.sid, conn);
      end(res, 200, Buffer.from(JSON.stringify({ sid: conn.sid })), 'application/json; charset=utf-8');
      return true;
    }
    const sid = url.searchParams.get('sid') ?? '';
    const seq = Number(url.searchParams.get('seq'));
    const conn = SID_RE.test(sid) ? this.conns.get(sid) : undefined;
    if (op === 'down' && method === 'GET') {
      if (!conn) end(res, 410);
      else if (!Number.isSafeInteger(seq) || seq < 0) end(res, 400);
      else conn.handleDown(res, seq, Number(url.searchParams.get('ack')) || 0);
      return true;
    }
    if (op === 'up' && method === 'POST') {
      if (!conn) {
        req.resume();
        end(res, 410);
        return true;
      }
      if (!Number.isSafeInteger(seq) || seq < 0) {
        req.resume();
        end(res, 400);
        return true;
      }
      const parts: Buffer[] = [];
      let size = 0;
      req.on('data', (d: Buffer) => {
        size += d.length;
        if (size > POLL_UP_CHUNK * 4) {
          end(res, 413);
          req.destroy();
          return;
        }
        parts.push(d);
      });
      req.on('end', () => conn.handleUp(res, seq, Buffer.concat(parts)));
      req.on('error', () => undefined);
      return true;
    }
    req.resume();
    end(res, 404);
    return true;
  }
}

function end(res: ServerResponse, status: number, body?: Buffer, type = 'application/octet-stream'): void {
  if (res.writableEnded || res.destroyed) return;
  const headers: Record<string, string | number> = {
    Connection: 'close',
    'Cache-Control': 'no-store',
    'Content-Length': body ? body.length : 0,
  };
  if (body) headers['Content-Type'] = type;
  res.writeHead(status, headers);
  res.end(body);
}
