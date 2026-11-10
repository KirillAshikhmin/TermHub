// «Сокет поверх коротких запросов» — замена WebSocket для сетей, где фильтр душит
// каждое TCP-соединение после пары десятков пакетов. Долгого потока нет вовсе: каждое
// сообщение едет своим коротким HTTP-запросом на свежем соединении (сервер закрывает
// его после ответа), и лимит потока не успевает сработать.
//
// Провод (base — тот же адрес, что у WebSocket, со схемой http/https):
//   POST base/open               → {sid}
//   GET  base/down?sid&seq&ack   → 200 кусок потока вниз | 204 «пока пусто» | 410 сессии нет
//   POST base/up?sid&seq         → 200 (тело — кусок потока вверх)
// Оба потока — байтовые, сообщения в них: [вид:1][длина:u32 BE][тело], вид 1 — текст,
// 2 — бинарь, 3 — закрытие ([код:u16][причина utf-8]). Куски нумеруются: вниз клиент
// тянет несколько номеров разом и склеивает по порядку, вверх шлёт строго по одному.
// Модуль без зависимостей от платформы: нужен только fetch (браузер и Node ≥ 22).

/** Кусок потока вниз: с запасом ниже лимита потока (~25 пакетов сервера вместе с TLS). */
export const POLL_DOWN_CHUNK = 8 * 1024;
/** Кусок потока вверх: сервер тратит пакеты только на подтверждения, запас больше. */
export const POLL_UP_CHUNK = 16 * 1024;
/** Сколько сервер держит запрос без данных, прежде чем ответить «пусто». */
export const POLL_HOLD_MS = 20_000;

export const POLL_TEXT = 1;
export const POLL_BINARY = 2;
export const POLL_CLOSE = 3;

const HEADER = 5;
/** Клиент сдаётся на запросе позже, чем сервер отпустит его сам: зависший (задушенный)
 *  поток не рвётся, а молчит, и без своего срока запрос висел бы вечно. */
const REQUEST_TIMEOUT_MS = POLL_HOLD_MS + 8_000;
const OPEN_TIMEOUT_MS = 10_000;
const UP_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 4;
const DOWN_WINDOW = 3;

/** Кодирует одно сообщение потока. */
export function encodePollMessage(kind: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + body.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, HEADER);
  return out;
}

/** Тело сообщения закрытия. */
export function encodePollClose(code: number, reason: string): Uint8Array {
  const text = new TextEncoder().encode(reason).subarray(0, 120);
  const body = new Uint8Array(2 + text.length);
  new DataView(body.buffer).setUint16(0, code);
  body.set(text, 2);
  return encodePollMessage(POLL_CLOSE, body);
}

export function decodePollClose(body: Uint8Array): { code: number; reason: string } {
  if (body.length < 2) return { code: 1005, reason: '' };
  const code = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint16(0);
  return { code, reason: new TextDecoder().decode(body.subarray(2)) };
}

/** Собирает сообщения из кусков потока. Экземпляр один на направление. */
export class PollDecoder {
  private parts: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly maxMessage: number) {}

  /** Добавляет кусок и возвращает сообщения, которые им завершились.
   *  Бросает, если сообщение больше предела: дальше поток разбирать нельзя. */
  push(chunk: Uint8Array): Array<{ kind: number; body: Uint8Array }> {
    if (chunk.length > 0) {
      this.parts.push(chunk);
      this.size += chunk.length;
    }
    const out: Array<{ kind: number; body: Uint8Array }> = [];
    for (;;) {
      if (this.size < HEADER) break;
      const head = this.peek(HEADER);
      const len = new DataView(head.buffer, head.byteOffset, HEADER).getUint32(1);
      if (len > this.maxMessage) throw new Error('poll message too large');
      if (this.size < HEADER + len) break;
      const whole = this.take(HEADER + len);
      out.push({ kind: whole[0], body: whole.subarray(HEADER) });
    }
    return out;
  }

  private peek(n: number): Uint8Array {
    if (this.parts[0].length >= n) return this.parts[0];
    this.parts = [join(this.parts, this.size)];
    return this.parts[0];
  }

  private take(n: number): Uint8Array {
    if (this.parts.length > 1) this.parts = [join(this.parts, this.size)];
    const all = this.parts[0];
    const head = all.subarray(0, n);
    this.size -= n;
    this.parts = this.size > 0 ? [all.subarray(n)] : [];
    return head;
  }
}

function join(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** http(s)-основа запросов из адреса WebSocket: `wss://host/relay` → `https://host/relay`. */
export function pollBase(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):/i, 'http$1:').replace(/\/+$/, '');
}

export interface PollSocketOpts {
  /** Подмена fetch (тесты; у агента — запросы через свой способ соединения). */
  fetch?: typeof fetch;
  /** Предел одного сообщения вниз. */
  maxMessage?: number;
}

type Listener<T> = ((ev: T) => void) | null;

/** Клиентская сторона: повторяет ту часть интерфейса WebSocket, которой пользуются
 *  транспорты (readyState, send, close, on*-обработчики, бинарь — ArrayBuffer). */
export class PollSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = PollSocket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: Listener<unknown> = null;
  onmessage: Listener<{ data: string | ArrayBuffer }> = null;
  onclose: Listener<{ code: number; reason: string }> = null;
  onerror: Listener<unknown> = null;

  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly decoder: PollDecoder;
  private sid = '';
  // вниз
  private nextSeq = 0;
  private delivered = 0;
  private readonly got = new Map<number, Uint8Array>();
  // вверх
  private upQueue: Uint8Array[] = [];
  private upBytes = 0;
  private upSeq = 0;
  private upBusy = false;
  private readonly aborts = new Set<AbortController>();

  constructor(url: string, opts: PollSocketOpts = {}) {
    this.base = pollBase(url);
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.decoder = new PollDecoder(opts.maxMessage ?? 16 * 1024 * 1024);
    void this.open();
  }

  get bufferedAmount(): number {
    return this.upBytes;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== PollSocket.OPEN) return;
    const frame =
      typeof data === 'string'
        ? encodePollMessage(POLL_TEXT, new TextEncoder().encode(data))
        : encodePollMessage(POLL_BINARY, toBytes(data));
    this.enqueue(frame);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === PollSocket.CLOSED || this.readyState === PollSocket.CLOSING) return;
    if (this.readyState === PollSocket.OPEN) {
      // Закрытие едет тем же потоком вверх — сервер узнаёт о нём по порядку, после данных.
      this.enqueue(encodePollClose(code, reason));
      this.readyState = PollSocket.CLOSING;
      setTimeout(() => this.finish(code, reason), 1500);
      return;
    }
    this.finish(code, reason);
  }

  // ── открытие ───────────────────────────────────────────────────────────────

  private async open(): Promise<void> {
    try {
      const res = await this.request(`${this.base}/open`, { method: 'POST' }, OPEN_TIMEOUT_MS);
      if (!res.ok) throw new Error(`open ${res.status}`);
      const body = (await res.json()) as { sid?: unknown };
      if (typeof body.sid !== 'string' || body.sid.length === 0) throw new Error('open: no sid');
      this.sid = body.sid;
    } catch {
      this.fail();
      return;
    }
    if (this.readyState !== PollSocket.CONNECTING) return;
    this.readyState = PollSocket.OPEN;
    this.onopen?.({});
    for (let i = 0; i < DOWN_WINDOW; i++) void this.pull();
  }

  // ── вниз ───────────────────────────────────────────────────────────────────

  private async pull(): Promise<void> {
    while (this.alive()) {
      const seq = this.nextSeq++;
      const chunk = await this.fetchChunk(seq);
      if (!chunk) return;
      this.got.set(seq, chunk);
      this.drain();
    }
  }

  /** Тянет кусок `seq`, повторяя тот же номер на «пусто» и на сбое сети. */
  private async fetchChunk(seq: number): Promise<Uint8Array | null> {
    let failures = 0;
    while (this.alive()) {
      try {
        const url = `${this.base}/down?sid=${this.sid}&seq=${seq}&ack=${this.delivered}`;
        const res = await this.request(url, { method: 'GET', cache: 'no-store' }, REQUEST_TIMEOUT_MS);
        if (res.status === 204) {
          failures = 0;
          continue;
        }
        if (res.status === 410 || res.status === 404) {
          this.finish(1006, 'session gone');
          return null;
        }
        if (!res.ok) throw new Error(`down ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        if (!this.alive()) return null;
        if (++failures > MAX_RETRIES) {
          this.fail();
          return null;
        }
        await sleep(300 * failures);
      }
    }
    return null;
  }

  private drain(): void {
    for (;;) {
      const chunk = this.got.get(this.delivered);
      if (!chunk) return;
      this.got.delete(this.delivered);
      this.delivered++;
      let messages: Array<{ kind: number; body: Uint8Array }>;
      try {
        messages = this.decoder.push(chunk);
      } catch {
        this.fail();
        return;
      }
      for (const m of messages) {
        if (!this.alive()) return;
        if (m.kind === POLL_TEXT) this.onmessage?.({ data: new TextDecoder().decode(m.body) });
        else if (m.kind === POLL_BINARY) this.onmessage?.({ data: copyBuffer(m.body) });
        else if (m.kind === POLL_CLOSE) {
          const { code, reason } = decodePollClose(m.body);
          this.finish(code, reason);
          return;
        }
      }
    }
  }

  // ── вверх ──────────────────────────────────────────────────────────────────

  private enqueue(frame: Uint8Array): void {
    this.upQueue.push(frame);
    this.upBytes += frame.length;
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.upBusy) return;
    this.upBusy = true;
    try {
      while (this.upBytes > 0 && this.readyState !== PollSocket.CLOSED) {
        const body = this.cut(POLL_UP_CHUNK);
        const seq = this.upSeq++;
        let failures = 0;
        for (;;) {
          try {
            const res = await this.request(
              `${this.base}/up?sid=${this.sid}&seq=${seq}`,
              { method: 'POST', body: body as unknown as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } },
              UP_TIMEOUT_MS,
            );
            if (res.status === 410 || res.status === 404) {
              this.finish(1006, 'session gone');
              return;
            }
            if (!res.ok) throw new Error(`up ${res.status}`);
            break;
          } catch {
            if (this.readyState === PollSocket.CLOSED) return;
            if (++failures > MAX_RETRIES) {
              this.fail();
              return;
            }
            await sleep(300 * failures);
          }
        }
      }
    } finally {
      this.upBusy = false;
    }
  }

  private cut(max: number): Uint8Array {
    const out = new Uint8Array(Math.min(max, this.upBytes));
    let at = 0;
    while (at < out.length) {
      const head = this.upQueue[0];
      const n = Math.min(head.length, out.length - at);
      out.set(head.subarray(0, n), at);
      at += n;
      if (n === head.length) this.upQueue.shift();
      else this.upQueue[0] = head.subarray(n);
    }
    this.upBytes -= out.length;
    return out;
  }

  // ── общее ──────────────────────────────────────────────────────────────────

  private alive(): boolean {
    return this.readyState === PollSocket.OPEN || this.readyState === PollSocket.CLOSING;
  }

  private async request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const abort = new AbortController();
    this.aborts.add(abort);
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      return await this.doFetch(url, { ...init, signal: abort.signal });
    } finally {
      clearTimeout(timer);
      this.aborts.delete(abort);
    }
  }

  private fail(): void {
    if (this.readyState === PollSocket.CLOSED) return;
    this.onerror?.({});
    this.finish(1006, '');
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === PollSocket.CLOSED) return;
    this.readyState = PollSocket.CLOSED;
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
    this.upQueue = [];
    this.upBytes = 0;
    this.got.clear();
    this.onclose?.({ code, reason });
  }
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
